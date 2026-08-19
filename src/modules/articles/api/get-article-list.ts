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
	type ListArticlesDependencies,
	listArticles,
	parseArticleListQuery as validateArticleListQuery,
} from "../services/list-articles";

const ALLOWED_QUERY_PARAMETERS = new Set(["page", "pageSize", "query"]);

export interface ArticleListRequestContext {
	request: Request;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

interface ArticleListRepository {
	config: NonNullable<ListArticlesDependencies["pathConfig"]>;
	provider: ListArticlesDependencies["gitProvider"];
}

export interface ArticleListHandlerDependencies {
	fetch?: typeof fetch;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<ArticleListRepository>;
}

function parseArticleListQuery(request: Request): ReturnType<typeof validateArticleListQuery> {
	try {
		const parameters = new URL(request.url).searchParams;
		for (const key of parameters.keys()) {
			if (!ALLOWED_QUERY_PARAMETERS.has(key) || parameters.getAll(key).length !== 1) {
				throw new TypeError("查询参数不受支持。");
			}
		}

		const page = parameters.get("page");
		const pageSize = parameters.get("pageSize");
		const query = parameters.get("query");
		return validateArticleListQuery({
			...(page === null ? {} : { page }),
			...(pageSize === null ? {} : { pageSize }),
			...(query === null ? {} : { query }),
		});
	} catch {
		throw new ApiError(400, "INVALID_REQUEST", "文章列表查询参数无效。");
	}
}

/**
 * 文章列表 API 的可测试编排层。查询参数必须先通过白名单和列表服务边界，再消耗限流
 * 额度；GitHub 配置和 Token 只会在这些检查全部通过后由延迟工厂读取。
 */
export async function handleGetArticleList(
	context: ArticleListRequestContext,
	dependencies: ArticleListHandlerDependencies = {},
): Promise<Response> {
	guardModule("articles");
	if (!context.principal) {
		throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	}
	const query = parseArticleListQuery(context.request);

	await enforceRateLimit(context.env.RATE_LIMITER, context.principal.sub, "articles-read");

	const factoryOptions: GitHubProviderFactoryOptions = {
		readEnv: () => context.env,
	};
	if (dependencies.fetch !== undefined) {
		factoryOptions.fetch = dependencies.fetch;
	}
	const createRepositoryFactory =
		dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory;
	const repository = initializeProvider("articles", createRepositoryFactory(factoryOptions));
	if (!repository) {
		throw new ApiError(404, "NOT_FOUND", "资源不存在。");
	}

	const articles = await listArticles(query, {
		gitProvider: repository.provider,
		pathConfig: repository.config,
	});
	return jsonResponse({ articles });
}
