import { articleConfig } from "../../../config/articleConfig";
import { type ArticlePathConfig, buildArticlePath } from "../../../core/security/path-policy";
import type { GitProvider } from "../../../providers/git/types";
import type { ArticleCommitResult } from "../../../types/article";
import { parseSlug } from "../../../utils/slug-utils";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;

export interface RecoverArticleCommitDependencies {
	gitProvider: Pick<GitProvider, "getFileAtCommit" | "getHead">;
	pathConfig?: ArticlePathConfig;
}

/**
 * 只在候选 Commit 已成为当前分支 HEAD 时重建文章写入结果。任何缺失检查点或 HEAD
 * 不匹配都表示无法证明原提交成功，调用方必须继续保持 unknown，不能自动再次提交。
 */
export async function recoverArticleCommit(
	storageSlugInput: unknown,
	candidateCommitShaInput: unknown,
	dependencies: RecoverArticleCommitDependencies,
): Promise<ArticleCommitResult | undefined> {
	const storageSlug = parseSlug(storageSlugInput);
	if (
		typeof candidateCommitShaInput !== "string" ||
		!GIT_OBJECT_SHA.test(candidateCommitShaInput)
	) {
		return undefined;
	}

	const head = await dependencies.gitProvider.getHead();
	if (head.commitSha !== candidateCommitShaInput || !head.commitUrl) {
		return undefined;
	}

	const path = buildArticlePath(storageSlug, dependencies.pathConfig ?? articleConfig);
	const file = await dependencies.gitProvider.getFileAtCommit(path, candidateCommitShaInput);
	if (file.path !== path) {
		return undefined;
	}

	return {
		storageSlug,
		pathAlias: `${storageSlug}/index.md`,
		commitSha: head.commitSha,
		commitUrl: head.commitUrl,
		fileSha: file.sha,
	};
}
