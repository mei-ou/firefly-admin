import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import {
	commitArticleDelete,
	prepareArticleDelete,
} from "../../src/modules/articles/services/delete-article";
import { recoverDeletedArticle } from "../../src/modules/articles/services/recover-deleted-article";
import type { GitDirectoryEntry, GitProvider } from "../../src/providers/git/types";

const HEAD_SHA = "a".repeat(40);
const ARTICLE_SHA = "b".repeat(40);
const IMAGE_SHA = "c".repeat(40);
const COMMIT_SHA = "d".repeat(40);
const articlePath = "src/content/posts/hello-world/index.md";
const imagePath = "src/content/posts/hello-world/cover-123e4567e89b.png";
const config = { contentRoot: "src/content/posts", usePageBundle: true, entryFilename: "index.md" };
const entries = [
	{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file" as const, size: 512 },
	{
		name: "cover-123e4567e89b.png",
		path: imagePath,
		sha: IMAGE_SHA,
		type: "file" as const,
		size: 1024,
	},
];

function createReadProvider(customEntries: readonly GitDirectoryEntry[] = entries) {
	return {
		getFileAtCommit: vi.fn().mockResolvedValue({
			path: articlePath,
			sha: ARTICLE_SHA,
			content: "# test\n",
			encoding: "utf-8" as const,
		}),
		listDirectoryAtCommit: vi.fn().mockResolvedValue(customEntries),
	};
}

describe("文章删除服务", () => {
	it("从同一 HEAD 派生入口和后台小图删除计划", async () => {
		const provider = createReadProvider();
		const plan = await prepareArticleDelete("hello-world", HEAD_SHA, ARTICLE_SHA, {
			gitProvider: provider,
			pathConfig: config,
		});

		expect(provider.getFileAtCommit).toHaveBeenCalledWith(articlePath, HEAD_SHA);
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledWith(
			"src/content/posts/hello-world",
			HEAD_SHA,
		);
		expect(plan.files).toEqual([
			{ path: articlePath, expectedSha: ARTICLE_SHA },
			{ path: imagePath, expectedSha: IMAGE_SHA },
		]);
	});

	it.each([
		[
			"未知文件",
			[
				{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file" as const, size: 512 },
				{
					name: "manual.png",
					path: "src/content/posts/hello-world/manual.png",
					sha: IMAGE_SHA,
					type: "file" as const,
					size: 12,
				},
			],
		],
		[
			"PDF",
			[
				{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file" as const, size: 512 },
				{
					name: "guide-123e4567e89b.pdf",
					path: "src/content/posts/hello-world/guide-123e4567e89b.pdf",
					sha: IMAGE_SHA,
					type: "file" as const,
					size: 12,
				},
			],
		],
		[
			"子目录",
			[
				{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file" as const, size: 512 },
				{
					name: "assets",
					path: "src/content/posts/hello-world/assets",
					sha: IMAGE_SHA,
					type: "directory" as const,
					size: null,
				},
			],
		],
	] as const)("遇到%s时失败关闭", async (_label, unsafeEntries) => {
		const provider = createReadProvider([...unsafeEntries]);
		await expect(
			prepareArticleDelete("hello-world", HEAD_SHA, ARTICLE_SHA, {
				gitProvider: provider,
				pathConfig: config,
			}),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
	});

	it("文章 Blob 已变化时拒绝产生删除计划", async () => {
		const provider = createReadProvider();
		await expect(
			prepareArticleDelete("hello-world", HEAD_SHA, "e".repeat(40), {
				gitProvider: provider,
				pathConfig: config,
			}),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
	});

	it("用每个 Blob SHA 原子删除并严格核对 null 结果", async () => {
		const checkpoint = vi.fn().mockResolvedValue(undefined);
		const commitFilesAtomically = vi
			.fn<GitProvider["commitFilesAtomically"]>()
			.mockImplementation(async (input) => {
				await input.checkpointCandidateCommit(COMMIT_SHA);
				return {
					commitSha: COMMIT_SHA,
					commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
					files: [
						{ path: articlePath, fileSha: null },
						{ path: imagePath, fileSha: null },
					],
				};
			});
		const plan = {
			storageSlug: "hello-world",
			expectedHeadSha: HEAD_SHA,
			articlePath,
			files: [
				{ path: articlePath, expectedSha: ARTICLE_SHA },
				{ path: imagePath, expectedSha: IMAGE_SHA },
			],
		};
		const result = await commitArticleDelete(plan, {
			gitProvider: { commitFilesAtomically },
			checkpointCandidateCommit: checkpoint,
		});

		expect(commitFilesAtomically).toHaveBeenCalledWith({
			expectedHeadSha: HEAD_SHA,
			message: "docs(post): delete hello-world",
			files: [
				{ operation: "delete", path: articlePath, expectedSha: ARTICLE_SHA },
				{ operation: "delete", path: imagePath, expectedSha: IMAGE_SHA },
			],
			checkpointCandidateCommit: checkpoint,
		});
		expect(result.deletedFiles).toEqual([
			"hello-world/index.md",
			"hello-world/cover-123e4567e89b.png",
		]);
	});

	it("Provider 返回写入 SHA 或缺失路径时拒绝接受结果", async () => {
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [{ path: articlePath, fileSha: ARTICLE_SHA }],
		});
		await expect(
			commitArticleDelete(
				{
					storageSlug: "hello-world",
					expectedHeadSha: HEAD_SHA,
					articlePath,
					files: [{ path: articlePath, expectedSha: ARTICLE_SHA }],
				},
				{ gitProvider: { commitFilesAtomically }, checkpointCandidateCommit: vi.fn() },
			),
		).rejects.toMatchObject({ status: 502, code: "UPSTREAM_ERROR" });
	});

	it("候选 Commit 已成为 HEAD 且 Bundle 不存在时只读恢复", async () => {
		const listDirectoryAtCommit = vi.fn(async (_path: string, commitSha: string) => {
			if (commitSha === HEAD_SHA) return entries;
			throw new ApiError(404, "NOT_FOUND", "远端文件不存在。");
		});
		const recovered = await recoverDeletedArticle("hello-world", HEAD_SHA, COMMIT_SHA, {
			gitProvider: {
				getHead: vi.fn().mockResolvedValue({
					commitSha: COMMIT_SHA,
					commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
					treeSha: "f".repeat(40),
				}),
				listDirectoryAtCommit,
			},
			pathConfig: config,
		});
		expect(recovered?.deletedFiles).toHaveLength(2);
	});

	it("候选不是 HEAD 或 Bundle 仍存在时保持 unknown", async () => {
		for (const [headSha, candidateEntries] of [
			[HEAD_SHA, entries],
			[COMMIT_SHA, entries],
		] as const) {
			const recovered = await recoverDeletedArticle("hello-world", HEAD_SHA, COMMIT_SHA, {
				gitProvider: {
					getHead: vi.fn().mockResolvedValue({
						commitSha: headSha,
						commitUrl: `https://github.com/owner/repo/commit/${headSha}`,
						treeSha: "f".repeat(40),
					}),
					listDirectoryAtCommit: vi.fn().mockResolvedValue(candidateEntries),
				},
				pathConfig: config,
			});
			expect(recovered).toBeUndefined();
		}
	});
});
