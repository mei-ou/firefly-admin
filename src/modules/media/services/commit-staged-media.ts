import { ApiError } from "../../../core/http/errors";
import { type ArticlePathConfig, buildArticlePath } from "../../../core/security/path-policy";
import type { GitProvider } from "../../../providers/git/types";
import type { R2BucketBinding, R2ObjectBodyBinding } from "../../../types/env";
import { parseSlug } from "../../../utils/slug-utils";
import {
	isMediaStagingContentType,
	MEDIA_REPOSITORY_MAX_BYTES,
	MEDIA_STAGING_MIME_EXTENSIONS,
	MEDIA_STAGING_OBJECT_KEY_PATTERN,
	type MediaStagingContentType,
} from "../media-config";

const SAFE_FILENAME_CHARACTER = /^[a-z0-9-]$/u;
const MAX_FILENAME_STEM_LENGTH = 70;

export interface CommitStagedMediaInput {
	storageSlug: unknown;
	objectKey: unknown;
	etag: unknown;
	subject: string;
}

export interface CommitStagedMediaDependencies {
	bucket: Pick<R2BucketBinding, "get">;
	gitProvider: Pick<GitProvider, "getFile" | "createBinaryFile">;
	pathConfig: ArticlePathConfig;
}

export interface CommittedMediaAsset {
	storageSlug: string;
	repositoryPath: string;
	relativePath: string;
	commitSha: string;
	commitUrl: string;
	fileSha: string;
}

function parseObjectKey(input: unknown): {
	objectKey: string;
	id: string;
	extension: "gif" | "jpg" | "png" | "webp";
} {
	if (typeof input !== "string" || input !== input.normalize("NFKC")) {
		throw new ApiError(400, "INVALID_REQUEST", "暂存图片标识无效。");
	}
	const match = MEDIA_STAGING_OBJECT_KEY_PATTERN.exec(input);
	if (!match?.[1] || !match[2]) {
		throw new ApiError(400, "INVALID_REQUEST", "暂存图片标识无效。");
	}
	return {
		objectKey: input,
		id: match[1].toLowerCase(),
		extension: match[2].toLowerCase() as "gif" | "jpg" | "png" | "webp",
	};
}

function parseEtag(input: unknown): string {
	if (typeof input !== "string" || input.length === 0 || input.length > 500) {
		throw new ApiError(400, "INVALID_REQUEST", "暂存图片版本无效。");
	}
	return input;
}

function parseContentRoot(input: string): string {
	if (
		input.length === 0 ||
		input.length > 512 ||
		input !== input.normalize("NFKC") ||
		input.startsWith("/") ||
		input.endsWith("/") ||
		input.includes("\\") ||
		input.includes("%") ||
		input.includes(":")
	) {
		throw new TypeError("文章内容根目录配置无效。");
	}
	const segments = input.split("/");
	if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(segment))) {
		throw new TypeError("文章内容根目录配置无效。");
	}
	return segments.join("/");
}

function normalizeFilenameStem(originalFilename: string | undefined): string {
	const withoutExtension = (originalFilename ?? "image").replace(/\.[^.]+$/u, "");
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
	return stem.replace(/-+$/u, "") || "image";
}

function parseR2Object(
	object: R2ObjectBodyBinding | null,
	expected: { objectKey: string; etag: string; extension: string; subject: string },
): { object: R2ObjectBodyBinding; contentType: MediaStagingContentType } {
	if (!object) throw new ApiError(404, "NOT_FOUND", "暂存图片不存在或已经处理。");
	if (object.key !== expected.objectKey) {
		throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "媒体暂存服务暂时不可用。");
	}
	if (object.etag !== expected.etag) {
		throw new ApiError(409, "CONFLICT", "暂存图片已经变化，请重新上传后再试。");
	}
	if (object.size <= 0 || object.size > MEDIA_REPOSITORY_MAX_BYTES) {
		throw new ApiError(413, "INVALID_REQUEST", "当前 GitHub 写入链路仅支持不超过 1 MB 的图片。");
	}
	const contentType = object.httpMetadata?.contentType ?? "";
	if (!isMediaStagingContentType(contentType)) {
		throw new ApiError(415, "INVALID_REQUEST", "暂存图片格式无效。");
	}
	if (MEDIA_STAGING_MIME_EXTENSIONS[contentType] !== expected.extension) {
		throw new ApiError(415, "INVALID_REQUEST", "暂存图片扩展名与格式不一致。");
	}
	if (object.customMetadata?.uploaderSubject !== expected.subject) {
		// 不区分对象不存在和不属于当前主体，避免通过接口枚举其他用户的暂存对象。
		throw new ApiError(404, "NOT_FOUND", "暂存图片不存在或已经处理。");
	}
	return { object, contentType };
}

function matchesImageSignature(bytes: Uint8Array, contentType: MediaStagingContentType): boolean {
	const startsWith = (...signature: number[]) =>
		signature.every((byte, index) => bytes[index] === byte);
	if (contentType === "image/jpeg") return startsWith(0xff, 0xd8, 0xff);
	if (contentType === "image/png") {
		return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
	}
	return (
		startsWith(0x52, 0x49, 0x46, 0x46) &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	);
}

/**
 * 把当前主体拥有的 R2 暂存对象写入固定文章 Page Bundle。目标路径和提交信息都由
 * 服务端生成；随机暂存 ID 参与文件名，避免“先检查、再创建”导致的重名竞态。
 */
export async function commitStagedMedia(
	input: CommitStagedMediaInput,
	dependencies: CommitStagedMediaDependencies,
): Promise<CommittedMediaAsset> {
	const storageSlug = parseSlug(input.storageSlug);
	const staged = parseObjectKey(input.objectKey);
	const etag = parseEtag(input.etag);
	// UI 的 edit 模式不是权限边界；服务端必须确认文章入口真实存在，才能创建配套资源。
	const articlePath = buildArticlePath(storageSlug, dependencies.pathConfig);
	await dependencies.gitProvider.getFile(articlePath);
	let r2Object: R2ObjectBodyBinding | null;
	try {
		r2Object = await dependencies.bucket.get(staged.objectKey);
	} catch {
		throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "媒体暂存服务暂时不可用。");
	}
	const loaded = parseR2Object(r2Object, {
		objectKey: staged.objectKey,
		etag,
		extension: staged.extension,
		subject: input.subject,
	});

	let buffer: ArrayBuffer;
	try {
		buffer = await loaded.object.arrayBuffer();
	} catch {
		throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "媒体暂存服务暂时不可用。");
	}
	const content = new Uint8Array(buffer);
	if (
		content.byteLength !== loaded.object.size ||
		!matchesImageSignature(content, loaded.contentType)
	) {
		throw new ApiError(415, "INVALID_REQUEST", "暂存图片内容无效。");
	}

	const contentRoot = parseContentRoot(dependencies.pathConfig.contentRoot);
	const shortId = staged.id.replaceAll("-", "").slice(0, 12);
	const filename = `${normalizeFilenameStem(loaded.object.customMetadata?.originalFilename)}-${shortId}.${staged.extension}`;
	const repositoryPath = `${contentRoot}/${storageSlug}/${filename}`;
	const result = await dependencies.gitProvider.createBinaryFile({
		path: repositoryPath,
		content,
		message: `assets(post): add ${storageSlug}/${filename}`,
	});
	if (result.filePath !== repositoryPath) {
		throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了不一致的媒体路径。");
	}

	return {
		storageSlug,
		repositoryPath,
		relativePath: `./${filename}`,
		commitSha: result.commitSha,
		commitUrl: result.commitUrl,
		fileSha: result.fileSha,
	};
}
