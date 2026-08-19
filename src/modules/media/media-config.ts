// Free Worker 候选限制必须集中维护，并在真实远端 CPU/内存验证后才能视为最终值。
export const ARTICLE_ASSET_MAX_COUNT = 5;
export const ARTICLE_ASSET_IMAGE_MAX_BYTES = 1 * 1024 * 1024;
export const ARTICLE_ASSET_ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;
export const ARTICLE_ASSET_TOTAL_MAX_BYTES = 5 * 1024 * 1024;
// 跨文章事务必须扫描完整受控文章集合；任一预算不足都失败关闭，不能把截断误判为无引用。
export const MEDIA_TRANSACTION_ARTICLE_MAX_COUNT = 50;
export const MEDIA_TRANSACTION_ARTICLE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
export const MEDIA_TRANSACTION_ARTICLE_READ_CONCURRENCY = 3;
// 兼容接口仍走 Contents API；新编辑器不得调用它，且不能随原子链路一起放宽。
export const MEDIA_REPOSITORY_MAX_BYTES = 1024 * 1024;
export const MEDIA_STAGING_MAX_BYTES = ARTICLE_ASSET_ATTACHMENT_MAX_BYTES;
export const MEDIA_STAGING_PREFIX = "staging";
export const MEDIA_STAGING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const MEDIA_STAGING_CLEANUP_BATCH_SIZE = 100;

export const MEDIA_STAGING_MIME_EXTENSIONS = {
	"application/pdf": "pdf",
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
} as const;

export const MEDIA_STAGING_OBJECT_KEY_PATTERN =
	/^staging\/\d{4}\/\d{2}\/([a-f0-9-]{16,64})\.(jpg|pdf|png|webp)$/i;

export type MediaStagingContentType = keyof typeof MEDIA_STAGING_MIME_EXTENSIONS;
export type ArticleAssetRole = "attachment" | "cover" | "inline";

const SAFE_FILENAME_CHARACTER = /^[a-z0-9-]$/u;
const MAX_FILENAME_STEM_LENGTH = 70;

function normalizeArticleAssetFilenameStem(originalFilename: string): string {
	const withoutExtension = originalFilename.replace(/\.[^.]+$/u, "");
	let stem = "";
	let lastWasSeparator = false;
	for (const character of withoutExtension.normalize("NFKD").toLowerCase()) {
		if (SAFE_FILENAME_CHARACTER.test(character)) {
			stem += character;
			lastWasSeparator = false;
		} else if (!lastWasSeparator && stem.length > 0) {
			stem += "-";
			lastWasSeparator = true;
		}
		if (stem.length >= MAX_FILENAME_STEM_LENGTH) break;
	}
	return stem.replace(/-+$/u, "") || "asset";
}

/**
 * R2 对象键由服务端生成，上传响应中的 filename 也是服务端清洗值。浏览器可用这三个字段
 * 预计算引用，但最终 Commit 前仍必须从 R2 元数据重算并核对，不能信任客户端结果。
 */
export function deriveStagedArticleAssetPath(input: {
	assetId: string;
	objectKey: string;
	originalFilename: string;
}): { finalFilename: string; relativePath: string } {
	const match = MEDIA_STAGING_OBJECT_KEY_PATTERN.exec(input.objectKey);
	if (!match?.[1] || !match[2] || match[1].toLowerCase() !== input.assetId.toLowerCase()) {
		throw new TypeError("暂存资源标识无效。");
	}
	const shortId = match[1].toLowerCase().replaceAll("-", "").slice(0, 12);
	const extension = match[2].toLowerCase();
	const finalFilename = `${normalizeArticleAssetFilenameStem(input.originalFilename)}-${shortId}.${extension}`;
	return { finalFilename, relativePath: `./${finalFilename}` };
}

export function isMediaStagingContentType(value: string): value is MediaStagingContentType {
	return Object.hasOwn(MEDIA_STAGING_MIME_EXTENSIONS, value);
}

/**
 * 上传边界要求原始文件名只含一个扩展名，并与声明 MIME 精确匹配。最终仓库名虽由服务端
 * 重建，仍要先拒绝 `report.pdf.exe`、错误扩展和无扩展名，避免伪装文件进入 R2 暂存区。
 */
export function isMediaFilenameCompatible(
	filename: string,
	contentType: MediaStagingContentType,
): boolean {
	const normalized = filename.normalize("NFKC").trim();
	if (normalized !== filename.trim() || normalized.startsWith(".") || normalized.includes("%")) {
		return false;
	}
	const segments = normalized.split(".");
	if (segments.length !== 2 || !segments[0] || !segments[1]) return false;
	const extension = segments[1].toLowerCase();
	if (contentType === "image/jpeg") return extension === "jpg" || extension === "jpeg";
	return extension === MEDIA_STAGING_MIME_EXTENSIONS[contentType];
}

export function isImageContentType(
	value: MediaStagingContentType,
): value is Extract<MediaStagingContentType, `image/${string}`> {
	return value.startsWith("image/");
}

export function isArticleAssetImageFilename(filename: string): boolean {
	const separator = filename.lastIndexOf(".");
	if (separator <= 0) return false;
	const extension = filename.slice(separator + 1).toLowerCase();
	return (
		extension === "gif" ||
		extension === "jpg" ||
		extension === "jpeg" ||
		extension === "png" ||
		extension === "webp"
	);
}

export function getMediaMaxBytes(contentType: MediaStagingContentType): number {
	return isImageContentType(contentType)
		? ARTICLE_ASSET_IMAGE_MAX_BYTES
		: ARTICLE_ASSET_ATTACHMENT_MAX_BYTES;
}

export function isMediaRoleCompatible(
	contentType: MediaStagingContentType,
	role: ArticleAssetRole,
): boolean {
	return role === "attachment" || isImageContentType(contentType);
}

/**
 * 文件扩展名和声明 MIME 都不可信，上传及最终 Commit 前都要重新验证最小 magic bytes。
 * 阶段 C 先维持 PDF 小白名单；压缩包可递归携带危险内容，未完成专门审计前失败关闭。
 */
export function matchesMediaSignature(
	bytes: Uint8Array,
	contentType: MediaStagingContentType,
): boolean {
	const startsWith = (...signature: number[]) =>
		signature.every((byte, index) => bytes[index] === byte);
	if (contentType === "image/jpeg") return startsWith(0xff, 0xd8, 0xff);
	if (contentType === "image/png") {
		return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
	}
	if (contentType === "image/webp") {
		return (
			startsWith(0x52, 0x49, 0x46, 0x46) &&
			bytes[8] === 0x57 &&
			bytes[9] === 0x45 &&
			bytes[10] === 0x42 &&
			bytes[11] === 0x50
		);
	}
	return contentType === "application/pdf" && startsWith(0x25, 0x50, 0x44, 0x46, 0x2d);
}
