import { type AuditWriter, writeAuditEvent } from "../../../core/audit/audit-log";
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
import { parseMediaTransactionTargetsRequest } from "../media-transaction-targets";
import {
	type ListMediaTransactionTargetsDependencies,
	listMediaTransactionTargets,
} from "../services/list-media-transaction-targets";

interface MediaTransactionTargetsRepository {
	config: ListMediaTransactionTargetsDependencies["pathConfig"];
	provider: ListMediaTransactionTargetsDependencies["gitProvider"];
}

export interface MediaTransactionTargetsRequestContext {
	request: Request;
	requestId: string;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

export interface MediaTransactionTargetsHandlerDependencies {
	fetch?: typeof fetch;
	now?: () => number;
	auditWriter?: AuditWriter;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<MediaTransactionTargetsRepository>;
}

function parseQuery(request: Request): ReturnType<typeof parseMediaTransactionTargetsRequest> {
	const parameters = new URL(request.url).searchParams;
	const allowed = new Set(["expectedHeadSha", "sourceStorageSlug", "sourceArticleSha"]);
	for (const key of parameters.keys()) {
		if (!allowed.has(key) || parameters.getAll(key).length !== 1) {
			throw new ApiError(400, "INVALID_REQUEST", "媒体事务目标查询参数无效。");
		}
	}
	try {
		return parseMediaTransactionTargetsRequest({
			expectedHeadSha: parameters.get("expectedHeadSha"),
			source: {
				storageSlug: parameters.get("sourceStorageSlug"),
				articleSha: parameters.get("sourceArticleSha"),
			},
		});
	} catch {
		throw new ApiError(400, "INVALID_REQUEST", "媒体事务目标查询参数无效。");
	}
}

/** 只读目标选择快照；认证、限流和 Provider 初始化均发生在不可变 Commit 扫描之前。 */
export async function handleGetMediaTransactionTargets(
	context: MediaTransactionTargetsRequestContext,
	dependencies: MediaTransactionTargetsHandlerDependencies = {},
): Promise<Response> {
	requireAdminCapability(context.env, "crossArticleAssetMove");
	guardModule("articles");
	if (!context.principal) throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	const request = parseQuery(context.request);
	await enforceRateLimit(
		context.env.RATE_LIMITER,
		context.principal.sub,
		"media-transaction-targets",
	);

	const factoryOptions: GitHubProviderFactoryOptions = { readEnv: () => context.env };
	if (dependencies.fetch !== undefined) factoryOptions.fetch = dependencies.fetch;
	const repositoryFactory = dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory;
	const repository = initializeProvider("articles", repositoryFactory(factoryOptions));
	if (!repository) throw new ApiError(404, "NOT_FOUND", "资源不存在。");

	const targets = await listMediaTransactionTargets(request, {
		gitProvider: repository.provider,
		pathConfig: repository.config,
	});
	writeAuditEvent(
		{
			requestId: context.requestId,
			subject: context.principal.sub,
			action: "media.transaction-targets",
			outcome: "success",
			target: request.source.storageSlug,
			timestamp: new Date((dependencies.now ?? Date.now)()).toISOString(),
			metadata: {
				baseCommitSha: targets.baseCommitSha,
				itemCount: targets.items.length,
				truncated: targets.truncated,
			},
		},
		dependencies.auditWriter,
	);
	return jsonResponse({ targets });
}
