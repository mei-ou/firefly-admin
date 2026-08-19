import { articleConfig } from "../../../config/articleConfig";
import { ApiError } from "../../../core/http/errors";
import {
	type ArticlePathConfig,
	buildArticlePath,
	buildArticleResourcePath,
	parseArticleResourceReference,
} from "../../../core/security/path-policy";
import type { AtomicGitFileChange, GitProvider } from "../../../providers/git/types";
import type { ArticleCommitResult } from "../../../types/article";
import { buildMarkdownDocument } from "../../../utils/frontmatter-utils";
import { parseSlug } from "../../../utils/slug-utils";
import type { LoadedArticleAsset } from "../../media/services/load-staged-article-assets";
import type { ArticleResourceChange } from "../article-resource-changes";
import { parseArticleEditorInput } from "../article-schema";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;

export interface WriteArticleDependencies {
	gitProvider: Pick<GitProvider, "commitFilesAtomically">;
	pathConfig?: ArticlePathConfig;
	assets?: readonly LoadedArticleAsset[];
	resourceChanges?: readonly ArticleResourceChange[];
	checkpointCandidateCommit(commitSha: string): Promise<void>;
}

function createWriteContext(
	storageSlugInput: unknown,
	editorInput: unknown,
	pathConfig?: ArticlePathConfig,
) {
	const storageSlug = parseSlug(storageSlugInput);
	const path = buildArticlePath(storageSlug, pathConfig ?? articleConfig);
	const article = parseArticleEditorInput(editorInput);
	const content = buildMarkdownDocument(article.frontmatter, article.markdown, article.slug);
	return { storageSlug, path, content, coverReference: article.frontmatter.image };
}

function parseExpectedSha(input: unknown): string {
	if (typeof input !== "string" || !GIT_OBJECT_SHA.test(input)) {
		throw new TypeError("文章版本 SHA 无效。");
	}
	return input;
}

function validateLoadedAsset(
	storageSlug: string,
	asset: LoadedArticleAsset,
	pathConfig: ArticlePathConfig,
): void {
	const relativePath = parseArticleResourceReference(asset.relativePath);
	if (relativePath !== `./${asset.finalFilename}`) {
		throw new TypeError("文章资源相对路径与文件名不一致。");
	}
	const repositoryPath = buildArticleResourcePath(storageSlug, asset.finalFilename, pathConfig);
	if (repositoryPath !== asset.repositoryPath) {
		throw new TypeError("文章资源仓库路径无效或重复。");
	}
}

function normalizeAssets(
	storageSlug: string,
	assets: readonly LoadedArticleAsset[],
	pathConfig: ArticlePathConfig,
	replacementAssetIds: ReadonlySet<string> = new Set(),
) {
	const seenPaths = new Set<string>();
	return assets.flatMap((asset) => {
		validateLoadedAsset(storageSlug, asset, pathConfig);
		if (replacementAssetIds.has(asset.assetId)) return [];
		if (seenPaths.has(asset.repositoryPath)) {
			throw new TypeError("文章资源仓库路径无效或重复。");
		}
		seenPaths.add(asset.repositoryPath);
		return [{ path: asset.repositoryPath, content: asset.content, expectedSha: null } as const];
	});
}

function filenameExtension(filename: string): string {
	return filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
}

function validateCoverAssetBinding(
	coverReference: string,
	assets: readonly LoadedArticleAsset[],
): void {
	const stagedCovers = assets.filter((asset) => asset.role === "cover");
	if (stagedCovers.length > 1) {
		throw new TypeError("每篇文章最多只能有一个暂存封面资源。");
	}
	const stagedCover = stagedCovers[0];
	if (stagedCover && coverReference !== stagedCover.relativePath) {
		throw new TypeError("暂存封面资源与 Frontmatter image 不一致。");
	}
}

function validateCoverResourceChanges(
	coverReference: string,
	changes: readonly ArticleResourceChange[],
): void {
	if (!coverReference.startsWith("./")) return;
	const coverFilename = parseArticleResourceReference(coverReference).slice(2);
	if (
		changes.some(
			(change) =>
				change.filename === coverFilename &&
				(change.operation === "delete" || change.operation === "move"),
		)
	) {
		throw new TypeError("当前封面不能在同一次提交中删除或移动；请先替换或移除封面引用。");
	}
}

function normalizeResourceChanges(
	storageSlug: string,
	changes: readonly ArticleResourceChange[],
	assets: readonly LoadedArticleAsset[],
	pathConfig: ArticlePathConfig,
	reservedPaths: ReadonlySet<string>,
): AtomicGitFileChange[] {
	const seenPaths = new Set<string>(reservedPaths);
	const assetsById = new Map(assets.map((asset) => [asset.assetId.toLowerCase(), asset]));
	return changes.flatMap<AtomicGitFileChange>((change) => {
		const path = buildArticleResourcePath(storageSlug, change.filename, pathConfig);
		if (seenPaths.has(path)) {
			throw new TypeError("文章资源变更路径与其他提交文件重复。");
		}
		seenPaths.add(path);
		if (change.operation === "delete") {
			return [
				{
					operation: "delete" as const,
					path,
					expectedSha: parseExpectedSha(change.expectedSha),
				},
			];
		}
		if (change.operation === "move") {
			const destinationPath = buildArticleResourcePath(
				storageSlug,
				change.destinationFilename,
				pathConfig,
			);
			if (seenPaths.has(destinationPath)) {
				throw new TypeError("文章资源移动目标与其他提交文件重复。");
			}
			seenPaths.add(destinationPath);
			const expectedSha = parseExpectedSha(change.expectedSha);
			return [
				{
					operation: "reuse" as const,
					path: destinationPath,
					expectedSha: null,
					fileSha: expectedSha,
				},
				{ operation: "delete" as const, path, expectedSha },
			];
		}
		const asset = assetsById.get(change.assetId.toLowerCase());
		if (!asset) throw new TypeError("文章资源替换引用的暂存对象不存在。");
		validateLoadedAsset(storageSlug, asset, pathConfig);
		if (filenameExtension(change.filename) !== filenameExtension(asset.finalFilename)) {
			throw new TypeError("文章资源替换的文件扩展名不兼容。");
		}
		return [
			{
				operation: "write" as const,
				path,
				content: asset.content,
				expectedSha: parseExpectedSha(change.expectedSha),
			},
		];
	});
}

function normalizeCommitResult(
	storageSlug: string,
	expectedArticlePath: string,
	expectedPaths: ReadonlySet<string>,
	result: Awaited<ReturnType<GitProvider["commitFilesAtomically"]>>,
): ArticleCommitResult {
	const file = result.files.find((entry) => entry.path === expectedArticlePath);
	const returnedPaths = new Set(result.files.map((entry) => entry.path));
	if (
		!file ||
		file.fileSha === null ||
		returnedPaths.size !== result.files.length ||
		returnedPaths.size !== expectedPaths.size ||
		[...expectedPaths].some((path) => !returnedPaths.has(path))
	) {
		throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了不一致的文章路径。");
	}

	return {
		storageSlug,
		pathAlias: `${storageSlug}/index.md`,
		commitSha: result.commitSha,
		commitUrl: result.commitUrl,
		fileSha: file.fileSha,
	};
}

/**
 * 创建文章。客户端不能提供仓库路径、分支或提交信息；这些值由服务端根据已验证的
 * storage slug 生成。幂等键和写入限流属于未来 API 编排层，不在 Provider 契约中伪造。
 */
export async function createArticle(
	storageSlugInput: unknown,
	expectedHeadShaInput: unknown,
	editorInput: unknown,
	dependencies: WriteArticleDependencies,
): Promise<ArticleCommitResult> {
	const pathConfig = dependencies.pathConfig ?? articleConfig;
	const context = createWriteContext(storageSlugInput, editorInput, pathConfig);
	const expectedHeadSha = parseExpectedSha(expectedHeadShaInput);
	const assets = dependencies.assets ?? [];
	validateCoverAssetBinding(context.coverReference, assets);
	const assetFiles = normalizeAssets(context.storageSlug, assets, pathConfig);
	const files = [
		{ path: context.path, content: context.content, expectedSha: null },
		...assetFiles,
	];
	const result = await dependencies.gitProvider.commitFilesAtomically({
		expectedHeadSha,
		message: `feat(post): add ${context.storageSlug}`,
		files,
		checkpointCandidateCommit: dependencies.checkpointCandidateCommit,
	});
	return normalizeCommitResult(
		context.storageSlug,
		context.path,
		new Set(files.map((file) => file.path)),
		result,
	);
}

/**
 * 更新文章时强制携带读取阶段保存的 Blob SHA。服务层不会先读取新 SHA 后重试，发生
 * 并发冲突时由 Provider 返回 409，避免静默覆盖其他编辑者或仓库中的新内容。
 */
export async function updateArticle(
	storageSlugInput: unknown,
	expectedHeadShaInput: unknown,
	expectedShaInput: unknown,
	editorInput: unknown,
	dependencies: WriteArticleDependencies,
): Promise<ArticleCommitResult> {
	const pathConfig = dependencies.pathConfig ?? articleConfig;
	const context = createWriteContext(storageSlugInput, editorInput, pathConfig);
	const expectedHeadSha = parseExpectedSha(expectedHeadShaInput);
	const expectedSha = parseExpectedSha(expectedShaInput);
	const assets = dependencies.assets ?? [];
	const resourceChanges = dependencies.resourceChanges ?? [];
	validateCoverAssetBinding(context.coverReference, assets);
	validateCoverResourceChanges(context.coverReference, resourceChanges);
	const replacementAssetIds = new Set(
		resourceChanges
			.filter((change) => change.operation === "replace")
			.map((change) => change.assetId.toLowerCase()),
	);
	const assetFiles = normalizeAssets(context.storageSlug, assets, pathConfig, replacementAssetIds);
	const reservedPaths = new Set([context.path, ...assetFiles.map((file) => file.path)]);
	const resourceChangeFiles = normalizeResourceChanges(
		context.storageSlug,
		resourceChanges,
		assets,
		pathConfig,
		reservedPaths,
	);
	const files = [
		{ path: context.path, content: context.content, expectedSha },
		...assetFiles,
		...resourceChangeFiles,
	];
	const result = await dependencies.gitProvider.commitFilesAtomically({
		expectedHeadSha,
		message: `docs(post): update ${context.storageSlug}`,
		files,
		checkpointCandidateCommit: dependencies.checkpointCandidateCommit,
	});
	return normalizeCommitResult(
		context.storageSlug,
		context.path,
		new Set(files.map((file) => file.path)),
		result,
	);
}
