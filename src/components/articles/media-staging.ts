import { z } from "zod";
import {
	ARTICLE_ASSET_ATTACHMENT_MAX_BYTES,
	ARTICLE_ASSET_IMAGE_MAX_BYTES,
	isMediaFilenameCompatible,
	isMediaStagingContentType,
	MEDIA_STAGING_OBJECT_KEY_PATTERN,
} from "../../modules/media/media-config";

const stagedMediaAssetSchema = z
	.object({
		id: z.string().regex(/^[a-f0-9-]{16,64}$/i),
		objectKey: z.string().regex(MEDIA_STAGING_OBJECT_KEY_PATTERN),
		filename: z.string().min(1).max(255),
		contentType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"]),
		size: z.number().int().positive().max(ARTICLE_ASSET_ATTACHMENT_MAX_BYTES),
		etag: z.string().min(1).max(500),
		uploadedAt: z.iso.datetime({ offset: true }),
	})
	.strict()
	.superRefine((asset, context) => {
		if (asset.contentType.startsWith("image/") && asset.size > ARTICLE_ASSET_IMAGE_MAX_BYTES) {
			context.addIssue({ code: "custom", message: "图片暂存响应超过 1 MiB 上限。" });
		}
	});

const mediaStagingPayloadSchema = z.object({ asset: stagedMediaAssetSchema }).strict();
const committedMediaAssetSchema = z
	.object({
		storageSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
		repositoryPath: z
			.string()
			.regex(/^src\/content\/posts\/[a-z0-9-]+\/[a-z0-9-]+\.(?:gif|jpg|png|webp)$/),
		relativePath: z.string().regex(/^\.\/[a-z0-9-]+\.(?:gif|jpg|png|webp)$/),
		commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
		commitUrl: z.url().refine((value) => new URL(value).origin === "https://github.com"),
		fileSha: z.string().regex(/^[a-f0-9]{40,64}$/),
	})
	.strict();
const committedMediaPayloadSchema = z.object({ asset: committedMediaAssetSchema }).strict();
const apiErrorPayloadSchema = z.looseObject({
	error: z.looseObject({ code: z.string(), message: z.string().min(1) }),
});

export type StagedMediaAsset = z.infer<typeof stagedMediaAssetSchema>;
export type CommittedMediaAsset = z.infer<typeof committedMediaAssetSchema>;

export class MediaStagingApiError extends Error {
	readonly code: string | undefined;
	readonly status: number;

	constructor(message: string, status: number, code?: string) {
		super(message);
		this.name = "MediaStagingApiError";
		this.status = status;
		this.code = code;
	}
}

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

export function parseMediaStagingPayload(input: unknown): StagedMediaAsset {
	return mediaStagingPayloadSchema.parse(input).asset;
}

export function parseCommittedMediaPayload(input: unknown): CommittedMediaAsset {
	return committedMediaPayloadSchema.parse(input).asset;
}

export function parseMediaStagingApiError(input: unknown, status: number): string {
	const result = apiErrorPayloadSchema.safeParse(input);
	if (result.success) return result.data.error.message;
	if (status === 401 || status === 403) return "登录状态已失效或没有上传权限。";
	if (status === 409) return "媒体资源已经变化或正在处理，请重新上传后再试。";
	if (status === 413) return "图片不能超过 1 MiB，附件不能超过 4 MiB。";
	if (status === 415) return "仅支持 JPEG、PNG、WebP 和 PDF，且扩展名必须与格式一致。";
	if (status === 429) return "上传过于频繁，请稍后再试。";
	return "媒体资源处理失败，请稍后重试。";
}

export function isR2StagingUnavailable(error: unknown): boolean {
	return (
		error instanceof MediaStagingApiError &&
		error.status === 503 &&
		(error.code === "CONFIGURATION_ERROR" || error.code === "UPSTREAM_UNAVAILABLE")
	);
}

function createApiError(input: unknown, status: number): MediaStagingApiError {
	const result = apiErrorPayloadSchema.safeParse(input);
	return new MediaStagingApiError(
		parseMediaStagingApiError(input, status),
		status,
		result.success ? result.data.error.code : undefined,
	);
}

/** 浏览器不信任上传响应；只有完整通过严格 Schema 的暂存元数据才会进入弹窗状态。 */
export async function stageMediaAsset(
	file: File,
	options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch } = {},
): Promise<StagedMediaAsset> {
	if (file.type === "application/zip") {
		throw new TypeError("ZIP 附件默认关闭；压缩包需要单独的内容审计和风险确认后才能开放。");
	}
	if (!isMediaStagingContentType(file.type) || !isMediaFilenameCompatible(file.name, file.type)) {
		throw new TypeError("文件扩展名必须与支持的格式一致，且不能使用双扩展名。");
	}
	const maxBytes = file.type.startsWith("image/")
		? ARTICLE_ASSET_IMAGE_MAX_BYTES
		: ARTICLE_ASSET_ATTACHMENT_MAX_BYTES;
	if (file.size === 0 || file.size > maxBytes) {
		throw new TypeError(
			file.type.startsWith("image/")
				? "图片必须非空且不能超过 1 MiB。"
				: "附件必须非空且不能超过 4 MiB。",
		);
	}
	const formData = new FormData();
	formData.set("file", file);
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	const response = await fetchImplementation("/api/media/staging", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"X-Firefly-Admin": "1",
		},
		body: formData,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	const payload = await readJson(response);
	if (!response.ok) throw createApiError(payload, response.status);
	return parseMediaStagingPayload(payload);
}

/** 转存响应只能提供受限的文章相对路径，浏览器不会接受任意仓库路径或外部 URL。 */
export async function commitStagedMedia(
	input: { storageSlug: string; asset: StagedMediaAsset },
	options: { signal?: AbortSignal; fetch?: typeof globalThis.fetch; idempotencyKey?: string } = {},
): Promise<CommittedMediaAsset> {
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	const response = await fetchImplementation("/api/media/staging/commit", {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"Idempotency-Key": options.idempotencyKey ?? crypto.randomUUID(),
			"X-Firefly-Admin": "1",
		},
		body: JSON.stringify({
			storageSlug: input.storageSlug,
			objectKey: input.asset.objectKey,
			etag: input.asset.etag,
		}),
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});
	const payload = await readJson(response);
	if (!response.ok) throw new Error(parseMediaStagingApiError(payload, response.status));
	return parseCommittedMediaPayload(payload);
}
