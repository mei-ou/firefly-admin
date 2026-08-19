import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import { handleGetArticleList } from "../../src/modules/articles/api/get-article-list";
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
	RATE_LIMITER: {
		limit: vi.fn().mockResolvedValue({ success: true }),
	},
};

function request(search = ""): Request {
	return new Request(`https://admin.example.com/api/articles${search}`);
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function directoryResponse(): Response {
	return jsonResponse([
		{
			name: "alpha-post",
			path: `${contentRoot}/alpha-post`,
			sha: FILE_SHA,
			type: "dir",
			size: 0,
		},
		{
			name: "beta-post",
			path: `${contentRoot}/beta-post`,
			sha: FILE_SHA,
			type: "dir",
			size: 0,
		},
	]);
}

function fileResponse(storageSlug: string): Response {
	const content = buildMarkdownDocument(
		{
			title: storageSlug === "alpha-post" ? "Alpha Guide" : "Beta Guide",
			published: new Date(
				storageSlug === "alpha-post" ? "2026-03-01T00:00:00.000Z" : "2026-02-01T00:00:00.000Z",
			),
			tags: storageSlug === "alpha-post" ? ["security"] : ["other"],
		},
		"正文",
	);
	return jsonResponse({
		type: "file",
		path: `${contentRoot}/${storageSlug}/index.md`,
		sha: FILE_SHA,
		encoding: "base64",
		content: Buffer.from(content, "utf8").toString("base64"),
		size: Buffer.byteLength(content),
	});
}

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

describe("文章列表 API 编排", () => {
	it("通过限流和延迟 GitHub Provider 返回搜索分页结果", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
			const url = input instanceof URL ? input : new URL(String(input));
			if (url.pathname.endsWith(`/contents/${contentRoot}`)) {
				return directoryResponse();
			}
			return fileResponse(url.pathname.includes("alpha-post") ? "alpha-post" : "beta-post");
		});
		const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };

		const response = await handleGetArticleList(
			{
				request: request("?query=security&page=1&pageSize=1"),
				principal,
				env: { ...validEnv, RATE_LIMITER: limiter },
			},
			{ fetch: fetchMock },
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(limiter.limit).toHaveBeenCalledWith({ key: "subject-1:articles-read" });
		const body = (await response.json()) as {
			articles: {
				items: Array<{ storageSlug: string; title: string }>;
				total: number;
				page: number;
			};
		};
		expect(body.articles).toMatchObject({ total: 1, page: 1 });
		expect(body.articles.items).toEqual([
			expect.objectContaining({ storageSlug: "alpha-post", title: "Alpha Guide" }),
		]);
	});

	it("默认查询参数返回列表并序列化日期", async () => {
		const listDirectory = vi.fn<GitProvider["listDirectory"]>().mockResolvedValue([
			{
				name: "alpha-post",
				path: `${contentRoot}/alpha-post`,
				sha: FILE_SHA,
				type: "directory",
				size: null,
			},
		]);
		const getFile = vi.fn<GitProvider["getFile"]>().mockResolvedValue({
			path: `${contentRoot}/alpha-post/index.md`,
			sha: FILE_SHA,
			encoding: "utf-8",
			content: buildMarkdownDocument(
				{ title: "Alpha", published: new Date("2026-03-01T00:00:00.000Z") },
				"正文",
			),
		});

		const response = await handleGetArticleList(
			{ request: request(), principal, env: validEnv },
			{ createRepositoryFactory: createRepositoryFactory({ listDirectory, getFile }) },
		);
		const body = (await response.json()) as {
			articles: { page: number; pageSize: number; items: Array<{ published: string }> };
		};

		expect(body.articles.page).toBe(1);
		expect(body.articles.pageSize).toBe(20);
		expect(body.articles.items[0]?.published).toBe("2026-03-01T00:00:00.000Z");
	});

	it("拒绝未认证上下文且不触发限流或仓库初始化", async () => {
		const limiter = { limit: vi.fn() };
		const createFactory = vi.fn();

		await expect(
			handleGetArticleList(
				{ request: request(), principal: undefined, env: { ...validEnv, RATE_LIMITER: limiter } },
				{ createRepositoryFactory: createFactory },
			),
		).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
		expect(limiter.limit).not.toHaveBeenCalled();
		expect(createFactory).not.toHaveBeenCalled();
	});

	it("拒绝未知、重复和越界查询参数且不消耗限流额度", async () => {
		for (const search of ["?sort=title", "?page=1&page=2", "?pageSize=51", "?page=0"]) {
			const limiter = { limit: vi.fn() };
			await expect(
				handleGetArticleList({
					request: request(search),
					principal,
					env: { ...validEnv, RATE_LIMITER: limiter },
				}),
			).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
			expect(limiter.limit).not.toHaveBeenCalled();
		}
	});

	it("限流拒绝或 Binding 缺失时不初始化 GitHub Provider", async () => {
		const createFactory = vi.fn();
		await expect(
			handleGetArticleList(
				{
					request: request(),
					principal,
					env: {
						...validEnv,
						RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
					},
				},
				{ createRepositoryFactory: createFactory },
			),
		).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });

		const withoutLimiter: RuntimeEnv = {
			GITHUB_OWNER: "firefly-owner",
			GITHUB_REPO: "firefly-blog",
			GITHUB_BRANCH: "master",
			GITHUB_CONTENT_ROOT: contentRoot,
			GITHUB_TOKEN: "test-token",
		};
		await expect(
			handleGetArticleList({ request: request(), principal, env: withoutLimiter }),
		).rejects.toMatchObject({ status: 503, code: "RATE_LIMIT_UNAVAILABLE" });
		expect(createFactory).not.toHaveBeenCalled();
	});

	it("GitHub 配置缺失时统一失败关闭", async () => {
		const envWithoutToken: RuntimeEnv = {
			GITHUB_OWNER: "firefly-owner",
			GITHUB_REPO: "firefly-blog",
			GITHUB_BRANCH: "master",
			GITHUB_CONTENT_ROOT: contentRoot,
			RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
		};

		await expect(
			handleGetArticleList({ request: request(), principal, env: envWithoutToken }),
		).rejects.toMatchObject({ status: 503, code: "CONFIGURATION_ERROR" });
	});

	it("根目录上游失败继续交给全局错误层", async () => {
		const listDirectory = vi
			.fn<GitProvider["listDirectory"]>()
			.mockRejectedValue(new ApiError(503, "UPSTREAM_UNAVAILABLE", "Git 服务暂时不可用。"));
		const getFile = vi.fn<GitProvider["getFile"]>();

		await expect(
			handleGetArticleList(
				{ request: request(), principal, env: validEnv },
				{ createRepositoryFactory: createRepositoryFactory({ listDirectory, getFile }) },
			),
		).rejects.toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
		expect(getFile).not.toHaveBeenCalled();
	});
});
