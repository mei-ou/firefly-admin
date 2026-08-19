import { type AuditWriter, writeAuditEvent } from "../../../core/audit/audit-log";
import {
	requireAdminCapability,
	resolveAdminCapabilities,
} from "../../../core/config/capabilities";
import { guardModule } from "../../../core/config/feature-flags";
import { ApiError } from "../../../core/http/errors";
import { jsonResponse } from "../../../core/http/response";
import { parseIdempotencyKey } from "../../../core/security/idempotency";
import { enforceRateLimit } from "../../../core/security/rate-limit";
import {
	createGitHubRepositoryFactory,
	type GitHubProviderFactoryOptions,
} from "../../../providers/git/github-factory";
import type { GitProvider } from "../../../providers/git/types";
import { initializeProvider } from "../../../providers/registry";
import type { AuthenticatedPrincipal, RuntimeEnv } from "../../../types/env";
import type { ProviderFactory } from "../../../types/provider";
import {
	D1MediaTransactionPreviewStore,
	type MediaTransactionCommitAttempt,
	type MediaTransactionCommitIdentity,
	type MediaTransactionCommitReadResult,
	type MediaTransactionPreviewCommitStore,
} from "../d1-media-transaction-preview-store";
import {
	createMediaTransactionCommitIdempotencyKeyHash,
	createMediaTransactionCommitRequestHash,
	type MediaTransactionCommitRequest,
	type MediaTransactionCommitResult,
	parseMediaTransactionCommitRequest,
} from "../media-transaction-commit";
import type { MediaTransactionPreview } from "../media-transaction-preview";
import { executeMediaTransactionCommit } from "../services/execute-media-transaction-commit";
import { prepareMediaTransactionCommit } from "../services/prepare-media-transaction-commit";
import { recoverMediaTransactionCommit } from "../services/recover-media-transaction-commit";

const CLAIM_LEASE_MS = 60_000;

interface MediaTransactionRepository {
	config: {
		contentRoot: string;
		entryFilename: string;
		usePageBundle: boolean;
	};
	provider: Pick<
		GitProvider,
		"getHead" | "getFileAtCommit" | "listDirectoryAtCommit" | "commitFilesAtomically"
	>;
}

export interface CommitMediaTransactionRequestContext {
	request: Request;
	requestId: string;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

export interface CommitMediaTransactionHandlerDependencies {
	fetch?: typeof fetch;
	now?: () => number;
	createClaimToken?: () => string;
	auditWriter?: AuditWriter;
	createCommitStore?: (
		repository: MediaTransactionRepository,
	) => MediaTransactionPreviewCommitStore;
	prepareCommit?: typeof prepareMediaTransactionCommit;
	executeCommit?: typeof executeMediaTransactionCommit;
	recoverCommit?: typeof recoverMediaTransactionCommit;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<MediaTransactionRepository>;
}

async function parseJsonBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ApiError(400, "INVALID_REQUEST", "请求 JSON 无效。");
	}
}

function unavailable(message = "资源事务提交服务暂时不可用。"): ApiError {
	return new ApiError(503, "MEDIA_TRANSACTION_UNAVAILABLE", message);
}

function unknown(): ApiError {
	return new ApiError(
		503,
		"COMMIT_STATUS_UNKNOWN",
		"提交状态暂时无法确认，请使用原幂等键重试查询。",
	);
}

function assertConfirmation(
	request: MediaTransactionCommitRequest,
	state: { preview: unknown },
	pathConfig: MediaTransactionRepository["config"],
): void {
	try {
		parseMediaTransactionCommitRequest(request, state.preview, pathConfig);
	} catch {
		throw new ApiError(400, "MEDIA_CONFIRMATION_INVALID", "资源事务确认无效。");
	}
}

function stateError(state: MediaTransactionCommitReadResult): never {
	if (state.state === "expired" || state.state === "not-found") {
		throw new ApiError(410, "MEDIA_PREVIEW_EXPIRED", "资源影响预览不存在或已过期。");
	}
	if (state.state === "committing") {
		throw new ApiError(409, "MEDIA_PREVIEW_IN_PROGRESS", "资源事务正在提交，请使用原幂等键重试。");
	}
	if (state.state === "conflict") {
		throw new ApiError(409, "CONFLICT", "Preview 已绑定其他提交请求或幂等键。");
	}
	throw unavailable();
}

function successResponse(result: MediaTransactionCommitResult, replayed: boolean): Response {
	const response = jsonResponse({ transaction: result });
	response.headers.set("Cache-Control", "no-store");
	response.headers.set("Idempotency-Replayed", replayed ? "true" : "false");
	return response;
}

function auditSuccess(
	context: CommitMediaTransactionRequestContext,
	result: MediaTransactionCommitResult,
	state: { preview: MediaTransactionPreview },
	options: { replayed: boolean; recovered: boolean; candidateCommitSha: string },
	dependencies: CommitMediaTransactionHandlerDependencies,
): void {
	const preview = state.preview;
	writeAuditEvent(
		{
			requestId: context.requestId,
			subject: context.principal?.sub ?? "anonymous",
			action: "media.transaction-commit",
			outcome: "success",
			target: preview.operation === "rename" ? preview.storageSlug : preview.source.storageSlug,
			timestamp: new Date((dependencies.now ?? Date.now)()).toISOString(),
			metadata: {
				previewId: result.previewId,
				storageSlug:
					preview.operation === "rename" ? preview.storageSlug : preview.source.storageSlug,
				operation: preview.operation,
				riskLevel: preview.riskLevel,
				referenceCount:
					preview.operation === "rename"
						? preview.references.length
						: preview.source.references.length + preview.destination.references.length,
				candidateCommitSha: options.candidateCommitSha,
				commitSha: result.commitSha,
				replayed: options.replayed,
				recovered: options.recovered,
			},
		},
		dependencies.auditWriter,
	);
}

/** Preview 驱动的提交状态机；unknown 分支只读恢复，绝不会使用新幂等键再次写 Git。 */
export async function handleCommitMediaTransaction(
	context: CommitMediaTransactionRequestContext,
	dependencies: CommitMediaTransactionHandlerDependencies = {},
): Promise<Response> {
	guardModule("articles");
	if (!context.principal) throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	if (!context.env.IDEMPOTENCY_DB && !dependencies.createCommitStore) throw unavailable();
	const capabilities = resolveAdminCapabilities(context.env);
	if (!capabilities.articleAssetRename && !capabilities.crossArticleAssetMove) {
		throw new ApiError(404, "NOT_FOUND", "资源不存在。");
	}

	let request: MediaTransactionCommitRequest;
	try {
		request = parseMediaTransactionCommitRequest(await parseJsonBody(context.request));
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError(400, "INVALID_REQUEST", "资源事务提交请求无效。");
	}
	const idempotencyKey = parseIdempotencyKey(context.request);
	await enforceRateLimit(
		context.env.RATE_LIMITER,
		context.principal.sub,
		"media-transaction-commit",
	);

	const factoryOptions: GitHubProviderFactoryOptions = { readEnv: () => context.env };
	if (dependencies.fetch !== undefined) factoryOptions.fetch = dependencies.fetch;
	const repositoryFactory = dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory;
	const repository = initializeProvider("articles", repositoryFactory(factoryOptions));
	if (!repository) throw new ApiError(404, "NOT_FOUND", "资源不存在。");
	const store =
		dependencies.createCommitStore?.(repository) ??
		new D1MediaTransactionPreviewStore(
			context.env.IDEMPOTENCY_DB as NonNullable<RuntimeEnv["IDEMPOTENCY_DB"]>,
			dependencies.now ?? Date.now,
			repository.config,
		);
	const identity: MediaTransactionCommitIdentity = {
		previewId: request.previewId,
		subject: context.principal.sub,
		idempotencyKeyHash: await createMediaTransactionCommitIdempotencyKeyHash(idempotencyKey),
		requestHash: await createMediaTransactionCommitRequestHash(request),
	};

	let initial: MediaTransactionCommitReadResult;
	try {
		initial = await store.getForCommit(identity);
	} catch (error) {
		if (error instanceof ApiError && error.code === "MEDIA_PREVIEW_UNAVAILABLE")
			throw unavailable();
		throw error;
	}
	if (initial.state === "consumed") {
		requireAdminCapability(
			context.env,
			initial.preview.operation === "rename" ? "articleAssetRename" : "crossArticleAssetMove",
		);
		assertConfirmation(request, initial, repository.config);
		auditSuccess(
			context,
			initial.result,
			initial,
			{
				replayed: true,
				recovered: false,
				candidateCommitSha: initial.candidateCommitSha,
			},
			dependencies,
		);
		return successResponse(initial.result, true);
	}
	if (initial.state === "unknown") {
		requireAdminCapability(
			context.env,
			initial.preview.operation === "rename" ? "articleAssetRename" : "crossArticleAssetMove",
		);
		assertConfirmation(request, initial, repository.config);
		if (!initial.candidateCommitSha) throw unknown();
		const recoverCommit = dependencies.recoverCommit ?? recoverMediaTransactionCommit;
		const recovered = await recoverCommit(
			initial.plan,
			initial.preview,
			initial.candidateCommitSha,
			{
				gitProvider: repository.provider,
				pathConfig: repository.config,
				...(dependencies.now === undefined ? {} : { now: dependencies.now }),
			},
		);
		if (!recovered) throw unknown();
		try {
			await store.completeRecovered({
				...identity,
				planHash: initial.planHash,
				candidateCommitSha: initial.candidateCommitSha,
				result: recovered,
			});
		} catch {
			const status = await store.getForCommit(identity);
			if (status.state !== "consumed") throw unknown();
			return successResponse(status.result, true);
		}
		auditSuccess(
			context,
			recovered,
			initial,
			{
				replayed: true,
				recovered: true,
				candidateCommitSha: initial.candidateCommitSha,
			},
			dependencies,
		);
		return successResponse(recovered, true);
	}
	if (initial.state !== "ready") stateError(initial);
	requireAdminCapability(
		context.env,
		initial.preview.operation === "rename" ? "articleAssetRename" : "crossArticleAssetMove",
	);
	assertConfirmation(request, initial, repository.config);

	const attempt: MediaTransactionCommitAttempt = {
		...identity,
		claimToken:
			dependencies.createClaimToken?.() ?? `claim_${crypto.randomUUID().replaceAll("-", "")}`,
	};
	const claimed = await store.claimCommit({ ...attempt, leaseMs: CLAIM_LEASE_MS });
	if (claimed.state !== "claimed") {
		if (claimed.state === "consumed") {
			assertConfirmation(request, claimed, repository.config);
			auditSuccess(
				context,
				claimed.result,
				claimed,
				{
					replayed: true,
					recovered: false,
					candidateCommitSha: claimed.candidateCommitSha,
				},
				dependencies,
			);
			return successResponse(claimed.result, true);
		}
		if (claimed.state === "unknown") throw unknown();
		stateError(claimed);
	}
	assertConfirmation(request, claimed, repository.config);

	let plan: Awaited<ReturnType<typeof prepareMediaTransactionCommit>>;
	try {
		const prepareCommit = dependencies.prepareCommit ?? prepareMediaTransactionCommit;
		plan = await prepareCommit(claimed.preview, {
			gitProvider: repository.provider,
			pathConfig: repository.config,
		});
	} catch (error) {
		await store.releaseBeforeCandidate(attempt);
		throw error;
	}
	const armed = await store.armUnknown({ ...attempt, plan });
	let candidateCheckpointAttempted = false;
	let candidateCommitSha: string | undefined;
	let result: MediaTransactionCommitResult;
	try {
		const executeCommit = dependencies.executeCommit ?? executeMediaTransactionCommit;
		result = await executeCommit(armed.plan, claimed.preview, {
			gitProvider: repository.provider,
			pathConfig: repository.config,
			checkpointCandidateCommit: async (candidate) => {
				candidateCheckpointAttempted = true;
				await store.recordCandidateCommit({
					...attempt,
					planHash: armed.planHash,
					candidateCommitSha: candidate,
				});
				candidateCommitSha = candidate;
			},
			...(dependencies.now === undefined ? {} : { now: dependencies.now }),
		});
	} catch (error) {
		if (!candidateCheckpointAttempted) {
			try {
				await store.releaseBeforeCandidate({ ...attempt, planHash: armed.planHash });
			} catch {
				throw unknown();
			}
			throw error;
		}
		throw unknown();
	}
	if (!candidateCommitSha || candidateCommitSha !== result.commitSha) throw unknown();
	try {
		await store.consume({
			...attempt,
			planHash: armed.planHash,
			candidateCommitSha,
			result,
		});
	} catch {
		const status = await store.getForCommit(identity);
		if (status.state !== "consumed") throw unknown();
		result = status.result;
	}
	auditSuccess(
		context,
		result,
		claimed,
		{ replayed: false, recovered: false, candidateCommitSha },
		dependencies,
	);
	return successResponse(result, false);
}
