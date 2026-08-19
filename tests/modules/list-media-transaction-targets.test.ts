import { describe, expect, it, vi } from "vitest";
import { listMediaTransactionTargets } from "../../src/modules/media/services/list-media-transaction-targets";
import type { GitProvider } from "../../src/providers/git/types";
import { buildMarkdownDocument } from "../../src/utils/frontmatter-utils";

const HEAD_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const TARGET_SHA = "c".repeat(40);
const contentRoot = "src/content/posts";
const pathConfig = { contentRoot, entryFilename: "index.md", usePageBundle: true };

function article(title: string): string {
	return buildMarkdownDocument(
		{ title, published: new Date("2026-08-17T00:00:00.000Z") },
		"正文\n",
	);
}

function createProvider(headSha = HEAD_SHA) {
	const getHead = vi.fn<GitProvider["getHead"]>().mockResolvedValue({
		commitSha: headSha,
		treeSha: "d".repeat(40),
	});
	const listDirectoryAtCommit = vi.fn<GitProvider["listDirectoryAtCommit"]>().mockResolvedValue([
		{
			name: "source-post",
			path: `${contentRoot}/source-post`,
			sha: "1".repeat(40),
			type: "directory",
			size: null,
		},
		{
			name: "target-post",
			path: `${contentRoot}/target-post`,
			sha: "2".repeat(40),
			type: "directory",
			size: null,
		},
	]);
	const getFileAtCommit = vi
		.fn<GitProvider["getFileAtCommit"]>()
		.mockImplementation(async (path, commitSha) => {
			expect(commitSha).toBe(HEAD_SHA);
			const source = path.endsWith("/source-post/index.md");
			return {
				path,
				sha: source ? SOURCE_SHA : TARGET_SHA,
				content: article(source ? "源文章" : "目标文章"),
				encoding: "utf-8",
			};
		});
	return { getHead, listDirectoryAtCommit, getFileAtCommit };
}

const request = {
	expectedHeadSha: HEAD_SHA,
	source: { storageSlug: "source-post", articleSha: SOURCE_SHA },
};

describe("媒体事务目标快照服务", () => {
	it("只从同一 HEAD Commit 读取并排除源文章", async () => {
		const provider = createProvider();
		const result = await listMediaTransactionTargets(request, {
			gitProvider: provider,
			pathConfig,
		});
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledWith(contentRoot, HEAD_SHA);
		expect(provider.getFileAtCommit).toHaveBeenCalledTimes(2);
		expect(result).toEqual({
			baseCommitSha: HEAD_SHA,
			source: request.source,
			items: [{ storageSlug: "target-post", articleSha: TARGET_SHA, title: "目标文章" }],
			truncated: false,
		});
		expect(result.items).not.toContainEqual(
			expect.objectContaining({ storageSlug: "source-post" }),
		);
	});

	it("HEAD 或源文章 SHA 变化时返回冲突", async () => {
		await expect(
			listMediaTransactionTargets(request, {
				gitProvider: createProvider("f".repeat(40)),
				pathConfig,
			}),
		).rejects.toMatchObject({ status: 409, code: "MEDIA_PREVIEW_CONFLICT" });

		const provider = createProvider();
		provider.getFileAtCommit.mockImplementation(async (path) => ({
			path,
			sha: "f".repeat(40),
			content: article("文章"),
			encoding: "utf-8",
		}));
		await expect(
			listMediaTransactionTargets(request, { gitProvider: provider, pathConfig }),
		).rejects.toMatchObject({ status: 409, code: "MEDIA_PREVIEW_CONFLICT" });
	});

	it("文章缺失、路径漂移或解析失败时失败关闭", async () => {
		for (const file of [
			{ path: "README.md", sha: SOURCE_SHA, content: article("漂移"), encoding: "utf-8" as const },
			{
				path: `${contentRoot}/source-post/index.md`,
				sha: SOURCE_SHA,
				content: "invalid",
				encoding: "utf-8" as const,
			},
		]) {
			const provider = createProvider();
			provider.getFileAtCommit.mockResolvedValue(file);
			await expect(
				listMediaTransactionTargets(request, { gitProvider: provider, pathConfig }),
			).rejects.toMatchObject({ status: 422, code: "MEDIA_REFERENCE_CLOSURE_INCOMPLETE" });
		}
	});
});
