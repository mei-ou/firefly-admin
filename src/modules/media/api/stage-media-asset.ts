import { type AuditWriter, writeAuditEvent } from "../../../core/audit/audit-log";
import { guardModule } from "../../../core/config/feature-flags";
import { ApiError } from "../../../core/http/errors";
import { jsonResponse } from "../../../core/http/response";
import { enforceRateLimit } from "../../../core/security/rate-limit";
import type { AuthenticatedPrincipal, R2PutResult, RuntimeEnv } from "../../../types/env";
import {
	getMediaMaxBytes,
	isMediaFilenameCompatible,
	isMediaStagingContentType,
	MEDIA_STAGING_MAX_BYTES,
	MEDIA_STAGING_MIME_EXTENSIONS,
	MEDIA_STAGING_PREFIX,
	type MediaStagingContentType,
	matchesMediaSignature,
} from "../media-config";

const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_ORIGINAL_FILENAME_LENGTH = 255;

export interface StageMediaAssetRequestContext {
	request: Request;
	requestId: string;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

export interface StageMediaAssetHandlerDependencies {
	createId?: () => string;
	now?: () => Date;
	auditWriter?: AuditWriter;
}

function parseContentLength(request: Request): void {
	const value = request.headers.get("Content-Length");
	if (value === null) return;
	if (!/^\d+$/u.test(value)) {
		throw new ApiError(400, "INVALID_REQUEST", "上传请求大小无效。");
	}
	const contentLength = Number(value);
	if (!Number.isSafeInteger(contentLength)) {
		throw new ApiError(400, "INVALID_REQUEST", "上传请求大小无效。");
	}
	if (contentLength > MEDIA_STAGING_MAX_BYTES + MULTIPART_OVERHEAD_BYTES) {
		throw new ApiError(413, "INVALID_REQUEST", "上传文件不能超过 4 MiB。");
	}
}

async function parseUploadFile(
	request: Request,
): Promise<File & { type: MediaStagingContentType }> {
	let formData: FormData;
	try {
		formData = await request.formData();
	} catch {
		throw new ApiError(400, "INVALID_REQUEST", "上传表单无效。");
	}
	const fields = Array.from(formData.keys());
	if (fields.length !== 1 || fields[0] !== "file" || formData.getAll("file").length !== 1) {
		throw new ApiError(400, "INVALID_REQUEST", "上传表单必须只包含一个文件。");
	}
	const file = formData.get("file");
	if (!(file instanceof File)) {
		throw new ApiError(400, "INVALID_REQUEST", "上传表单缺少文件。");
	}
	if (!isMediaStagingContentType(file.type)) {
		throw new ApiError(415, "INVALID_REQUEST", "仅支持 JPEG、PNG、WebP 和 PDF。");
	}
	if (!isMediaFilenameCompatible(file.name, file.type)) {
		throw new ApiError(
			415,
			"INVALID_REQUEST",
			"文件扩展名必须与声明格式一致，且不能使用双扩展名。",
		);
	}
	if (file.size === 0 || file.size > getMediaMaxBytes(file.type)) {
		throw new ApiError(
			413,
			"INVALID_REQUEST",
			file.type.startsWith("image/")
				? "上传图片必须非空且不能超过 1 MiB。"
				: "上传附件必须非空且不能超过 4 MiB。",
		);
	}
	const signature = new Uint8Array(await file.slice(0, 16).arrayBuffer());
	if (!matchesMediaSignature(signature, file.type)) {
		throw new ApiError(415, "INVALID_REQUEST", "文件内容与声明格式不一致。");
	}
	return file as File & { type: MediaStagingContentType };
}

function createObjectKey(now: Date, id: string, contentType: MediaStagingContentType): string {
	if (!/^[a-f0-9-]{16,64}$/iu.test(id)) {
		throw new ApiError(500, "INTERNAL_ERROR", "服务器发生内部错误。");
	}
	const year = now.getUTCFullYear().toString().padStart(4, "0");
	const month = (now.getUTCMonth() + 1).toString().padStart(2, "0");
	return `${MEDIA_STAGING_PREFIX}/${year}/${month}/${id.toLowerCase()}.${MEDIA_STAGING_MIME_EXTENSIONS[contentType]}`;
}

function sanitizeOriginalFilename(value: string): string {
	const normalized = value.normalize("NFC").trim();
	if (!normalized) return "upload";
	return Array.from(normalized, (character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 31 || codePoint === 127 || character === "/" || character === "\\"
			? "_"
			: character;
	})
		.join("")
		.slice(0, MAX_ORIGINAL_FILENAME_LENGTH);
}

/**
 * R2 暂存上传只保存服务端生成的对象键。绑定、限流或写入失败时失败关闭；原始文件名仅作为
 * 限长元数据，不参与对象路径，也不返回 Bucket 名称或可公开访问的 URL。
 */
export async function handleStageMediaAsset(
	context: StageMediaAssetRequestContext,
	dependencies: StageMediaAssetHandlerDependencies = {},
): Promise<Response> {
	guardModule("media");
	if (!context.principal) {
		throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	}
	if (!context.env.MEDIA_STAGING_BUCKET) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "媒体暂存服务暂时不可用。");
	}

	parseContentLength(context.request);
	await enforceRateLimit(context.env.RATE_LIMITER, context.principal.sub, "image-upload");
	const file = await parseUploadFile(context.request);

	const now = dependencies.now?.() ?? new Date();
	const id = dependencies.createId?.() ?? crypto.randomUUID();
	const objectKey = createObjectKey(now, id, file.type);
	let stored: R2PutResult;
	try {
		stored = await context.env.MEDIA_STAGING_BUCKET.put(objectKey, file.stream(), {
			httpMetadata: { contentType: file.type },
			customMetadata: {
				originalFilename: sanitizeOriginalFilename(file.name),
				uploaderSubject: context.principal.sub,
			},
		});
	} catch {
		throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "媒体暂存服务暂时不可用。");
	}

	writeAuditEvent(
		{
			requestId: context.requestId,
			subject: context.principal.sub,
			action: "media.stage-upload",
			outcome: "success",
			target: objectKey,
			timestamp: now.toISOString(),
			metadata: { contentType: file.type, size: file.size },
		},
		dependencies.auditWriter,
	);

	return jsonResponse(
		{
			asset: {
				id,
				objectKey,
				filename: sanitizeOriginalFilename(file.name),
				contentType: file.type,
				size: stored.size,
				etag: stored.etag,
				uploadedAt: now.toISOString(),
			},
		},
		201,
	);
}
