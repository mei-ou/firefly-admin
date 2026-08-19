import { ApiError } from "../../../core/http/errors";
import {
	type ArticlePathConfig,
	buildArticlePath,
	buildArticleResourcePath,
	buildControlledArticleResourceReference,
	getArticleResourceFilenameConflictKey,
	parseArticleResourceFilename,
} from "../../../core/security/path-policy";
import type {
	GitDirectoryEntry,
	GitProvider,
	GitRepositoryFile,
} from "../../../providers/git/types";
import type { ArticleAssetReference } from "../article-asset";
import {
	ARTICLE_ASSET_ATTACHMENT_MAX_BYTES,
	ARTICLE_ASSET_IMAGE_MAX_BYTES,
	ARTICLE_ASSET_MAX_COUNT,
	ARTICLE_ASSET_TOTAL_MAX_BYTES,
	isArticleAssetImageFilename,
} from "../media-config";
import {
	type MediaTransactionCommitArticlePlan,
	type MediaTransactionCommitPlan,
	type MoveMediaTransactionCommitPlan,
	parseMoveMediaTransactionCommitPlan,
	parseRenameMediaTransactionCommitPlan,
	type RenameMediaTransactionCommitPlan,
} from "../media-transaction-commit";
import {
	type MediaTransactionReferenceImpact,
	type MoveMediaTransactionPreview,
	parseMediaTransactionPreview,
	type RenameMediaTransactionPreview,
} from "../media-transaction-preview";
import {
	rewriteMediaTransactionReferences,
	rewriteRenameMediaReferences,
} from "../media-transaction-rewriter";
import {
	type MediaTransactionReferenceClosure,
	scanMediaTransactionReferenceClosure,
} from "./scan-media-transaction-reference-closure";

export interface PrepareMediaTransactionCommitDependencies {
	gitProvider: Pick<GitProvider, "getHead" | "getFileAtCommit" | "listDirectoryAtCommit">;
	pathConfig: ArticlePathConfig;
	scanReferenceClosure?: typeof scanMediaTransactionReferenceClosure;
}

function conflict(message: string): ApiError {
	return new ApiError(409, "CONFLICT", message);
}

function validateBundleEntries(
	entries: readonly GitDirectoryEntry[],
	preview: RenameMediaTransactionPreview,
	pathConfig: ArticlePathConfig,
): void {
	const articlePath = buildArticlePath(preview.storageSlug, pathConfig);
	const conflictKeys = new Set<string>();
	let sourceFound = false;
	for (const entry of entries) {
		if (entry.path === articlePath && entry.name === pathConfig.entryFilename) continue;
		if (entry.type !== "file") throw conflict("文章资源目录包含不支持的子目录。");
		let filename: string;
		try {
			filename = parseArticleResourceFilename(entry.name);
		} catch {
			throw conflict("文章资源目录包含无效文件名。");
		}
		const key = getArticleResourceFilenameConflictKey(filename);
		if (conflictKeys.has(key)) throw conflict("文章资源目录存在大小写或 Unicode 冲突。");
		conflictKeys.add(key);
		if (
			entry.path !== `${articlePath.slice(0, -(pathConfig.entryFilename.length + 1))}/${filename}`
		) {
			throw conflict("文章资源路径已变化。");
		}
		if (key === getArticleResourceFilenameConflictKey(preview.destination.filename)) {
			throw conflict("目标资源文件名已存在。");
		}
		if (key !== getArticleResourceFilenameConflictKey(preview.source.filename)) continue;
		if (
			filename !== preview.source.filename ||
			entry.path !== preview.source.repositoryPath ||
			entry.sha !== preview.expectedBlobSha ||
			entry.size === null ||
			!Number.isSafeInteger(entry.size) ||
			entry.size <= 0 ||
			entry.size >
				(isArticleAssetImageFilename(filename)
					? ARTICLE_ASSET_IMAGE_MAX_BYTES
					: ARTICLE_ASSET_ATTACHMENT_MAX_BYTES)
		) {
			throw conflict("源资源版本或大小已变化。");
		}
		sourceFound = true;
	}
	if (!sourceFound) throw conflict("源资源不存在或文件名大小写已变化。");
}

async function prepareRenameMediaTransactionCommit(
	preview: RenameMediaTransactionPreview,
	dependencies: PrepareMediaTransactionCommitDependencies,
): Promise<RenameMediaTransactionCommitPlan> {
	const head = await dependencies.gitProvider.getHead();
	if (head.commitSha !== preview.baseCommitSha) {
		throw conflict("远端分支已变化，请重新生成影响预览。");
	}
	const articlePath = buildArticlePath(preview.storageSlug, dependencies.pathConfig);
	const bundlePath = articlePath.slice(0, -(dependencies.pathConfig.entryFilename.length + 1));
	const [articleFile, entries] = await Promise.all([
		dependencies.gitProvider.getFileAtCommit(articlePath, head.commitSha),
		dependencies.gitProvider.listDirectoryAtCommit(bundlePath, head.commitSha),
	]);
	if (
		articleFile.path !== articlePath ||
		articleFile.encoding !== "utf-8" ||
		articleFile.sha !== preview.expectedArticleSha
	) {
		throw conflict("文章版本已变化，请重新生成影响预览。");
	}
	validateBundleEntries(entries, preview, dependencies.pathConfig);

	let rewritten: ReturnType<typeof rewriteRenameMediaReferences>;
	try {
		rewritten = rewriteRenameMediaReferences({
			source: articleFile.content,
			storageSlug: preview.storageSlug,
			currentTarget: preview.source.relativePath,
			proposedTarget: preview.destination.relativePath,
			expectedReferences: preview.references,
		});
	} catch {
		throw conflict("文章引用已变化，请重新生成影响预览。");
	}
	const plan: RenameMediaTransactionCommitPlan = {
		version: 1,
		operation: "rename",
		previewId: preview.previewId,
		storageSlug: preview.storageSlug,
		baseCommitSha: preview.baseCommitSha,
		source: {
			repositoryPath: preview.source.repositoryPath,
			blobSha: preview.expectedBlobSha,
		},
		destination: {
			repositoryPath: preview.destination.repositoryPath,
			reusedBlobSha: preview.expectedBlobSha,
		},
		article: {
			mode: rewritten.replacements.length > 0 ? "write" : "unchanged",
			repositoryPath: articlePath,
			expectedSha: preview.expectedArticleSha,
			originalContent: articleFile.content,
			plannedContent: rewritten.content,
			replacements: rewritten.replacements,
		},
	};
	return parseRenameMediaTransactionCommitPlan(plan, preview, dependencies.pathConfig);
}

interface ValidatedMoveBundle {
	articlePath: string;
	articleFile: GitRepositoryFile;
	resourceCount: number;
	totalBytes: number;
}

const ALLOWED_MOVE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "pdf", "png", "webp"]);

function validateMoveBundle(
	storageSlug: string,
	expectedArticleSha: string,
	entries: readonly GitDirectoryEntry[],
	articleFile: GitRepositoryFile,
	pathConfig: ArticlePathConfig,
): ValidatedMoveBundle {
	const articlePath = buildArticlePath(storageSlug, pathConfig);
	if (
		articleFile.path !== articlePath ||
		articleFile.encoding !== "utf-8" ||
		articleFile.sha !== expectedArticleSha
	) {
		throw conflict("文章版本已变化，请重新生成影响预览。");
	}

	const conflictKeys = new Set<string>();
	let articleEntryCount = 0;
	let resourceCount = 0;
	let totalBytes = 0;
	for (const entry of entries) {
		if (entry.type !== "file") throw conflict("文章资源目录包含不支持的子目录。");
		if (entry.name === pathConfig.entryFilename) {
			if (entry.path !== articlePath || entry.sha !== articleFile.sha) {
				throw conflict("文章入口目录项已变化。");
			}
			articleEntryCount += 1;
			continue;
		}
		if (entry.name.toLowerCase() === pathConfig.entryFilename.toLowerCase()) {
			throw conflict("文章入口目录项存在大小写冲突。");
		}

		let filename: string;
		try {
			filename = parseArticleResourceFilename(entry.name);
		} catch {
			throw conflict("文章资源目录包含无效文件名。");
		}
		const key = getArticleResourceFilenameConflictKey(filename);
		if (conflictKeys.has(key)) throw conflict("文章资源目录存在大小写或 Unicode 冲突。");
		conflictKeys.add(key);
		if (entry.path !== buildArticleResourcePath(storageSlug, filename, pathConfig)) {
			throw conflict("文章资源路径已变化。");
		}
		if (entry.size === null || !Number.isSafeInteger(entry.size) || entry.size <= 0) {
			throw conflict("文章资源大小无法验证。");
		}
		resourceCount += 1;
		totalBytes += entry.size;
	}
	if (
		articleEntryCount !== 1 ||
		resourceCount > ARTICLE_ASSET_MAX_COUNT ||
		totalBytes > ARTICLE_ASSET_TOTAL_MAX_BYTES
	) {
		throw conflict("文章 Page Bundle 已超出安全边界。");
	}
	return { articlePath, articleFile, resourceCount, totalBytes };
}

function validateMoveResource(
	preview: MoveMediaTransactionPreview,
	sourceEntries: readonly GitDirectoryEntry[],
	destinationEntries: readonly GitDirectoryEntry[],
	destinationBundle: ValidatedMoveBundle,
): void {
	const sourceKey = getArticleResourceFilenameConflictKey(preview.source.resource.filename);
	const destinationKey = getArticleResourceFilenameConflictKey(
		preview.destination.resource.filename,
	);
	const sourceMatches = sourceEntries.filter((entry) => {
		if (entry.name === preview.source.resource.filename) return true;
		try {
			return getArticleResourceFilenameConflictKey(entry.name) === sourceKey;
		} catch {
			return false;
		}
	});
	const source = sourceMatches[0];
	const sourceExtension = preview.source.resource.filename
		.slice(preview.source.resource.filename.lastIndexOf(".") + 1)
		.toLowerCase();
	if (
		sourceMatches.length !== 1 ||
		source === undefined ||
		source.type !== "file" ||
		source.name !== preview.source.resource.filename ||
		source.path !== preview.source.resource.repositoryPath ||
		source.sha !== preview.source.resource.blobSha ||
		source.size === null ||
		!Number.isSafeInteger(source.size) ||
		source.size <= 0 ||
		!ALLOWED_MOVE_EXTENSIONS.has(sourceExtension) ||
		source.size >
			(isArticleAssetImageFilename(source.name)
				? ARTICLE_ASSET_IMAGE_MAX_BYTES
				: ARTICLE_ASSET_ATTACHMENT_MAX_BYTES)
	) {
		throw conflict("源资源版本、类型或大小已变化。");
	}
	if (
		destinationEntries.some((entry) => {
			try {
				return getArticleResourceFilenameConflictKey(entry.name) === destinationKey;
			} catch {
				return false;
			}
		})
	) {
		throw conflict("目标资源文件名已存在。");
	}
	// 目标 Bundle 的配额必须包含待复用 Blob，防止 prepare 放行超限后的最终树。
	if (
		destinationBundle.resourceCount + 1 > ARTICLE_ASSET_MAX_COUNT ||
		destinationBundle.totalBytes + source.size > ARTICLE_ASSET_TOTAL_MAX_BYTES
	) {
		throw conflict("目标文章 Page Bundle 已超出安全边界。");
	}
}

function referenceImpact(
	reference: ArticleAssetReference,
	proposedTarget: string,
): MediaTransactionReferenceImpact {
	return {
		source: reference.source,
		originalReference: reference.originalReference,
		currentTarget: reference.target,
		proposedTarget,
		line: reference.line,
		column: reference.column,
	};
}

function sameReferences(
	actual: readonly ArticleAssetReference[],
	expected: readonly MediaTransactionReferenceImpact[],
	proposedTarget: string,
): boolean {
	return (
		JSON.stringify(actual.map((reference) => referenceImpact(reference, proposedTarget))) ===
		JSON.stringify(expected)
	);
}

function assertMoveReferenceClosure(
	closure: MediaTransactionReferenceClosure,
	preview: MoveMediaTransactionPreview,
	sourceProposedTarget: string,
	destinationProposedTarget: string,
): void {
	if (
		closure.baseCommitSha !== preview.baseCommitSha ||
		closure.source.storageSlug !== preview.source.storageSlug ||
		closure.source.articleSha !== preview.source.article.expectedSha ||
		closure.destination.storageSlug !== preview.destination.storageSlug ||
		closure.destination.articleSha !== preview.destination.article.expectedSha ||
		closure.scannedArticleCount !== preview.referenceClosure.scannedArticleCount ||
		preview.referenceClosure.thirdPartyReferenceCount !== 0 ||
		!sameReferences(closure.source.references, preview.source.references, sourceProposedTarget) ||
		!sameReferences(
			closure.destination.references,
			preview.destination.references,
			destinationProposedTarget,
		)
	) {
		throw conflict("文章引用闭包已变化，请重新生成影响预览。");
	}
}

function createArticlePlan(
	articlePath: string,
	articleFile: GitRepositoryFile,
	rewritten: ReturnType<typeof rewriteMediaTransactionReferences>,
): MediaTransactionCommitArticlePlan {
	return {
		mode: rewritten.replacements.length > 0 ? "write" : "unchanged",
		repositoryPath: articlePath,
		expectedSha: articleFile.sha,
		originalContent: articleFile.content,
		plannedContent: rewritten.content,
		replacements: rewritten.replacements,
	};
}

async function prepareMoveMediaTransactionCommit(
	preview: MoveMediaTransactionPreview,
	dependencies: PrepareMediaTransactionCommitDependencies,
): Promise<MoveMediaTransactionCommitPlan> {
	// 固定入口文件避免闭包扫描与最终跨 Bundle Commit 对仓库边界产生不同解释。
	if (dependencies.pathConfig.entryFilename !== "index.md") {
		throw new ApiError(503, "CONFIGURATION_ERROR", "跨文章资源事务仅支持固定 Page Bundle。");
	}
	const head = await dependencies.gitProvider.getHead();
	if (head.commitSha !== preview.baseCommitSha) {
		throw conflict("远端分支已变化，请重新生成影响预览。");
	}
	const sourceArticlePath = buildArticlePath(preview.source.storageSlug, dependencies.pathConfig);
	const destinationArticlePath = buildArticlePath(
		preview.destination.storageSlug,
		dependencies.pathConfig,
	);
	const sourceBundlePath = sourceArticlePath.slice(
		0,
		-(dependencies.pathConfig.entryFilename.length + 1),
	);
	const destinationBundlePath = destinationArticlePath.slice(
		0,
		-(dependencies.pathConfig.entryFilename.length + 1),
	);
	const [sourceArticleFile, destinationArticleFile, sourceEntries, destinationEntries] =
		await Promise.all([
			dependencies.gitProvider.getFileAtCommit(sourceArticlePath, head.commitSha),
			dependencies.gitProvider.getFileAtCommit(destinationArticlePath, head.commitSha),
			dependencies.gitProvider.listDirectoryAtCommit(sourceBundlePath, head.commitSha),
			dependencies.gitProvider.listDirectoryAtCommit(destinationBundlePath, head.commitSha),
		]);
	const sourceBundle = validateMoveBundle(
		preview.source.storageSlug,
		preview.source.article.expectedSha,
		sourceEntries,
		sourceArticleFile,
		dependencies.pathConfig,
	);
	const destinationBundle = validateMoveBundle(
		preview.destination.storageSlug,
		preview.destination.article.expectedSha,
		destinationEntries,
		destinationArticleFile,
		dependencies.pathConfig,
	);
	validateMoveResource(preview, sourceEntries, destinationEntries, destinationBundle);

	const sourceCurrentTarget = buildControlledArticleResourceReference(
		preview.source.storageSlug,
		preview.source.storageSlug,
		preview.source.resource.filename,
		dependencies.pathConfig,
	);
	const sourceProposedTarget = buildControlledArticleResourceReference(
		preview.source.storageSlug,
		preview.destination.storageSlug,
		preview.destination.resource.filename,
		dependencies.pathConfig,
	);
	const destinationCurrentTarget = buildControlledArticleResourceReference(
		preview.destination.storageSlug,
		preview.source.storageSlug,
		preview.source.resource.filename,
		dependencies.pathConfig,
	);
	const destinationProposedTarget = buildControlledArticleResourceReference(
		preview.destination.storageSlug,
		preview.destination.storageSlug,
		preview.destination.resource.filename,
		dependencies.pathConfig,
	);

	let closure: MediaTransactionReferenceClosure;
	try {
		const scanReferenceClosure =
			dependencies.scanReferenceClosure ?? scanMediaTransactionReferenceClosure;
		closure = await scanReferenceClosure(
			{
				baseCommitSha: head.commitSha,
				source: {
					storageSlug: preview.source.storageSlug,
					articleSha: sourceArticleFile.sha,
					filename: preview.source.resource.filename,
				},
				destination: {
					storageSlug: preview.destination.storageSlug,
					articleSha: destinationArticleFile.sha,
				},
			},
			{ gitProvider: dependencies.gitProvider, pathConfig: dependencies.pathConfig },
		);
		assertMoveReferenceClosure(closure, preview, sourceProposedTarget, destinationProposedTarget);
	} catch (error) {
		if (error instanceof ApiError && error.status === 409) throw error;
		throw conflict("文章引用闭包无法重新证明，请重新生成影响预览。");
	}

	let sourceRewritten: ReturnType<typeof rewriteMediaTransactionReferences>;
	let destinationRewritten: ReturnType<typeof rewriteMediaTransactionReferences>;
	try {
		sourceRewritten = rewriteMediaTransactionReferences({
			source: sourceBundle.articleFile.content,
			storageSlug: preview.source.storageSlug,
			currentTarget: sourceCurrentTarget,
			proposedTarget: sourceProposedTarget,
			expectedReferences: preview.source.references,
			pathConfig: dependencies.pathConfig,
		});
		destinationRewritten = rewriteMediaTransactionReferences({
			source: destinationBundle.articleFile.content,
			storageSlug: preview.destination.storageSlug,
			currentTarget: destinationCurrentTarget,
			proposedTarget: destinationProposedTarget,
			expectedReferences: preview.destination.references,
			pathConfig: dependencies.pathConfig,
		});
	} catch {
		throw conflict("文章引用已变化，请重新生成影响预览。");
	}

	const plan: MoveMediaTransactionCommitPlan = {
		version: 1,
		operation: "move",
		previewId: preview.previewId,
		baseCommitSha: preview.baseCommitSha,
		source: {
			storageSlug: preview.source.storageSlug,
			resource: {
				repositoryPath: preview.source.resource.repositoryPath,
				blobSha: preview.source.resource.blobSha,
			},
			article: createArticlePlan(sourceBundle.articlePath, sourceArticleFile, sourceRewritten),
		},
		destination: {
			storageSlug: preview.destination.storageSlug,
			resource: {
				repositoryPath: preview.destination.resource.repositoryPath,
				reusedBlobSha: preview.source.resource.blobSha,
			},
			article: createArticlePlan(
				destinationBundle.articlePath,
				destinationArticleFile,
				destinationRewritten,
			),
		},
	};
	return parseMoveMediaTransactionCommitPlan(plan, preview, dependencies.pathConfig);
}

/** 在同一不可变 HEAD 上重新证明 Preview 的全部读条件，并生成可持久化 strict Plan。 */
export async function prepareMediaTransactionCommit(
	previewInput: unknown,
	dependencies: PrepareMediaTransactionCommitDependencies,
): Promise<MediaTransactionCommitPlan> {
	const preview = parseMediaTransactionPreview(previewInput, dependencies.pathConfig);
	if (!dependencies.pathConfig.usePageBundle) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "资源事务仅支持 Page Bundle。");
	}
	return preview.operation === "rename"
		? prepareRenameMediaTransactionCommit(preview, dependencies)
		: prepareMoveMediaTransactionCommit(preview, dependencies);
}
