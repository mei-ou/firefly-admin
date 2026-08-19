import { z } from "zod";
import { ApiError } from "../../core/http/errors";
import {
	ARTICLE_ASSET_ATTACHMENT_MAX_BYTES,
	ARTICLE_ASSET_IMAGE_MAX_BYTES,
	ARTICLE_ASSET_MAX_COUNT,
	ARTICLE_ASSET_TOTAL_MAX_BYTES,
	MEDIA_STAGING_OBJECT_KEY_PATTERN,
} from "./media-config";

const ASSET_ID_PATTERN = /^[a-f0-9-]{16,64}$/i;
const MAX_ORIGINAL_FILENAME_LENGTH = 255;

const stagedArticleAssetSchema = z
	.object({
		version: z.literal(1),
		assetId: z.string().regex(ASSET_ID_PATTERN),
		objectKey: z.string().regex(MEDIA_STAGING_OBJECT_KEY_PATTERN),
		etag: z.string().min(1).max(500),
		originalFilename: z.string().min(1).max(MAX_ORIGINAL_FILENAME_LENGTH),
		contentType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"]),
		size: z.number().int().positive().max(ARTICLE_ASSET_ATTACHMENT_MAX_BYTES),
		role: z.enum(["attachment", "cover", "inline"]),
	})
	.strict();

const stagedArticleAssetManifestSchema = z
	.object({
		version: z.literal(1),
		assets: z.array(stagedArticleAssetSchema).max(ARTICLE_ASSET_MAX_COUNT),
	})
	.strict();

export type StagedArticleAsset = z.infer<typeof stagedArticleAssetSchema>;
export type StagedArticleAssetManifest = z.infer<typeof stagedArticleAssetManifestSchema>;

/**
 * 客户端清单只承担对象选择和用途声明，不携带最终文件名、仓库路径或相对引用。服务端会
 * 从 R2 可信元数据重新计算这些值，并在读取实际字节后再次核对全部限制。
 */
export function parseStagedArticleAssetManifest(input: unknown): StagedArticleAssetManifest {
	const result = stagedArticleAssetManifestSchema.safeParse(input);
	if (!result.success) {
		throw new ApiError(400, "INVALID_REQUEST", "文章资源清单无效。");
	}

	const objectKeys = new Set<string>();
	const assetIds = new Set<string>();
	let coverCount = 0;
	let totalBytes = 0;
	for (const asset of result.data.assets) {
		if (objectKeys.has(asset.objectKey) || assetIds.has(asset.assetId)) {
			throw new ApiError(400, "INVALID_REQUEST", "文章资源清单包含重复对象。");
		}
		objectKeys.add(asset.objectKey);
		assetIds.add(asset.assetId);
		const isImage = asset.contentType.startsWith("image/");
		if (!isImage && asset.role !== "attachment") {
			throw new ApiError(400, "INVALID_REQUEST", "附件不能作为文章图片使用。");
		}
		if (asset.role === "cover") {
			coverCount += 1;
			if (coverCount > 1) {
				throw new ApiError(400, "INVALID_REQUEST", "每篇文章最多只能有一个封面资源。");
			}
		}
		if (isImage && asset.size > ARTICLE_ASSET_IMAGE_MAX_BYTES) {
			throw new ApiError(413, "INVALID_REQUEST", "单张图片不能超过 1 MiB。");
		}
		totalBytes += asset.size;
	}
	if (totalBytes > ARTICLE_ASSET_TOTAL_MAX_BYTES) {
		throw new ApiError(413, "INVALID_REQUEST", "单次文章资源总量不能超过 5 MiB。");
	}

	// 规范顺序进入幂等 Hash，避免相同资源集合仅因浏览器列表顺序变化而形成不同请求。
	return {
		version: 1,
		assets: [...result.data.assets].sort((left, right) =>
			left.objectKey.localeCompare(right.objectKey),
		),
	};
}
