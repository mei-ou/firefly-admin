import { guardModule } from "../../../core/config/feature-flags";
import { ApiError } from "../../../core/http/errors";
import { buildArticlePath } from "../../../core/security/path-policy";
import { enforceRateLimit } from "../../../core/security/rate-limit";
import {
	createGitHubRepositoryFactory,
	type GitHubProviderFactoryOptions,
} from "../../../providers/git/github-factory";
import { initializeProvider } from "../../../providers/registry";
import type { AuthenticatedPrincipal, RuntimeEnv } from "../../../types/env";
import type { ProviderFactory } from "../../../types/provider";
import { parseSlug } from "../../../utils/slug-utils";
import type { ArticleRepository } from "./get-article-detail";

export interface ArticleSlugCheckRequestContext {
	slug: unknown;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

export interface ArticleSlugCheckHandlerDependencies {
	fetch?: typeof fetch;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<ArticleRepository>;
}

/**
 * 轻量 storage slug 占用检查。只验证固定 `index.md` 是否存在，不下载后再解析文章内容。
 * 返回 200 表示已占用，404 表示当前未找到；其余上游和配置错误必须继续失败关闭。
 */
export async function handleCheckArticleSlug(
	context: ArticleSlugCheckRequestContext,
	dependencies: ArticleSlugCheckHandlerDependencies = {},
): Promise<Response> {
	guardModule("articles");
	if (!context.principal) {
		throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	}
	const slug = parseSlug(context.slug);
	await enforceRateLimit(context.env.RATE_LIMITER, context.principal.sub, "articles-read");

	const factoryOptions: GitHubProviderFactoryOptions = { readEnv: () => context.env };
	if (dependencies.fetch !== undefined) factoryOptions.fetch = dependencies.fetch;
	const createRepositoryFactory =
		dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory;
	const repository = initializeProvider("articles", createRepositoryFactory(factoryOptions));
	if (!repository) throw new ApiError(404, "NOT_FOUND", "资源不存在。");

	const path = buildArticlePath(slug, repository.config);
	if (!repository.provider.getHead || !repository.provider.getFileAtCommit) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "Git Provider 缺少一致性读取能力。");
	}
	const head = await repository.provider.getHead();
	try {
		const file = await repository.provider.getFileAtCommit(path, head.commitSha);
		if (file.path !== path) {
			throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效响应。");
		}
		return new Response(null, {
			status: 200,
			headers: {
				"Cache-Control": "no-store",
				"X-Article-Slug-Available": "false",
				"X-Repository-Head-Sha": head.commitSha,
			},
		});
	} catch (error) {
		if (error instanceof ApiError && error.status === 404 && error.code === "NOT_FOUND") {
			return new Response(null, {
				status: 404,
				headers: {
					"Cache-Control": "no-store",
					"X-Article-Slug-Available": "true",
					"X-Repository-Head-Sha": head.commitSha,
				},
			});
		}
		throw error;
	}
}
