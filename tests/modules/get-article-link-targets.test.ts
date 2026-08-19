import { describe, expect, it, vi } from "vitest";
import { handleGetArticleLinkTargets } from "../../src/modules/articles/api/get-article-link-targets";
import type { GitProvider } from "../../src/providers/git/types";
import type { RuntimeEnv } from "../../src/types/env";
import type { ProviderFactory } from "../../src/types/provider";
import { buildMarkdownDocument } from "../../src/utils/frontmatter-utils";

const FILE_SHA = "a".repeat(40);
const contentRoot = "src/content/posts";
const principal = { sub: "subject-1", email: "admin@example.com" };
const validEnv: RuntimeEnv = {
	GITHUB_OWNER: "firefly-owner",
	GITHUB_REPO: "firefly-blog",
	GITHUB_BRANCH: "master",
	GITHUB_CONTENT_ROOT: contentRoot,
	GITHUB_TOKEN: "test-token",
	RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

function createRepositoryFactory(
	provider: Pick<GitProvider, "listDirectory" | "getFile">,
): () => ProviderFactory<{
	config: { contentRoot: string; entryFilename: string; usePageBundle: boolean };
	provider: Pick<GitProvider, "listDirectory" | "getFile">;
}> {
	return () => ({
		id: "test-git",
		moduleId: "articles",
		create: () => ({
			config: { contentRoot, entryFilename: "index.md", usePageBundle: true },
			provider,
		}),
	});
}

function createProvider(): Pick<GitProvider, "listDirectory" | "getFile"> {
	const markdown = buildMarkdownDocument(
		{
			title: "Alpha Guide",
			published: new Date("2026-03-01T00:00:00.000Z"),
			description: "安全文章",
			tags: ["security"],
			category: "Guide",
		},
		"# 快速开始\n\n## 快速开始\n\n正文\n\n### 快速开始",
		"public-url",
	);
	return {
		listDirectory: vi
			.fn()
			.mockResolvedValue([
				{ name: "alpha-post", path: `${contentRoot}/alpha-post`, sha: FILE_SHA, type: "directory" },
			]),
		getFile: vi.fn().mockResolvedValue({
			path: `${contentRoot}/alpha-post/index.md`,
			sha: FILE_SHA,
			encoding: "utf-8",
			content: markdown,
		}),
	};
}

describe("文章链接目标 API 编排", () => {
	it("返回文章与 H1-H6 标题并保留 no-store", async () => {
		const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const response = await handleGetArticleLinkTargets(
			{
				request: new Request("https://admin.example.com/api/articles/link-targets?query=security"),
				principal,
				env: { ...validEnv, RATE_LIMITER: limiter },
			},
			{ createRepositoryFactory: createRepositoryFactory(createProvider()) },
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(limiter.limit).toHaveBeenCalledWith({ key: "subject-1:articles-read" });
		const body = (await response.json()) as {
			targets: { items: Array<{ href: string; headings: Array<{ id: string }> }> };
		};
		expect(body.targets.items[0]).toMatchObject({
			slug: "public-url",
			href: "/posts/public-url/",
			headings: [
				{ depth: 1, id: "快速开始" },
				{ depth: 2, id: "快速开始-1" },
				{ depth: 3, id: "快速开始-2" },
			],
		});
	});

	it("能力关闭时在认证、限流和仓库读取前失败关闭", async () => {
		const createFactory = vi.fn();
		const limiter = { limit: vi.fn() };

		await expect(
			handleGetArticleLinkTargets(
				{
					request: new Request("https://admin.example.com/api/articles/link-targets"),
					principal,
					env: {
						...validEnv,
						FEATURE_ARTICLE_LINKS: "false",
						RATE_LIMITER: limiter,
					},
				},
				{ createRepositoryFactory: createFactory },
			),
		).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
		expect(limiter.limit).not.toHaveBeenCalled();
		expect(createFactory).not.toHaveBeenCalled();
	});

	it("拒绝未认证、未知和重复参数且不初始化仓库", async () => {
		const createFactory = vi.fn();
		const limiter = { limit: vi.fn() };
		await expect(
			handleGetArticleLinkTargets(
				{
					request: new Request("https://admin.example.com/api/articles/link-targets"),
					principal: undefined,
					env: { ...validEnv, RATE_LIMITER: limiter },
				},
				{ createRepositoryFactory: createFactory },
			),
		).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });

		for (const search of ["?page=1", "?query=a&query=b", `?query=${"a".repeat(101)}`]) {
			await expect(
				handleGetArticleLinkTargets(
					{
						request: new Request(`https://admin.example.com/api/articles/link-targets${search}`),
						principal,
						env: { ...validEnv, RATE_LIMITER: limiter },
					},
					{ createRepositoryFactory: createFactory },
				),
			).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
		}
		expect(limiter.limit).not.toHaveBeenCalled();
		expect(createFactory).not.toHaveBeenCalled();
	});
});
