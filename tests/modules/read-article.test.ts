import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import { readArticle } from "../../src/modules/articles/services/read-article";
import type { GitProvider } from "../../src/providers/git/types";
import { buildMarkdownDocument } from "../../src/utils/frontmatter-utils";

const FILE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const repositoryPath = "src/content/posts/hello-world/index.md";
const frontmatter = {
	title: "你好，Firefly",
	published: new Date("2026-08-12T00:00:00.000Z"),
	description: "安全读取文章",
	tags: ["Firefly"],
};

function createGitProvider(getFile: GitProvider["getFile"]): Pick<GitProvider, "getFile"> {
	return { getFile };
}

describe("文章读取服务", () => {
	it("按服务端路径读取并返回编辑器所需的归一化文章", async () => {
		const getFile = vi.fn<GitProvider["getFile"]>().mockResolvedValue({
			path: repositoryPath,
			sha: FILE_SHA,
			encoding: "utf-8",
			content: buildMarkdownDocument(frontmatter, "# 正文\n", "custom-public-slug"),
		});

		const article = await readArticle("hello-world", {
			gitProvider: createGitProvider(getFile),
		});

		expect(getFile).toHaveBeenCalledWith(repositoryPath);
		expect(article).toMatchObject({
			storageSlug: "hello-world",
			pathAlias: "hello-world/index.md",
			sha: FILE_SHA,
			slug: "custom-public-slug",
			format: "md",
			markdown: "# 正文\n",
			frontmatter: {
				title: "你好，Firefly",
				description: "安全读取文章",
				draft: true,
			},
		});
	});

	it("详情模式按同一不可变 Commit 读取并返回 HEAD 基线", async () => {
		const getFile = vi.fn<GitProvider["getFile"]>();
		const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
			path: repositoryPath,
			sha: FILE_SHA,
			encoding: "utf-8",
			content: buildMarkdownDocument(frontmatter, "# 快照正文\n", "public-url"),
		});
		const getHead = vi.fn<GitProvider["getHead"]>().mockResolvedValue({
			commitSha: HEAD_SHA,
			treeSha: TREE_SHA,
		});
		const listDirectoryAtCommit = vi.fn<GitProvider["listDirectoryAtCommit"]>().mockResolvedValue([
			{
				name: "z-guide.pdf",
				path: "src/content/posts/hello-world/z-guide.pdf",
				sha: "d".repeat(40),
				type: "file",
				size: 4_096,
			},
			{ name: "index.md", path: repositoryPath, sha: FILE_SHA, type: "file", size: 1_024 },
			{
				name: "cover.webp",
				path: "src/content/posts/hello-world/cover.webp",
				sha: "e".repeat(40),
				type: "file",
				size: 2_048,
			},
		]);

		const article = await readArticle("hello-world", {
			gitProvider: { getFile, getFileAtCommit, getHead, listDirectoryAtCommit },
			requireHeadSnapshot: true,
		});

		expect(getHead).toHaveBeenCalledOnce();
		expect(getFileAtCommit).toHaveBeenCalledWith(repositoryPath, HEAD_SHA);
		expect(listDirectoryAtCommit).toHaveBeenCalledWith("src/content/posts/hello-world", HEAD_SHA);
		expect(getFile).not.toHaveBeenCalled();
		expect(article).toMatchObject({
			headSha: HEAD_SHA,
			markdown: "# 快照正文\n",
			resources: [
				{
					filename: "cover.webp",
					blobSha: "e".repeat(40),
					size: 2_048,
					contentType: "image/webp",
					policyLevel: "L0",
				},
				{
					filename: "z-guide.pdf",
					blobSha: "d".repeat(40),
					size: 4_096,
					contentType: "application/pdf",
					policyLevel: "L0",
				},
			],
			resourceReferenceAnalysis: { complete: true, issues: [] },
		});
	});

	it("关闭资源详情时仍按同一 HEAD 读取文章但跳过目录扫描", async () => {
		const getFile = vi.fn<GitProvider["getFile"]>();
		const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
			path: repositoryPath,
			sha: FILE_SHA,
			encoding: "utf-8",
			content: buildMarkdownDocument(frontmatter, "# 轻量正文\n"),
		});
		const getHead = vi.fn<GitProvider["getHead"]>().mockResolvedValue({
			commitSha: HEAD_SHA,
			treeSha: TREE_SHA,
		});
		const listDirectoryAtCommit = vi.fn<GitProvider["listDirectoryAtCommit"]>();
		const article = await readArticle("hello-world", {
			gitProvider: { getFile, getFileAtCommit, getHead, listDirectoryAtCommit },
			requireHeadSnapshot: true,
			includeAssetDetails: false,
		});
		expect(article).toMatchObject({ headSha: HEAD_SHA, markdown: "# 轻量正文\n" });
		expect(article.resources).toBeUndefined();
		expect(article.resourceReferenceAnalysis).toBeUndefined();
		expect(getHead).toHaveBeenCalledOnce();
		expect(getFileAtCommit).toHaveBeenCalledWith(repositoryPath, HEAD_SHA);
		expect(listDirectoryAtCommit).not.toHaveBeenCalled();
	});

	it("详情模式缺少一致性读取能力时失败关闭", async () => {
		const getFile = vi.fn<GitProvider["getFile"]>();

		await expect(
			readArticle("hello-world", {
				gitProvider: { getFile },
				requireHeadSnapshot: true,
			}),
		).rejects.toMatchObject({ status: 503, code: "CONFIGURATION_ERROR" });
		expect(getFile).not.toHaveBeenCalled();
	});

	it("区分文件存储 slug 与 Frontmatter 自定义 slug", async () => {
		const getFile = vi.fn<GitProvider["getFile"]>().mockResolvedValue({
			path: repositoryPath,
			sha: FILE_SHA,
			encoding: "utf-8",
			content: buildMarkdownDocument(frontmatter, "正文", "public-url"),
		});

		const article = await readArticle("hello-world", {
			gitProvider: createGitProvider(getFile),
		});

		expect(article.storageSlug).toBe("hello-world");
		expect(article.slug).toBe("public-url");
	});

	it("拒绝客户端把仓库路径当作 slug，且不调用 Provider", async () => {
		const getFile = vi.fn<GitProvider["getFile"]>();

		await expect(
			readArticle("src/content/posts/hello-world/index.md", {
				gitProvider: createGitProvider(getFile),
			}),
		).rejects.toThrow("Slug 校验失败");
		expect(getFile).not.toHaveBeenCalled();
	});

	it("拒绝 Provider 返回与服务端计算值不一致的仓库路径", async () => {
		const getFile = vi.fn<GitProvider["getFile"]>().mockResolvedValue({
			path: "README.md",
			sha: FILE_SHA,
			encoding: "utf-8",
			content: buildMarkdownDocument(frontmatter, "正文"),
		});

		await expect(
			readArticle("hello-world", { gitProvider: createGitProvider(getFile) }),
		).rejects.toMatchObject({ status: 502, code: "UPSTREAM_ERROR" });
	});

	it("将不可信远端 Markdown 解析错误归一化", async () => {
		const getFile = vi.fn<GitProvider["getFile"]>().mockResolvedValue({
			path: repositoryPath,
			sha: FILE_SHA,
			encoding: "utf-8",
			content: "---\ntitle: broken\n---\n正文",
		});

		let thrown: unknown;
		try {
			await readArticle("hello-world", { gitProvider: createGitProvider(getFile) });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ApiError);
		expect(thrown).toMatchObject({ status: 422, code: "ARTICLE_INVALID" });
		expect((thrown as Error).message).not.toContain("published");
	});

	it("保留 Git Provider 已归一化的未找到错误", async () => {
		const getFile = vi
			.fn<GitProvider["getFile"]>()
			.mockRejectedValue(new ApiError(404, "NOT_FOUND", "远端文件不存在。"));

		await expect(
			readArticle("missing-post", { gitProvider: createGitProvider(getFile) }),
		).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
	});

	it("支持注入受信任路径配置而不接受客户端完整路径", async () => {
		const customPath = "content/blog/hello-world/post.md";
		const getFile = vi.fn<GitProvider["getFile"]>().mockResolvedValue({
			path: customPath,
			sha: FILE_SHA,
			encoding: "utf-8",
			content: buildMarkdownDocument(frontmatter, "正文"),
		});

		await readArticle("hello-world", {
			gitProvider: createGitProvider(getFile),
			pathConfig: {
				contentRoot: "content/blog",
				usePageBundle: true,
				entryFilename: "post.md",
			},
		});

		expect(getFile).toHaveBeenCalledWith(customPath);
	});
});
