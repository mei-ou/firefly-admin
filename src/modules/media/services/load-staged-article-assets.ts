import { ApiError } from "../../../core/http/errors";
import {
	type ArticlePathConfig,
	buildArticleResourcePath,
} from "../../../core/security/path-policy";
import type { R2BucketBinding, R2ObjectBodyBinding } from "../../../types/env";
import type { StagedArticleAsset, StagedArticleAssetManifest } from "../article-asset-manifest";
import {
	ARTICLE_ASSET_TOTAL_MAX_BYTES,
	type ArticleAssetRole,
	deriveStagedArticleAssetPath,
	getMediaMaxBytes,
	isMediaFilenameCompatible,
	isMediaRoleCompatible,
	isMediaStagingContentType,
	MEDIA_STAGING_MIME_EXTENSIONS,
	MEDIA_STAGING_OBJECT_KEY_PATTERN,
	type MediaStagingContentType,
	matchesMediaSignature,
} from "../media-config";

export interface LoadedArticleAsset {
	assetId: string;
	objectKey: string;
	finalFilename: string;
	relativePath: string;
	repositoryPath: string;
	contentType: MediaStagingContentType;
	size: number;
	role: ArticleAssetRole;
	content: Uint8Array;
}

export interface LoadStagedArticleAssetsInput {
	storageSlug: string;
	subject: string;
	manifest: StagedArticleAssetManifest;
}

export interface LoadStagedArticleAssetsDependencies {
	bucket: Pick<R2BucketBinding, "get">;
	pathConfig: ArticlePathConfig;
}

function parseObjectIdentity(asset: StagedArticleAsset): {
	id: string;
	extension: string;
} {
	const match = MEDIA_STAGING_OBJECT_KEY_PATTERN.exec(asset.objectKey);
	if (!match?.[1] || !match[2] || match[1].toLowerCase() !== asset.assetId.toLowerCase()) {
		throw new ApiError(400, "INVALID_REQUEST", "暂存资源标识无效。");
	}
	return { id: match[1].toLowerCase(), extension: match[2].toLowerCase() };
}

function validateR2Metadata(
	asset: StagedArticleAsset,
	object: R2ObjectBodyBinding | null,
	extension: string,
	subject: string,
): { object: R2ObjectBodyBinding; contentType: MediaStagingContentType } {
	if (!object) throw new ApiError(404, "NOT_FOUND", "暂存资源不存在或已经处理。");
	if (object.key !== asset.objectKey) {
		throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "媒体暂存服务暂时不可用。");
	}
	if (object.etag !== asset.etag) {
		throw new ApiError(409, "CONFLICT", "暂存资源已经变化，请重新上传后再试。");
	}
	if (object.customMetadata?.uploaderSubject !== subject) {
		throw new ApiError(404, "NOT_FOUND", "暂存资源不存在或已经处理。");
	}
	const contentType = object.httpMetadata?.contentType ?? "";
	if (!isMediaStagingContentType(contentType)) {
		throw new ApiError(415, "INVALID_REQUEST", "暂存资源格式无效。");
	}
	const originalFilename = object.customMetadata?.originalFilename ?? "";
	if (!isMediaFilenameCompatible(originalFilename, contentType)) {
		throw new ApiError(415, "INVALID_REQUEST", "暂存资源文件名与格式不一致。");
	}
	if (
		MEDIA_STAGING_MIME_EXTENSIONS[contentType] !== extension ||
		asset.contentType !== contentType ||
		!isMediaRoleCompatible(contentType, asset.role)
	) {
		throw new ApiError(415, "INVALID_REQUEST", "暂存资源类型或用途不一致。");
	}
	if (
		object.size <= 0 ||
		object.size > getMediaMaxBytes(contentType) ||
		asset.size !== object.size
	) {
		throw new ApiError(413, "INVALID_REQUEST", "暂存资源大小无效或已经变化。");
	}
	return { object, contentType };
}

async function readR2Object(
	object: R2ObjectBodyBinding,
	contentType: MediaStagingContentType,
): Promise<Uint8Array> {
	let buffer: ArrayBuffer;
	try {
		buffer = await object.arrayBuffer();
	} catch {
		throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "媒体暂存服务暂时不可用。");
	}
	const content = new Uint8Array(buffer);
	if (content.byteLength !== object.size || !matchesMediaSignature(content, contentType)) {
		throw new ApiError(415, "INVALID_REQUEST", "暂存资源内容无效。");
	}
	return content;
}

/**
 * 在任何 Git 对象创建前加载并复核完整资源清单。此函数不写 Git、不删除 R2，因此失败
 * 只会留下可重试的暂存对象，不会让目标分支进入半完成状态。
 */
export async function loadStagedArticleAssets(
	input: LoadStagedArticleAssetsInput,
	dependencies: LoadStagedArticleAssetsDependencies,
): Promise<LoadedArticleAsset[]> {
	const loadedAssets: LoadedArticleAsset[] = [];
	const repositoryPaths = new Set<string>();
	let totalBytes = 0;

	for (const asset of input.manifest.assets) {
		const identity = parseObjectIdentity(asset);
		let object: R2ObjectBodyBinding | null;
		try {
			object = await dependencies.bucket.get(asset.objectKey);
		} catch {
			throw new ApiError(503, "UPSTREAM_UNAVAILABLE", "媒体暂存服务暂时不可用。");
		}
		const validated = validateR2Metadata(asset, object, identity.extension, input.subject);
		const content = await readR2Object(validated.object, validated.contentType);
		totalBytes += content.byteLength;
		if (totalBytes > ARTICLE_ASSET_TOTAL_MAX_BYTES) {
			throw new ApiError(413, "INVALID_REQUEST", "单次文章资源总量不能超过 5 MiB。");
		}

		let finalFilename: string;
		let relativePath: string;
		try {
			({ finalFilename, relativePath } = deriveStagedArticleAssetPath({
				assetId: asset.assetId,
				objectKey: asset.objectKey,
				originalFilename: validated.object.customMetadata?.originalFilename ?? "",
			}));
		} catch {
			throw new ApiError(400, "INVALID_REQUEST", "暂存资源标识无效。");
		}
		const repositoryPath = buildArticleResourcePath(
			input.storageSlug,
			finalFilename,
			dependencies.pathConfig,
		);
		if (repositoryPaths.has(repositoryPath)) {
			throw new ApiError(400, "INVALID_REQUEST", "文章资源清单包含重复目标路径。");
		}
		repositoryPaths.add(repositoryPath);
		loadedAssets.push({
			assetId: asset.assetId,
			objectKey: asset.objectKey,
			finalFilename,
			relativePath,
			repositoryPath,
			contentType: validated.contentType,
			size: content.byteLength,
			role: asset.role,
			content,
		});
	}

	return loadedAssets;
}
