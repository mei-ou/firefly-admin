import { articleConfig } from "../../../config/articleConfig";
import { ApiError } from "../../../core/http/errors";
import {
	type ArticlePathConfig,
	buildArticlePath,
	buildArticleResourcePath,
} from "../../../core/security/path-policy";
import type { GitDirectoryEntry, GitProvider } from "../../../providers/git/types";
import type { ArticleDeleteResult } from "../../../types/article";
import { parseSlug } from "../../../utils/slug-utils";
import {
	ARTICLE_ASSET_IMAGE_MAX_BYTES,
	ARTICLE_ASSET_MAX_COUNT,
	ARTICLE_ASSET_TOTAL_MAX_BYTES,
} from "../../media/media-config";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
// 当前版本还没有独立的资源 provenance 清单，因此只接受上传服务派生的严格文件名。
// 这不是通用目录归属推断：任一未知名称、格式、预算或层级都会让整次删除失败关闭。
const ADMIN_IMAGE_FILENAME = /^([a-z0-9]+(?:-[a-z0-9]+)*)-([a-f0-9]{12})\.(jpg|png|webp)$/;

export interface ArticleDeletePlan {
	storageSlug: string;
	expectedHeadSha: string;
	articlePath: string;
	files: readonly { path: string; expectedSha: string }[];
}

export interface PrepareArticleDeleteDependencies {
	gitProvider: Pick<GitProvider, "getFileAtCommit" | "listDirectoryAtCommit">;
	pathConfig?: ArticlePathConfig;
}

export interface CommitArticleDeleteDependencies {
	gitProvider: Pick<GitProvider, "commitFilesAtomically">;
	checkpointCandidateCommit(commitSha: string): Promise<void>;
}

function parseExpectedSha(input: unknown, label: string): string {
	if (typeof input !== "string" || !GIT_OBJECT_SHA.test(input)) {
		throw new TypeError(`${label} SHA 无效。`);
	}
	return input;
}

function validateManagedImage(
	storageSlug: string,
	entry: GitDirectoryEntry,
	pathConfig: ArticlePathConfig,
): void {
	if (
		entry.type !== "file" ||
		entry.size === null ||
		entry.size > ARTICLE_ASSET_IMAGE_MAX_BYTES ||
		!ADMIN_IMAGE_FILENAME.test(entry.name) ||
		entry.path !== buildArticleResourcePath(storageSlug, entry.name, pathConfig)
	) {
		throw new ApiError(409, "CONFLICT", "文章目录包含无法安全归属的文件或子目录，已停止删除。");
	}
}

/**
 * 在同一个不可变 HEAD 上读取入口文件和 Page Bundle 直接子项。删除只接受入口文件，
 * 或服务端命名规则生成且满足轻量图片预算的直接子文件；任何未知文件、PDF、GIF 或子目录
 * 都会失败关闭，避免把文章删除接口扩大为任意目录递归删除。
 */
export async function prepareArticleDelete(
	storageSlugInput: unknown,
	expectedHeadShaInput: unknown,
	expectedArticleShaInput: unknown,
	dependencies: PrepareArticleDeleteDependencies,
): Promise<ArticleDeletePlan> {
	const storageSlug = parseSlug(storageSlugInput);
	const expectedHeadSha = parseExpectedSha(expectedHeadShaInput, "分支版本");
	const expectedArticleSha = parseExpectedSha(expectedArticleShaInput, "文章版本");
	const pathConfig = dependencies.pathConfig ?? articleConfig;
	const articlePath = buildArticlePath(storageSlug, pathConfig);
	const bundlePath = articlePath.slice(0, articlePath.lastIndexOf("/"));
	const [article, entries] = await Promise.all([
		dependencies.gitProvider.getFileAtCommit(articlePath, expectedHeadSha),
		dependencies.gitProvider.listDirectoryAtCommit(bundlePath, expectedHeadSha),
	]);
	if (article.path !== articlePath || article.sha !== expectedArticleSha) {
		throw new ApiError(409, "CONFLICT", "文章已经变化，请重新加载后再删除。");
	}

	const articleEntry = entries.find((entry) => entry.path === articlePath);
	if (
		articleEntry?.type !== "file" ||
		articleEntry.name !== pathConfig.entryFilename ||
		articleEntry.sha !== article.sha
	) {
		throw new ApiError(409, "CONFLICT", "文章目录快照与入口文件不一致，已停止删除。");
	}

	const resourceEntries = entries.filter((entry) => entry.path !== articlePath);
	if (resourceEntries.length > ARTICLE_ASSET_MAX_COUNT) {
		throw new ApiError(409, "CONFLICT", "文章目录超出轻量资源预算，已停止删除。");
	}
	let totalBytes = 0;
	for (const entry of resourceEntries) {
		validateManagedImage(storageSlug, entry, pathConfig);
		totalBytes += entry.size ?? 0;
	}
	if (totalBytes > ARTICLE_ASSET_TOTAL_MAX_BYTES) {
		throw new ApiError(409, "CONFLICT", "文章图片总量超出轻量资源预算，已停止删除。");
	}

	return {
		storageSlug,
		expectedHeadSha,
		articlePath,
		files: entries.map((entry) => ({ path: entry.path, expectedSha: entry.sha })),
	};
}

function normalizeDeleteResult(
	plan: ArticleDeletePlan,
	result: Awaited<ReturnType<GitProvider["commitFilesAtomically"]>>,
): ArticleDeleteResult {
	const expectedPaths = new Set(plan.files.map((file) => file.path));
	const returnedPaths = new Set(result.files.map((file) => file.path));
	if (
		returnedPaths.size !== result.files.length ||
		returnedPaths.size !== expectedPaths.size ||
		[...expectedPaths].some((path) => !returnedPaths.has(path)) ||
		result.files.some((file) => file.fileSha !== null)
	) {
		throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了不一致的文章删除结果。");
	}
	const bundlePrefix = plan.articlePath.slice(0, plan.articlePath.lastIndexOf("/") + 1);
	return {
		storageSlug: plan.storageSlug,
		pathAlias: `${plan.storageSlug}/index.md`,
		commitSha: result.commitSha,
		commitUrl: result.commitUrl,
		deletedFiles: plan.files.map(
			(file) => `${plan.storageSlug}/${file.path.slice(bundlePrefix.length)}`,
		),
	};
}

/** 只提交 prepare 阶段已经锁定的路径和 Blob SHA，不重新读取或扩大删除集合。 */
export async function commitArticleDelete(
	plan: ArticleDeletePlan,
	dependencies: CommitArticleDeleteDependencies,
): Promise<ArticleDeleteResult> {
	const result = await dependencies.gitProvider.commitFilesAtomically({
		expectedHeadSha: plan.expectedHeadSha,
		message: `docs(post): delete ${plan.storageSlug}`,
		files: plan.files.map((file) => ({
			operation: "delete" as const,
			path: file.path,
			expectedSha: file.expectedSha,
		})),
		checkpointCandidateCommit: dependencies.checkpointCandidateCommit,
	});
	return normalizeDeleteResult(plan, result);
}
