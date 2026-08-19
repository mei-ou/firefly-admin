import { loadArticleUrlTemplate } from "../../../core/config/article-url";
import { requireAdminCapability } from "../../../core/config/capabilities";
import { guardModule } from "../../../core/config/feature-flags";
import { ApiError } from "../../../core/http/errors";
import { jsonResponse } from "../../../core/http/response";
import { enforceRateLimit } from "../../../core/security/rate-limit";
import {
	createGitHubRepositoryFactory,
	type GitHubProviderFactoryOptions,
} from "../../../providers/git/github-factory";
import { initializeProvider } from "../../../providers/registry";
import type { AuthenticatedPrincipal, RuntimeEnv } from "../../../types/env";
import type { ProviderFactory } from "../../../types/provider";
import {
	type ListArticleLinkTargetsDependencies,
	listArticleLinkTargets,
} from "../services/list-article-link-targets";

export interface ArticleLinkTargetsRequestContext {
	request: Request;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

interface ArticleLinkTargetRepository {
	config: ListArticleLinkTargetsDependencies["pathConfig"];
	provider: ListArticleLinkTargetsDependencies["gitProvider"];
}

export interface ArticleLinkTargetsHandlerDependencies {
	fetch?: typeof fetch;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<ArticleLinkTargetRepository>;
}

function parseQuery(request: Request): string {
	const parameters = new URL(request.url).searchParams;
	for (const key of parameters.keys()) {
		if (key !== "query" || parameters.getAll(key).length !== 1) {
			throw new ApiError(400, "INVALID_REQUEST", "文章链接查询参数无效。");
		}
	}
	const query = parameters.get("query")?.trim() ?? "";
	if (query.length > 100) {
		throw new ApiError(400, "INVALID_REQUEST", "文章链接查询参数无效。");
	}
	return query;
}

export async function handleGetArticleLinkTargets(
	context: ArticleLinkTargetsRequestContext,
	dependencies: ArticleLinkTargetsHandlerDependencies = {},
): Promise<Response> {
	// 浏览器 capability 只负责隐藏入口；API 必须在认证、限流和 Provider 初始化前独立裁决。
	requireAdminCapability(context.env, "articleLinks");
	guardModule("articles");
	if (!context.principal) {
		throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	}
	const query = parseQuery(context.request);
	await enforceRateLimit(context.env.RATE_LIMITER, context.principal.sub, "articles-read");

	const factoryOptions: GitHubProviderFactoryOptions = { readEnv: () => context.env };
	if (dependencies.fetch) factoryOptions.fetch = dependencies.fetch;
	const repository = initializeProvider(
		"articles",
		(dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory)(factoryOptions),
	);
	if (!repository) throw new ApiError(404, "NOT_FOUND", "资源不存在。");

	const articleUrlTemplate = loadArticleUrlTemplate(context.env);
	const targets = await listArticleLinkTargets(
		{ query },
		{
			gitProvider: repository.provider,
			pathConfig: repository.config,
			...(articleUrlTemplate === undefined ? {} : { articleUrlTemplate }),
		},
	);
	return jsonResponse({ targets });
}
