import { type GitHubRuntimeConfig, loadGitHubConfig } from "../../core/config/github-config";
import type { ProviderFactory } from "../../types/provider";
import { GitHubProvider, type GitHubProviderDependencies } from "./github-provider";

export interface GitHubProviderFactoryOptions extends GitHubProviderDependencies {
	/**
	 * 延迟读取 Worker 环境的函数。不能在工厂创建时直接捕获 Secret，否则模块关闭也会
	 * 触碰 GitHub 凭据，破坏 Provider 四层开关中的最后一道边界。
	 */
	readEnv(): unknown;
}

export interface InitializedGitHubRepository {
	config: GitHubRuntimeConfig;
	provider: GitHubProvider;
}

/**
 * 创建文章模块专用的延迟 GitHub Provider 工厂。调用方仍必须通过 initializeProvider，
 * 由注册表先判断 articles 模块是否启用，再执行这里的 create 和 Secret 读取。
 */
export function createGitHubRepositoryFactory(
	options: GitHubProviderFactoryOptions,
): ProviderFactory<InitializedGitHubRepository> {
	return {
		id: "github",
		moduleId: "articles",
		create() {
			const config = loadGitHubConfig(options.readEnv());
			const dependencies: GitHubProviderDependencies = {};
			if (options.fetch !== undefined) {
				dependencies.fetch = options.fetch;
			}
			return {
				config,
				provider: new GitHubProvider(
					{
						owner: config.owner,
						repo: config.repo,
						branch: config.branch,
						token: config.token,
					},
					dependencies,
				),
			};
		},
	};
}

/** 兼容只需要 Provider 的调用方；内部仍复用同一份延迟配置加载逻辑。 */
export function createGitHubProviderFactory(
	options: GitHubProviderFactoryOptions,
): ProviderFactory<GitHubProvider> {
	const repositoryFactory = createGitHubRepositoryFactory(options);
	return {
		id: repositoryFactory.id,
		moduleId: repositoryFactory.moduleId,
		create: () => repositoryFactory.create().provider,
	};
}
