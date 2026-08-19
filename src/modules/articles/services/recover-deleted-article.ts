import { articleConfig } from "../../../config/articleConfig";
import { ApiError } from "../../../core/http/errors";
import { type ArticlePathConfig, buildArticlePath } from "../../../core/security/path-policy";
import type { GitProvider } from "../../../providers/git/types";
import type { ArticleDeleteResult } from "../../../types/article";
import { parseSlug } from "../../../utils/slug-utils";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;

export interface RecoverDeletedArticleDependencies {
	gitProvider: Pick<GitProvider, "getHead" | "listDirectoryAtCommit">;
	pathConfig?: ArticlePathConfig;
}

function parseCommitSha(input: unknown): string | undefined {
	return typeof input === "string" && GIT_OBJECT_SHA.test(input) ? input : undefined;
}

/**
 * 删除恢复只执行不可变快照读取：候选 Commit 必须是当前 HEAD，且目标 Page Bundle 在候选
 * Commit 中必须完整不存在。删除清单从原始基线 Commit 重建，避免信任浏览器回传路径。
 */
export async function recoverDeletedArticle(
	storageSlugInput: unknown,
	baseHeadShaInput: unknown,
	candidateCommitShaInput: unknown,
	dependencies: RecoverDeletedArticleDependencies,
): Promise<ArticleDeleteResult | undefined> {
	const storageSlug = parseSlug(storageSlugInput);
	const baseHeadSha = parseCommitSha(baseHeadShaInput);
	const candidateCommitSha = parseCommitSha(candidateCommitShaInput);
	if (!baseHeadSha || !candidateCommitSha) return undefined;

	const head = await dependencies.gitProvider.getHead();
	if (head.commitSha !== candidateCommitSha || !head.commitUrl) return undefined;
	const articlePath = buildArticlePath(storageSlug, dependencies.pathConfig ?? articleConfig);
	const bundlePath = articlePath.slice(0, articlePath.lastIndexOf("/"));
	const originalEntries = await dependencies.gitProvider.listDirectoryAtCommit(
		bundlePath,
		baseHeadSha,
	);
	try {
		await dependencies.gitProvider.listDirectoryAtCommit(bundlePath, candidateCommitSha);
		return undefined;
	} catch (error) {
		if (!(error instanceof ApiError) || error.status !== 404 || error.code !== "NOT_FOUND") {
			throw error;
		}
	}

	const bundlePrefix = `${bundlePath}/`;
	if (
		originalEntries.length === 0 ||
		!originalEntries.some((entry) => entry.path === articlePath) ||
		originalEntries.some((entry) => !entry.path.startsWith(bundlePrefix))
	) {
		return undefined;
	}
	return {
		storageSlug,
		pathAlias: `${storageSlug}/index.md`,
		commitSha: head.commitSha,
		commitUrl: head.commitUrl,
		deletedFiles: originalEntries.map(
			(entry) => `${storageSlug}/${entry.path.slice(bundlePrefix.length)}`,
		),
	};
}
