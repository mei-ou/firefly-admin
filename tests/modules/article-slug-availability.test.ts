import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import { handleCheckArticleSlug } from "../../src/modules/articles/api/check-article-slug";
import type { GitProvider } from "../../src/providers/git/types";
import type { RuntimeEnv } from "../../src/types/env";
import type { ProviderFactory } from "../../src/types/provider";

const FILE_SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const TREE_SHA = "c".repeat(40);
const principal = { sub: "subject-1", email: "admin@example.com" };
const validEnv: RuntimeEnv = {
	GITHUB_OWNER: "firefly-owner",
	GITHUB_REPO: "firefly-blog",
	GITHUB_BRANCH: "master",
	GITHUB_CONTENT_ROOT: "src/content/posts",
	GITHUB_TOKEN: "test-token",
	RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

function createRepositoryFactory(getFileAtCommit: GitProvider["getFileAtCommit"]): ProviderFactory<{
	config: { contentRoot: string; entryFilename: string; usePageBundle: boolean };
	provider: Pick<GitProvider, "getFile" | "getFileAtCommit" | "getHead">;
}> {
	return {
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
			},
		}),
	};
}

describe("文章 storage slug 预检", () => {
	it("远端固定文章文件存在时返回已占用", async () => {
		const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
			path: "src/content/posts/hello-world/index.md",
			sha: FILE_SHA,
			encoding: "utf-8",
			content: "ignored",
		});
		const response = await handleCheckArticleSlug(
			{ slug: "hello-world", principal, env: validEnv },
			{ createRepositoryFactory: () => createRepositoryFactory(getFileAtCommit) },
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-Article-Slug-Available")).toBe("false");
		expect(response.headers.get("X-Repository-Head-Sha")).toBe(HEAD_SHA);
		expect(getFileAtCommit).toHaveBeenCalledWith(
			"src/content/posts/hello-world/index.md",
			HEAD_SHA,
		);
	});

	it("远端明确未找到时返回可用", async () => {
		const getFileAtCommit = vi
			.fn<GitProvider["getFileAtCommit"]>()
			.mockRejectedValue(new ApiError(404, "NOT_FOUND", "远端文件不存在。"));
		const response = await handleCheckArticleSlug(
			{ slug: "new-post", principal, env: validEnv },
			{ createRepositoryFactory: () => createRepositoryFactory(getFileAtCommit) },
		);

		expect(response.status).toBe(404);
		expect(response.headers.get("X-Article-Slug-Available")).toBe("true");
		expect(response.headers.get("X-Repository-Head-Sha")).toBe(HEAD_SHA);
		expect(getFileAtCommit).toHaveBeenCalledWith("src/content/posts/new-post/index.md", HEAD_SHA);
	});

	it("非法 slug 和匿名上下文在 Provider 初始化前失败", async () => {
		const createFactory = vi.fn();
		await expect(
			handleCheckArticleSlug(
				{ slug: "../secret", principal, env: validEnv },
				{ createRepositoryFactory: createFactory },
			),
		).rejects.toThrow("Slug 校验失败");
		await expect(
			handleCheckArticleSlug({ slug: "hello-world", principal: undefined, env: validEnv }),
		).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
		expect(createFactory).not.toHaveBeenCalled();
	});

	it("限流和上游异常不会误报为可用", async () => {
		await expect(
			handleCheckArticleSlug({
				slug: "hello-world",
				principal,
				env: {
					...validEnv,
					RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
				},
			}),
		).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });

		const getFileAtCommit = vi
			.fn<GitProvider["getFileAtCommit"]>()
			.mockRejectedValue(new ApiError(503, "UPSTREAM_UNAVAILABLE", "暂时不可用。"));
		await expect(
			handleCheckArticleSlug(
				{ slug: "hello-world", principal, env: validEnv },
				{ createRepositoryFactory: () => createRepositoryFactory(getFileAtCommit) },
			),
		).rejects.toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
	});

	it("Provider 路径漂移按上游异常失败关闭", async () => {
		const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
			path: "src/content/posts/other/index.md",
			sha: FILE_SHA,
			encoding: "utf-8",
			content: "ignored",
		});
		await expect(
			handleCheckArticleSlug(
				{ slug: "hello-world", principal, env: validEnv },
				{ createRepositoryFactory: () => createRepositoryFactory(getFileAtCommit) },
			),
		).rejects.toMatchObject({ status: 502, code: "UPSTREAM_ERROR" });
	});
});
