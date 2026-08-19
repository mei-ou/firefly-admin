import { describe, expect, it } from "vitest";
import { loadGitHubConfig } from "../../src/core/config/github-config";

const validEnv = {
	GITHUB_OWNER: "firefly-owner",
	GITHUB_REPO: "firefly-blog",
	GITHUB_BRANCH: "master",
	GITHUB_CONTENT_ROOT: "src/content/posts",
	GITHUB_TOKEN: "test-token",
};

describe("GitHub 运行配置", () => {
	it("将 Worker 环境归一化为 Provider 配置", () => {
		expect(loadGitHubConfig({ ...validEnv, UNUSED: "ignored" })).toEqual({
			owner: "firefly-owner",
			repo: "firefly-blog",
			branch: "master",
			contentRoot: "src/content/posts",
			entryFilename: "index.md",
			usePageBundle: true,
			token: "test-token",
		});
	});

	it("缺少 Token 时失败关闭", () => {
		expect(() => loadGitHubConfig({ ...validEnv, GITHUB_TOKEN: undefined })).toThrow(
			expect.objectContaining({ status: 503, code: "CONFIGURATION_ERROR" }),
		);
	});

	it("拒绝危险仓库标识和分支", () => {
		for (const patch of [
			{ GITHUB_OWNER: "../owner" },
			{ GITHUB_REPO: "repo/name" },
			{ GITHUB_BRANCH: "feature//post" },
			{ GITHUB_BRANCH: "refs/heads/../secret" },
			{ GITHUB_BRANCH: "branch.lock" },
		]) {
			expect(() => loadGitHubConfig({ ...validEnv, ...patch })).toThrow(
				expect.objectContaining({ status: 503, code: "CONFIGURATION_ERROR" }),
			);
		}
	});

	it("拒绝越界的内容根目录", () => {
		for (const contentRoot of [
			"/src/content/posts",
			"src/content/../secret",
			"src\\content\\posts",
			"src/content/%2e%2e/secret",
		]) {
			expect(() => loadGitHubConfig({ ...validEnv, GITHUB_CONTENT_ROOT: contentRoot })).toThrow(
				expect.objectContaining({ status: 503, code: "CONFIGURATION_ERROR" }),
			);
		}
	});

	it("配置错误不泄露 Token 或具体字段", () => {
		let thrown: unknown;
		try {
			loadGitHubConfig({ ...validEnv, GITHUB_OWNER: "invalid/owner" });
		} catch (error) {
			thrown = error;
		}

		expect((thrown as Error).message).not.toContain("test-token");
		expect((thrown as Error).message).not.toContain("GITHUB_OWNER");
	});
});
