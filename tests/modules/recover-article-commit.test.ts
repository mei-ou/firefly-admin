import { describe, expect, it, vi } from "vitest";
import { recoverArticleCommit } from "../../src/modules/articles/services/recover-article-commit";
import type { GitProvider } from "../../src/providers/git/types";

const CANDIDATE_SHA = "a".repeat(40);
const FILE_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const repositoryPath = "src/content/posts/hello-world/index.md";
const commitUrl = `https://github.com/owner/repo/commit/${CANDIDATE_SHA}`;

function createProvider(overrides: Partial<Pick<GitProvider, "getFileAtCommit" | "getHead">> = {}) {
	return {
		getHead:
			overrides.getHead ??
			vi.fn<GitProvider["getHead"]>().mockResolvedValue({
				commitSha: CANDIDATE_SHA,
				commitUrl,
				treeSha: TREE_SHA,
			}),
		getFileAtCommit:
			overrides.getFileAtCommit ??
			vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
				path: repositoryPath,
				sha: FILE_SHA,
				content: "# recovered\n",
				encoding: "utf-8",
			}),
	};
}

describe("文章 unknown Commit 只读恢复", () => {
	it("候选 Commit 是当前 HEAD 时从不可变快照重建结果", async () => {
		const provider = createProvider();

		await expect(
			recoverArticleCommit("hello-world", CANDIDATE_SHA, {
				gitProvider: provider,
				pathConfig: {
					contentRoot: "src/content/posts",
					entryFilename: "index.md",
					usePageBundle: true,
				},
			}),
		).resolves.toEqual({
			storageSlug: "hello-world",
			pathAlias: "hello-world/index.md",
			commitSha: CANDIDATE_SHA,
			commitUrl,
			fileSha: FILE_SHA,
		});
		expect(provider.getFileAtCommit).toHaveBeenCalledWith(repositoryPath, CANDIDATE_SHA);
	});

	it("HEAD 不等于候选 Commit 时无法证明且不读取文件", async () => {
		const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>();
		const provider = createProvider({
			getHead: vi.fn<GitProvider["getHead"]>().mockResolvedValue({
				commitSha: "d".repeat(40),
				commitUrl: `https://github.com/owner/repo/commit/${"d".repeat(40)}`,
				treeSha: TREE_SHA,
			}),
			getFileAtCommit,
		});

		await expect(
			recoverArticleCommit("hello-world", CANDIDATE_SHA, { gitProvider: provider }),
		).resolves.toBeUndefined();
		expect(getFileAtCommit).not.toHaveBeenCalled();
	});

	it("缺少合法 candidate 或可信 Commit URL 时失败关闭", async () => {
		const provider = createProvider({
			getHead: vi.fn<GitProvider["getHead"]>().mockResolvedValue({
				commitSha: CANDIDATE_SHA,
				treeSha: TREE_SHA,
			}),
		});

		await expect(
			recoverArticleCommit("hello-world", undefined, { gitProvider: provider }),
		).resolves.toBeUndefined();
		expect(provider.getHead).not.toHaveBeenCalled();
		await expect(
			recoverArticleCommit("hello-world", CANDIDATE_SHA, { gitProvider: provider }),
		).resolves.toBeUndefined();
		expect(provider.getFileAtCommit).not.toHaveBeenCalled();
	});
});
