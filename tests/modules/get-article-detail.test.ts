import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import { handleGetArticleDetail } from "../../src/modules/articles/api/get-article-detail";
import type { GitProvider } from "../../src/providers/git/types";
import type { RuntimeEnv } from "../../src/types/env";
import type { ProviderFactory } from "../../src/types/provider";
import { buildMarkdownDocument } from "../../src/utils/frontmatter-utils";

const FILE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const repositoryPath = "src/content/posts/hello-world/index.md";
const validEnv: RuntimeEnv = {
	GITHUB_OWNER: "firefly-owner",
	GITHUB_REPO: "firefly-blog",
	GITHUB_BRANCH: "master",
	GITHUB_CONTENT_ROOT: "src/content/posts",
	GITHUB_TOKEN: "test-token",
	FEATURE_ARTICLE_ASSET_DETAILS: "true",
	RATE_LIMITER: {
		limit: vi.fn().mockResolvedValue({ success: true }),
	},
};

function githubFileResponse() {
	const content = buildMarkdownDocument(
		{
			title: "你好，Firefly",
			published: new Date("2026-08-12T00:00:00.000Z"),
		},
		"# 正文\n",
		"public-url",
	);
	return new Response(
		JSON.stringify({
			type: "file",
			path: repositoryPath,
			sha: FILE_SHA,
			encoding: "base64",
			content: Buffer.from(content, "utf8").toString("base64"),
			size: Buffer.byteLength(content),
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

const principal = { sub: "subject-1", email: "admin@example.com" };

function lightEnv(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
	return { ...validEnv, ...overrides, FEATURE_ARTICLE_ASSET_DETAILS: "false" };
}

describe("文章详情 API 编排", () => {
	it("通过限流和延迟 GitHub Provider 返回统一 JSON", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ object: { type: "commit", sha: HEAD_SHA } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						sha: HEAD_SHA,
						html_url: `https://github.com/firefly-owner/firefly-blog/commit/${HEAD_SHA}`,
						tree: { sha: TREE_SHA },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(githubFileResponse())
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							name: "index.md",
							path: repositoryPath,
							sha: FILE_SHA,
							type: "file",
							size: 1_024,
						},
						{
							name: "cover.webp",
							path: "src/content/posts/hello-world/cover.webp",
							sha: "d".repeat(40),
							type: "file",
							size: 2_048,
						},
					]),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);
		const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };

		const response = await handleGetArticleDetail(
			{
				slug: "hello-world",
				principal,
				env: { ...validEnv, RATE_LIMITER: limiter },
			},
			{ fetch: fetchMock },
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(limiter.limit).toHaveBeenCalledWith({ key: "subject-1:article-assets-read" });
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(fetchMock.mock.calls[2]?.[0].toString()).toBe(
			`https://api.github.com/repos/firefly-owner/firefly-blog/contents/${repositoryPath}?ref=${HEAD_SHA}`,
		);
		const body = (await response.json()) as { article: Record<string, unknown> };
		expect(body.article).toMatchObject({
			storageSlug: "hello-world",
			pathAlias: "hello-world/index.md",
			sha: FILE_SHA,
			headSha: HEAD_SHA,
			slug: "public-url",
			format: "md",
			markdown: "# 正文\n",
			resources: [
				{
					filename: "cover.webp",
					blobSha: "d".repeat(40),
					size: 2_048,
					contentType: "image/webp",
					policyLevel: "L0",
				},
			],
			resourceReferenceAnalysis: { complete: true, issues: [] },
		});
	});

	it("关闭资源详情时保留 headSha 但不扫描 Page Bundle", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ object: { type: "commit", sha: HEAD_SHA } }), {
					status: 200,
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						sha: HEAD_SHA,
						html_url: `https://github.com/firefly-owner/firefly-blog/commit/${HEAD_SHA}`,
						tree: { sha: TREE_SHA },
					}),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(githubFileResponse());
		const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const response = await handleGetArticleDetail(
			{ slug: "hello-world", principal, env: lightEnv({ RATE_LIMITER: limiter }) },
			{ fetch: fetchMock },
		);
		const body = (await response.json()) as { article: Record<string, unknown> };
		expect(response.status).toBe(200);
		expect(body.article).toMatchObject({ headSha: HEAD_SHA, markdown: "# 正文\n" });
		expect(body.article.resources).toBeUndefined();
		expect(body.article.resourceReferenceAnalysis).toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(limiter.limit).toHaveBeenCalledWith({ key: "subject-1:articles-read" });
	});

	it("拒绝未认证上下文，且不读取限流或 GitHub 配置", async () => {
		const limiter = { limit: vi.fn() };
		await expect(
			handleGetArticleDetail({
				slug: "hello-world",
				principal: undefined,
				env: { ...validEnv, RATE_LIMITER: limiter },
			}),
		).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
		expect(limiter.limit).not.toHaveBeenCalled();
	});

	it("限流拒绝时不会初始化 GitHub Provider", async () => {
		const createRepositoryFactory = vi.fn();
		await expect(
			handleGetArticleDetail(
				{
					slug: "hello-world",
					principal,
					env: {
						...validEnv,
						RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
					},
				},
				{ createRepositoryFactory },
			),
		).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
		expect(createRepositoryFactory).not.toHaveBeenCalled();
	});

	it("限流 Binding 缺失时失败关闭", async () => {
		const withoutLimiter: RuntimeEnv = {
			GITHUB_OWNER: "firefly-owner",
			GITHUB_REPO: "firefly-blog",
			GITHUB_BRANCH: "master",
			GITHUB_CONTENT_ROOT: "src/content/posts",
			GITHUB_TOKEN: "test-token",
		};
		await expect(
			handleGetArticleDetail({ slug: "hello-world", principal, env: withoutLimiter }),
		).rejects.toMatchObject({ status: 503, code: "RATE_LIMIT_UNAVAILABLE" });
	});

	it("非法 slug 在 GitHub 网络访问前被拒绝", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		await expect(
			handleGetArticleDetail(
				{
					slug: "../secret",
					principal,
					env: validEnv,
				},
				{ fetch: fetchMock },
			),
		).rejects.toThrow("Slug 校验失败");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("GitHub 配置缺失时统一失败关闭", async () => {
		const envWithoutToken: RuntimeEnv = {
			GITHUB_OWNER: "firefly-owner",
			GITHUB_REPO: "firefly-blog",
			GITHUB_BRANCH: "master",
			GITHUB_CONTENT_ROOT: "src/content/posts",
			RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
		};
		await expect(
			handleGetArticleDetail({
				slug: "hello-world",
				principal,
				env: envWithoutToken,
			}),
		).rejects.toMatchObject({ status: 503, code: "CONFIGURATION_ERROR" });
	});

	it("保留远端文章格式错误", async () => {
		const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
			path: repositoryPath,
			sha: FILE_SHA,
			encoding: "utf-8",
			content: "---\ntitle: missing-published\n---\n正文",
		});
		const createRepositoryFactory = (): ProviderFactory<{
			config: {
				contentRoot: string;
				entryFilename: string;
				usePageBundle: boolean;
			};
			provider: Pick<
				GitProvider,
				"getFile" | "getFileAtCommit" | "getHead" | "listDirectoryAtCommit"
			>;
		}> => ({
			id: "test-git",
			moduleId: "articles",
			create: () => ({
				config: {
					contentRoot: "src/content/posts",
					entryFilename: "index.md",
					usePageBundle: true,
				},
				provider: {
					getFile: vi.fn<GitProvider["getFile"]>(),
					getFileAtCommit,
					getHead: vi.fn<GitProvider["getHead"]>().mockResolvedValue({
						commitSha: HEAD_SHA,
						treeSha: TREE_SHA,
					}),
					listDirectoryAtCommit: vi.fn<GitProvider["listDirectoryAtCommit"]>().mockResolvedValue([
						{
							name: "index.md",
							path: repositoryPath,
							sha: FILE_SHA,
							type: "file",
							size: 1_024,
						},
					]),
				},
			}),
		});

		await expect(
			handleGetArticleDetail(
				{ slug: "hello-world", principal, env: validEnv },
				{ createRepositoryFactory },
			),
		).rejects.toMatchObject({ status: 422, code: "ARTICLE_INVALID" });
	});

	it("Provider 的未找到错误继续交给全局统一错误层", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ object: { type: "commit", sha: HEAD_SHA } }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						sha: HEAD_SHA,
						html_url: `https://github.com/firefly-owner/firefly-blog/commit/${HEAD_SHA}`,
						tree: { sha: TREE_SHA },
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockImplementation(() =>
				Promise.resolve(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 })),
			);

		let thrown: unknown;
		try {
			await handleGetArticleDetail(
				{ slug: "missing-post", principal, env: validEnv },
				{ fetch: fetchMock },
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(ApiError);
		expect(thrown).toMatchObject({ status: 404, code: "NOT_FOUND" });
	});
});
