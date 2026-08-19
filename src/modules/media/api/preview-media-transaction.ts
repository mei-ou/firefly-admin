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
import type { GitProvider } from "../../../providers/git/types";
import { initializeProvider } from "../../../providers/registry";
import type { AuthenticatedPrincipal, RuntimeEnv } from "../../../types/env";
import type { ProviderFactory } from "../../../types/provider";
import type { MediaTransactionPreviewStore } from "../d1-media-transaction-preview-store";
import { D1MediaTransactionPreviewStore } from "../d1-media-transaction-preview-store";
import {
	createMediaTransactionPreviewRequestHash,
	parseMediaTransactionPreviewRequest,
} from "../media-transaction-preview";
import { previewMediaTransaction } from "../services/preview-media-transaction";

interface MediaPreviewRepository {
	config: {
		contentRoot: string;
		entryFilename: string;
		usePageBundle: boolean;
	};
	provider: Pick<GitProvider, "getHead" | "getFileAtCommit" | "listDirectoryAtCommit">;
}

export interface PreviewMediaTransactionRequestContext {
	request: Request;
	requestId: string;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

export interface PreviewMediaTransactionHandlerDependencies {
	fetch?: typeof fetch;
	now?: () => number;
	createPreviewId?: () => string;
	auditWriter?: AuditWriter;
	createPreviewStore?: (repository: MediaPreviewRepository) => MediaTransactionPreviewStore;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<MediaPreviewRepository>;
}

async function parseJsonBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ApiError(400, "INVALID_REQUEST", "请求 JSON 无效。");
	}
}

/**
 * 资源事务 Preview 编排层只读取 Git 快照并写入短 TTL D1 令牌。
 * 它不接收正文、不访问 R2，也不暴露任何 Git 写能力。
 */
export async function handlePreviewMediaTransaction(
	context: PreviewMediaTransactionRequestContext,
	dependencies: PreviewMediaTransactionHandlerDependencies = {},
): Promise<Response> {
	guardModule("articles");
	if (!context.principal) throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	const request = parseMediaTransactionPreviewRequest(await parseJsonBody(context.request));
	requireAdminCapability(
		context.env,
		request.operation === "rename" ? "articleAssetRename" : "crossArticleAssetMove",
	);
	if (!context.env.IDEMPOTENCY_DB && !dependencies.createPreviewStore) {
		throw new ApiError(503, "MEDIA_PREVIEW_UNAVAILABLE", "资源影响预览服务暂时不可用。");
	}
	await enforceRateLimit(
		context.env.RATE_LIMITER,
		context.principal.sub,
		"media-transaction-preview",
	);

	const factoryOptions: GitHubProviderFactoryOptions = { readEnv: () => context.env };
	if (dependencies.fetch !== undefined) factoryOptions.fetch = dependencies.fetch;
	const createRepositoryFactory =
		dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory;
	const repository = initializeProvider("articles", createRepositoryFactory(factoryOptions));
	if (!repository) throw new ApiError(404, "NOT_FOUND", "资源不存在。");

	const requestHash = await createMediaTransactionPreviewRequestHash(request);
	const preview = await previewMediaTransaction(request, {
		gitProvider: repository.provider,
		pathConfig: repository.config,
		...(dependencies.now === undefined ? {} : { now: dependencies.now }),
		...(dependencies.createPreviewId === undefined
			? {}
			: { createPreviewId: dependencies.createPreviewId }),
	});
	const store =
		dependencies.createPreviewStore?.(repository) ??
		new D1MediaTransactionPreviewStore(
			context.env.IDEMPOTENCY_DB as NonNullable<RuntimeEnv["IDEMPOTENCY_DB"]>,
			dependencies.now ?? Date.now,
			repository.config,
		);
	const stored = await store.createOrReuse({
		subject: context.principal.sub,
		requestHash,
		preview,
	});
	const now = dependencies.now?.() ?? Date.now();
	writeAuditEvent(
		{
			requestId: context.requestId,
			subject: context.principal.sub,
			action: "media.transaction-preview",
			outcome: "success",
			target: request.operation === "rename" ? request.storageSlug : request.source.storageSlug,
			timestamp: new Date(now).toISOString(),
			metadata: {
				previewId: stored.preview.previewId,
				operation: stored.preview.operation,
				riskLevel: stored.preview.riskLevel,
				effectCount: stored.preview.effects.length,
				referenceCount:
					stored.preview.operation === "rename"
						? stored.preview.references.length
						: stored.preview.source.references.length +
							stored.preview.destination.references.length,
				baseCommitSha: stored.preview.baseCommitSha,
				reused: stored.reused,
			},
		},
		dependencies.auditWriter,
	);
	const response = jsonResponse({ preview: stored.preview });
	response.headers.set("Cache-Control", "no-store");
	response.headers.set("Preview-Reused", stored.reused ? "true" : "false");
	return response;
}
