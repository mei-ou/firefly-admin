import { requireAdminCapability } from "../../../core/config/capabilities";
import { guardModule } from "../../../core/config/feature-flags";
import { ApiError } from "../../../core/http/errors";
import { jsonResponse } from "../../../core/http/response";
import { enforceRateLimit } from "../../../core/security/rate-limit";
import {
	createGitHubRepositoryFactory,
	type GitHubProviderFactoryOptions,
	type InitializedGitHubRepository,
} from "../../../providers/git/github-factory";
import { initializeProvider } from "../../../providers/registry";
import type { AuthenticatedPrincipal, RuntimeEnv } from "../../../types/env";
import type { ProviderFactory } from "../../../types/provider";
import {
	listRepositoryDirectory,
	parseRepositoryDirectoryPath,
} from "../services/list-repository-directory";

export interface RepositoryDirectoryRequestContext {
	request: Request;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

export interface RepositoryDirectoryHandlerDependencies {
	fetch?: typeof fetch;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<InitializedGitHubRepository>;
}

function parseQuery(request: Request): string {
	const parameters = new URL(request.url).searchParams;
	for (const key of parameters.keys()) {
		if (key !== "path" || parameters.getAll(key).length !== 1) {
			throw new ApiError(400, "INVALID_REQUEST", "仓库目录查询参数无效。");
		}
	}
	try {
		return parseRepositoryDirectoryPath(parameters.get("path") ?? "");
	} catch {
		throw new ApiError(400, "INVALID_REQUEST", "仓库目录查询参数无效。");
	}
}

export async function handleGetRepositoryDirectory(
	context: RepositoryDirectoryRequestContext,
	dependencies: RepositoryDirectoryHandlerDependencies = {},
): Promise<Response> {
	requireAdminCapability(context.env, "repositoryBrowser");
	guardModule("articles");
	if (!context.principal) {
		throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	}
	const path = parseQuery(context.request);
	await enforceRateLimit(context.env.RATE_LIMITER, context.principal.sub, "articles-read");

	const factoryOptions: GitHubProviderFactoryOptions = { readEnv: () => context.env };
	if (dependencies.fetch) factoryOptions.fetch = dependencies.fetch;
	const repository = initializeProvider(
		"articles",
		(dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory)(factoryOptions),
	);
	if (!repository) throw new ApiError(404, "NOT_FOUND", "资源不存在。");

	const directory = await listRepositoryDirectory(path, { gitProvider: repository.provider });
	return jsonResponse({ directory });
}
