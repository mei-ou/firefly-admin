import { describe, expect, it, vi } from "vitest";
import { createGitHubProviderFactory } from "../../src/providers/git/github-factory";
import { GitHubProvider } from "../../src/providers/git/github-provider";
import { initializeProvider } from "../../src/providers/registry";

const validEnv = {
	GITHUB_OWNER: "firefly-owner",
	GITHUB_REPO: "firefly-blog",
	GITHUB_BRANCH: "master",
	GITHUB_CONTENT_ROOT: "src/content/posts",
	GITHUB_TOKEN: "test-token",
};

describe("GitHub Provider 延迟工厂", () => {
	it("创建工厂时不读取 Worker 环境", () => {
		const readEnv = vi.fn(() => validEnv);

		const factory = createGitHubProviderFactory({ readEnv });

		expect(factory).toMatchObject({ id: "github", moduleId: "articles" });
		expect(readEnv).not.toHaveBeenCalled();
	});

	it("只有 articles 模块通过注册表边界后才读取配置", () => {
		const readEnv = vi.fn(() => validEnv);
		const factory = createGitHubProviderFactory({ readEnv });

		const provider = initializeProvider("articles", factory);

		expect(provider).toBeInstanceOf(GitHubProvider);
		expect(readEnv).toHaveBeenCalledOnce();
	});

	it("工厂被错误模块调用时不读取 Secret", () => {
		const readEnv = vi.fn(() => validEnv);
		const factory = createGitHubProviderFactory({ readEnv });

		expect(initializeProvider("media", factory)).toBeUndefined();
		expect(readEnv).not.toHaveBeenCalled();
	});

	it("Provider 初始化时配置缺失则失败关闭", () => {
		const readEnv = vi.fn(() => ({ ...validEnv, GITHUB_TOKEN: undefined }));
		const factory = createGitHubProviderFactory({ readEnv });

		expect(() => initializeProvider("articles", factory)).toThrow(
			expect.objectContaining({ status: 503, code: "CONFIGURATION_ERROR" }),
		);
		expect(readEnv).toHaveBeenCalledOnce();
	});
});
