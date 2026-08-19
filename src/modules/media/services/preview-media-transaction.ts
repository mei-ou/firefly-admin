import { ApiError } from "../../../core/http/errors";
import {
	type ArticlePathConfig,
	buildArticlePath,
	buildArticleResourcePath,
	buildControlledArticleResourceReference,
	getArticleResourceFilenameConflictKey,
} from "../../../core/security/path-policy";
import type {
	GitDirectoryEntry,
	GitProvider,
	GitRepositoryFile,
} from "../../../providers/git/types";
import { parseMarkdownDocument } from "../../../utils/frontmatter-utils";
import type { ArticleAssetReference } from "../article-asset";
import { ARTICLE_ASSET_MAX_COUNT, ARTICLE_ASSET_TOTAL_MAX_BYTES } from "../media-config";
import {
	type MediaTransactionPreview,
	type MediaTransactionPreviewEffect,
	type MediaTransactionPreviewRequest,
	type MediaTransactionPreviewRiskReason,
	type MediaTransactionReferenceImpact,
	type MoveMediaTransactionPreviewRequest,
	parseMediaTransactionPreview,
	parseMediaTransactionPreviewRequest,
	type RenameMediaTransactionPreviewRequest,
} from "../media-transaction-preview";
import {
	type MediaTransactionReferenceClosure,
	scanMediaTransactionReferenceClosure,
} from "./scan-media-transaction-reference-closure";
import { summarizeArticleAssets } from "./summarize-article-assets";

const PREVIEW_TTL_MS = 10 * 60 * 1000;
const ALLOWED_MOVE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "pdf", "png", "webp"]);

export interface PreviewMediaTransactionDependencies {
	gitProvider: Pick<GitProvider, "getHead" | "getFileAtCommit" | "listDirectoryAtCommit">;
	pathConfig: ArticlePathConfig;
	now?: () => number;
	createPreviewId?: () => string;
	scanReferenceClosure?: typeof scanMediaTransactionReferenceClosure;
}

interface ReadBundle {
	articlePath: string;
	bundlePath: string;
	articleFile: GitRepositoryFile;
	parsedArticle: ReturnType<typeof parseMarkdownDocument>;
	resourceEntries: GitDirectoryEntry[];
	resources: ReturnType<typeof summarizeArticleAssets>["resources"];
}

function conflict(message: string): ApiError {
	return new ApiError(409, "MEDIA_PREVIEW_CONFLICT", message);
}

function blocked(message: string): ApiError {
	return new ApiError(422, "MEDIA_RESOURCE_BLOCKED", message);
}

function createReferenceImpact(
	reference: Pick<
		ArticleAssetReference,
		"source" | "originalReference" | "target" | "line" | "column"
	>,
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

function getExtension(filename: string): string {
	return filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
}

function validateResourceBudget(entries: readonly GitDirectoryEntry[], additionalBytes = 0): void {
	if (entries.length + (additionalBytes > 0 ? 1 : 0) > ARTICLE_ASSET_MAX_COUNT) {
		throw blocked("文章资源数量超过安全限制。");
	}
	let totalBytes = additionalBytes;
	for (const entry of entries) {
		if (entry.type !== "file" || entry.size === null || !Number.isSafeInteger(entry.size)) {
			throw blocked("文章资源目录包含无法验证的条目。");
		}
		totalBytes += entry.size;
	}
	if (totalBytes > ARTICLE_ASSET_TOTAL_MAX_BYTES) {
		throw blocked("文章资源总大小超过安全限制。");
	}
}

async function readBundle(
	storageSlug: string,
	expectedArticleSha: string,
	baseCommitSha: string,
	dependencies: PreviewMediaTransactionDependencies,
	enforceMoveSafety: boolean,
): Promise<ReadBundle> {
	const articlePath = buildArticlePath(storageSlug, dependencies.pathConfig);
	const bundlePath = articlePath.slice(0, -(dependencies.pathConfig.entryFilename.length + 1));
	const [articleFile, entries] = await Promise.all([
		dependencies.gitProvider.getFileAtCommit(articlePath, baseCommitSha),
		dependencies.gitProvider.listDirectoryAtCommit(bundlePath, baseCommitSha),
	]);
	if (
		articleFile.path !== articlePath ||
		articleFile.encoding !== "utf-8" ||
		articleFile.sha !== expectedArticleSha
	) {
		throw conflict("文章版本已变化，请重新加载后再预览。");
	}
	const articleEntries = entries.filter(
		(entry) => entry.name.toLowerCase() === dependencies.pathConfig.entryFilename.toLowerCase(),
	);
	const exactArticleEntry = entries.filter(
		(entry) => entry.name === dependencies.pathConfig.entryFilename,
	);
	if (
		articleEntries.length !== 1 ||
		exactArticleEntry.length !== 1 ||
		exactArticleEntry[0]?.type !== "file" ||
		exactArticleEntry[0].path !== articlePath ||
		exactArticleEntry[0].sha !== articleFile.sha
	) {
		throw new ApiError(422, "ARTICLE_INVALID", "文章入口目录项无效。");
	}
	let parsedArticle: ReturnType<typeof parseMarkdownDocument>;
	try {
		parsedArticle = parseMarkdownDocument(articleFile.content);
	} catch {
		throw new ApiError(422, "ARTICLE_INVALID", "远端文章格式无效，无法生成影响预览。");
	}
	const resourceEntries = entries.filter(
		(entry) => entry.name !== dependencies.pathConfig.entryFilename,
	);
	if (enforceMoveSafety) validateResourceBudget(resourceEntries);
	const summarized = summarizeArticleAssets({
		storageSlug,
		frontmatterImage: parsedArticle.frontmatter.image,
		markdown: parsedArticle.markdown,
		entries: resourceEntries,
		pathConfig: dependencies.pathConfig,
	});
	if (!summarized.referenceAnalysis.complete || summarized.referenceAnalysis.issues.length > 0) {
		throw new ApiError(
			422,
			"MEDIA_REFERENCE_ANALYSIS_INCOMPLETE",
			"文章包含无法安全分析的本地资源引用，不能生成影响预览。",
		);
	}
	return {
		articlePath,
		bundlePath,
		articleFile,
		parsedArticle,
		resourceEntries,
		resources: summarized.resources,
	};
}

function createPreviewIdentity(dependencies: PreviewMediaTransactionDependencies) {
	const now = dependencies.now?.() ?? Date.now();
	return {
		previewId:
			dependencies.createPreviewId?.() ?? `preview_${crypto.randomUUID().replaceAll("-", "")}`,
		createdAt: new Date(now).toISOString(),
		expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
	};
}

async function previewRename(
	request: RenameMediaTransactionPreviewRequest,
	baseCommitSha: string,
	dependencies: PreviewMediaTransactionDependencies,
): Promise<MediaTransactionPreview> {
	const bundle = await readBundle(
		request.storageSlug,
		request.expectedArticleSha,
		baseCommitSha,
		dependencies,
		false,
	);
	const source = bundle.resources.find(
		(resource) =>
			getArticleResourceFilenameConflictKey(resource.filename) ===
			getArticleResourceFilenameConflictKey(request.sourceFilename),
	);
	if (!source || source.filename !== request.sourceFilename) {
		throw conflict("源资源不存在或文件名大小写已变化。");
	}
	if (source.blobSha !== request.expectedBlobSha) {
		throw conflict("源资源版本已变化，请重新加载后再预览。");
	}
	if (!source.mutable || source.policyLevel === "L2") {
		throw blocked("该资源当前不能安全重命名。");
	}
	if (
		bundle.resources.some(
			(resource) =>
				getArticleResourceFilenameConflictKey(resource.filename) ===
				getArticleResourceFilenameConflictKey(request.destinationFilename),
		)
	) {
		throw conflict("目标资源文件名已存在。");
	}
	const sourcePath = buildArticleResourcePath(
		request.storageSlug,
		request.sourceFilename,
		dependencies.pathConfig,
	);
	const destinationPath = buildArticleResourcePath(
		request.storageSlug,
		request.destinationFilename,
		dependencies.pathConfig,
	);
	const references = source.references.map((reference) =>
		createReferenceImpact(reference, `./${request.destinationFilename}`),
	);
	const effects: MediaTransactionPreviewEffect[] = [
		{
			type: "resource-reuse",
			repositoryPath: destinationPath,
			from: null,
			to: request.expectedBlobSha,
		},
		{
			type: "resource-delete",
			repositoryPath: sourcePath,
			from: request.expectedBlobSha,
			to: null,
		},
		...references.map((reference) => ({
			type: "reference-update" as const,
			repositoryPath: bundle.articlePath,
			from: reference.currentTarget,
			to: reference.proposedTarget,
		})),
	];
	const hasCoverReference = references.some(
		(reference) => reference.source === "frontmatter-image",
	);
	const riskReasons: MediaTransactionPreviewRiskReason[] = [];
	if (references.length > 0) riskReasons.push("resource-reference");
	if (hasCoverReference) riskReasons.push("cover-reference");
	const preview: MediaTransactionPreview = {
		version: 1,
		...createPreviewIdentity(dependencies),
		operation: "rename",
		storageSlug: request.storageSlug,
		baseCommitSha,
		expectedArticleSha: request.expectedArticleSha,
		expectedBlobSha: request.expectedBlobSha,
		source: {
			filename: request.sourceFilename,
			relativePath: `./${request.sourceFilename}`,
			repositoryPath: sourcePath,
		},
		destination: {
			filename: request.destinationFilename,
			relativePath: `./${request.destinationFilename}`,
			repositoryPath: destinationPath,
		},
		effects,
		references,
		referenceAnalysis: { complete: true, issues: [] },
		policyLevel: references.length > 0 ? "L1" : "L0",
		riskLevel: hasCoverReference ? "high" : references.length > 0 ? "medium" : "low",
		riskReasons,
		confirmation: hasCoverReference
			? { kind: "phrase", phrase: `重命名 ${request.sourceFilename}` }
			: { kind: "button" },
	};
	return parseMediaTransactionPreview(preview, dependencies.pathConfig);
}

async function previewMove(
	request: MoveMediaTransactionPreviewRequest,
	baseCommitSha: string,
	dependencies: PreviewMediaTransactionDependencies,
): Promise<MediaTransactionPreview> {
	const [sourceBundle, destinationBundle] = await Promise.all([
		readBundle(
			request.source.storageSlug,
			request.source.expectedArticleSha,
			baseCommitSha,
			dependencies,
			true,
		),
		readBundle(
			request.destination.storageSlug,
			request.destination.expectedArticleSha,
			baseCommitSha,
			dependencies,
			true,
		),
	]);
	const source = sourceBundle.resources.find(
		(resource) =>
			getArticleResourceFilenameConflictKey(resource.filename) ===
			getArticleResourceFilenameConflictKey(request.source.filename),
	);
	if (!source || source.filename !== request.source.filename) {
		throw conflict("源资源不存在或文件名大小写已变化。");
	}
	if (source.blobSha !== request.source.expectedBlobSha) {
		throw conflict("源资源版本已变化，请重新加载后再预览。");
	}
	const extension = getExtension(source.filename);
	if (
		!source.mutable ||
		source.policyLevel === "L2" ||
		!ALLOWED_MOVE_EXTENSIONS.has(extension) ||
		(source.kind !== "image" && source.kind !== "document")
	) {
		throw blocked("该资源当前不能安全移动。");
	}
	if (
		destinationBundle.resources.some(
			(resource) =>
				getArticleResourceFilenameConflictKey(resource.filename) ===
				getArticleResourceFilenameConflictKey(request.destination.filename),
		)
	) {
		throw conflict("目标文章已存在同名资源。");
	}
	if (source.size === null) throw blocked("源资源大小无法验证。");
	validateResourceBudget(destinationBundle.resourceEntries, source.size);

	const scanReferenceClosure =
		dependencies.scanReferenceClosure ?? scanMediaTransactionReferenceClosure;
	const closure: MediaTransactionReferenceClosure = await scanReferenceClosure(
		{
			baseCommitSha,
			source: {
				storageSlug: request.source.storageSlug,
				articleSha: request.source.expectedArticleSha,
				filename: request.source.filename,
			},
			destination: {
				storageSlug: request.destination.storageSlug,
				articleSha: request.destination.expectedArticleSha,
			},
		},
		{ gitProvider: dependencies.gitProvider, pathConfig: dependencies.pathConfig },
	);
	if (
		extension === "gif" &&
		[...closure.source.references, ...closure.destination.references].some(
			(reference) => reference.source === "frontmatter-image",
		)
	) {
		throw blocked("作为源文章封面的 GIF 不能跨文章移动。");
	}
	if (
		extension === "pdf" &&
		(closure.source.references.length > 0 || closure.destination.references.length > 0)
	) {
		throw blocked("仍被源文章或目标文章引用的 PDF 不能跨文章移动。");
	}

	const sourcePath = buildArticleResourcePath(
		request.source.storageSlug,
		request.source.filename,
		dependencies.pathConfig,
	);
	const destinationPath = buildArticleResourcePath(
		request.destination.storageSlug,
		request.destination.filename,
		dependencies.pathConfig,
	);
	const sourceProposedTarget = buildControlledArticleResourceReference(
		request.source.storageSlug,
		request.destination.storageSlug,
		request.destination.filename,
		dependencies.pathConfig,
	);
	const sourceReferences = closure.source.references.map((reference) =>
		createReferenceImpact(reference, sourceProposedTarget),
	);
	const destinationReferences = closure.destination.references.map((reference) =>
		createReferenceImpact(reference, `./${request.destination.filename}`),
	);
	const effects: MediaTransactionPreviewEffect[] = [
		{ type: "resource-reuse", repositoryPath: destinationPath, from: null, to: source.blobSha },
		{ type: "resource-delete", repositoryPath: sourcePath, from: source.blobSha, to: null },
		...sourceReferences.map((reference) => ({
			type: "reference-update" as const,
			repositoryPath: sourceBundle.articlePath,
			from: reference.currentTarget,
			to: reference.proposedTarget,
		})),
		...destinationReferences.map((reference) => ({
			type: "reference-update" as const,
			repositoryPath: destinationBundle.articlePath,
			from: reference.currentTarget,
			to: reference.proposedTarget,
		})),
	];
	const references = [...sourceReferences, ...destinationReferences];
	const hasCoverReference = references.some(
		(reference) => reference.source === "frontmatter-image",
	);
	const riskReasons: MediaTransactionPreviewRiskReason[] = ["cross-article-change"];
	if (references.length > 0) riskReasons.push("resource-reference");
	if (hasCoverReference) riskReasons.push("cover-reference");
	const preview: MediaTransactionPreview = {
		version: 1,
		...createPreviewIdentity(dependencies),
		operation: "move",
		baseCommitSha,
		source: {
			storageSlug: request.source.storageSlug,
			article: {
				expectedSha: request.source.expectedArticleSha,
				repositoryPath: sourceBundle.articlePath,
			},
			resource: {
				filename: request.source.filename,
				relativePath: `./${request.source.filename}`,
				repositoryPath: sourcePath,
				blobSha: source.blobSha,
			},
			references: sourceReferences,
		},
		destination: {
			storageSlug: request.destination.storageSlug,
			article: {
				expectedSha: request.destination.expectedArticleSha,
				repositoryPath: destinationBundle.articlePath,
			},
			resource: {
				filename: request.destination.filename,
				relativePath: `./${request.destination.filename}`,
				repositoryPath: destinationPath,
				blobSha: source.blobSha,
			},
			references: destinationReferences,
		},
		referenceClosure: {
			complete: true,
			scannedArticleCount: closure.scannedArticleCount,
			thirdPartyReferenceCount: 0,
		},
		effects,
		policyLevel: "L1",
		riskLevel: "high",
		riskReasons,
		confirmation: {
			kind: "phrase",
			phrase: `移动 ${request.source.filename} 到 ${request.destination.storageSlug}/${request.destination.filename}`,
		},
	};
	return parseMediaTransactionPreview(preview, dependencies.pathConfig);
}

/** 从同一不可变 HEAD 读取所有文章与 Page Bundle，生成不含 Git/R2 写能力的影响快照。 */
export async function previewMediaTransaction(
	input: unknown,
	dependencies: PreviewMediaTransactionDependencies,
): Promise<MediaTransactionPreview> {
	const request: MediaTransactionPreviewRequest = parseMediaTransactionPreviewRequest(input);
	if (
		!dependencies.pathConfig.usePageBundle ||
		dependencies.pathConfig.entryFilename !== "index.md"
	) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "资源影响预览仅支持固定 Page Bundle。");
	}
	const head = await dependencies.gitProvider.getHead();
	if (head.commitSha !== request.expectedHeadSha) {
		throw conflict("远端分支已变化，请重新加载文章后再预览。");
	}
	return request.operation === "rename"
		? previewRename(request, head.commitSha, dependencies)
		: previewMove(request, head.commitSha, dependencies);
}
