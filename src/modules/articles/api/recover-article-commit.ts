import { z } from "zod";
import { type AuditWriter, writeAuditEvent } from "../../../core/audit/audit-log";
import { buildExpectedArticleUrl, loadArticleUrlTemplate } from "../../../core/config/article-url";
import { guardModule } from "../../../core/config/feature-flags";
import { ApiError } from "../../../core/http/errors";
import { jsonResponse } from "../../../core/http/response";
import { D1IdempotencyStore } from "../../../core/idempotency/d1-idempotency-store";
import type { IdempotencyStatus, IdempotencyStore } from "../../../core/idempotency/types";
import { createIdempotencyScope, parseIdempotencyKey } from "../../../core/security/idempotency";
import { enforceRateLimit } from "../../../core/security/rate-limit";
import {
	createGitHubRepositoryFactory,
	type GitHubProviderFactoryOptions,
} from "../../../providers/git/github-factory";
import type { GitProvider } from "../../../providers/git/types";
import { initializeProvider } from "../../../providers/registry";
import type { AuthenticatedPrincipal, RuntimeEnv } from "../../../types/env";
import type { ProviderFactory } from "../../../types/provider";
import { recoverArticleCommit } from "../services/recover-article-commit";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const operationSchema = z.enum([
	"article-create-draft",
	"article-create-publish",
	"article-update-draft",
	"article-update-publish",
]);
const confirmBodySchema = z
	.object({
		operation: operationSchema,
		baseHeadSha: z.string().regex(GIT_OBJECT_SHA),
	})
	.strict();

interface ArticleRecoveryRepository {
	config: Parameters<typeof recoverArticleCommit>[2]["pathConfig"];
	provider: Pick<GitProvider, "getFileAtCommit" | "getHead">;
}

export interface RecoverArticleCommitRequestContext {
	request: Request;
	requestId: string;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

export interface RecoverArticleCommitHandlerDependencies {
	fetch?: typeof fetch;
	now?: () => number;
	auditWriter?: AuditWriter;
	createIdempotencyStore?: () => IdempotencyStore<ArticleRecoveryResult>;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<ArticleRecoveryRepository>;
}

const articleRecoveryResultSchema = z
	.object({
		storageSlug: z.string(),
		pathAlias: z.string(),
		commitSha: z.string().regex(GIT_OBJECT_SHA),
		commitUrl: z.url().refine((value) => new URL(value).origin === "https://github.com"),
		fileSha: z.string().regex(GIT_OBJECT_SHA),
		expectedArticleUrl: z
			.url()
			.refine((value) => new URL(value).protocol === "https:")
			.optional(),
	})
	.strict();

type ArticleRecoveryResult = z.infer<typeof articleRecoveryResultSchema>;
type ArticleOperation = z.infer<typeof operationSchema>;

function parseOperation(input: unknown): ArticleOperation {
	const parsed = operationSchema.safeParse(input);
	if (!parsed.success) throw new ApiError(400, "INVALID_REQUEST", "文章恢复操作无效。");
	return parsed.data;
}

function matchesRecoveryContext(
	operation: ArticleOperation,
	kind: "article-create" | "article-update",
): boolean {
	return operation.startsWith("article-create")
		? kind === "article-create"
		: kind === "article-update";
}

function createStore(
	context: RecoverArticleCommitRequestContext,
	dependencies: RecoverArticleCommitHandlerDependencies,
): IdempotencyStore<ArticleRecoveryResult> {
	if (dependencies.createIdempotencyStore) return dependencies.createIdempotencyStore();
	if (!context.env.IDEMPOTENCY_DB) {
		throw new ApiError(503, "IDEMPOTENCY_UNAVAILABLE", "重复提交保护服务暂时不可用。");
	}
	return new D1IdempotencyStore(
		context.env.IDEMPOTENCY_DB,
		(input) => articleRecoveryResultSchema.parse(input),
		dependencies.now ?? Date.now,
	);
}

function createRepository(
	context: RecoverArticleCommitRequestContext,
	dependencies: RecoverArticleCommitHandlerDependencies,
): ArticleRecoveryRepository {
	const factoryOptions: GitHubProviderFactoryOptions = { readEnv: () => context.env };
	if (dependencies.fetch !== undefined) factoryOptions.fetch = dependencies.fetch;
	const factory = dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory;
	const repository = initializeProvider("articles", factory(factoryOptions));
	if (!repository) throw new ApiError(404, "NOT_FOUND", "资源不存在。");
	return repository;
}

function publicStatus(
	operation: ArticleOperation,
	status: IdempotencyStatus<ArticleRecoveryResult> | undefined,
) {
	if (!status) return { operation, status: "not-found" as const };
	return {
		operation,
		status: status.state,
		...(status.recovery === undefined ? {} : { recovery: status.recovery }),
		...(status.baseHeadSha === undefined ? {} : { baseHeadSha: status.baseHeadSha }),
		...(status.candidateCommitSha === undefined
			? {}
			: { candidateCommitSha: status.candidateCommitSha }),
		...(status.result === undefined ? {} : { result: status.result }),
		expiresAt: status.expiresAt,
		canConfirm: status.state === "unknown" && status.candidateCommitSha !== undefined,
	};
}

/**
 * 人工恢复只操作 D1 幂等记录。确认路径只读取当前 HEAD 和候选 Commit，绝不调用任何
 * Git 写入方法；因此无法证明候选已成为 HEAD 时，记录会继续保持 unknown。
 */
export async function handleRecoverArticleCommit(
	context: RecoverArticleCommitRequestContext,
	dependencies: RecoverArticleCommitHandlerDependencies = {},
): Promise<Response> {
	guardModule("articles");
	if (!context.principal) throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	await enforceRateLimit(context.env.RATE_LIMITER, context.principal.sub, "articles-read");

	const url = new URL(context.request.url);
	let confirmation: z.infer<typeof confirmBodySchema> | undefined;
	let operation: ArticleOperation;
	if (context.request.method === "GET") {
		operation = parseOperation(url.searchParams.get("operation"));
	} else {
		let body: unknown;
		try {
			body = await context.request.json();
		} catch {
			throw new ApiError(400, "INVALID_REQUEST", "请求 JSON 无效。");
		}
		const parsedBody = confirmBodySchema.safeParse(body);
		if (!parsedBody.success) {
			throw new ApiError(400, "INVALID_REQUEST", "文章恢复确认请求无效。");
		}
		confirmation = parsedBody.data;
		operation = confirmation.operation;
	}
	const idempotencyKey = parseIdempotencyKey(context.request);
	const scope = createIdempotencyScope(context.principal.sub, operation, idempotencyKey);
	const store = createStore(context, dependencies);
	if (!store.getStatusByScope) {
		throw new ApiError(503, "IDEMPOTENCY_UNAVAILABLE", "幂等恢复能力暂时不可用。");
	}
	const status = await store.getStatusByScope(scope);
	if (!status) return jsonResponse({ recovery: publicStatus(operation, undefined) }, 404);

	if (context.request.method === "GET") {
		return jsonResponse({ recovery: publicStatus(operation, status) });
	}
	if (status.state !== "unknown") {
		return jsonResponse({ recovery: publicStatus(operation, status) });
	}
	if (!confirmation || confirmation.baseHeadSha !== status.baseHeadSha) {
		throw new ApiError(409, "CONFLICT", "人工确认基线与幂等记录不一致。");
	}
	if (!status.candidateCommitSha || !status.recovery) {
		throw new ApiError(409, "COMMIT_STATUS_UNKNOWN", "缺少候选 Commit，仍需人工核对。");
	}
	if (
		status.recovery.kind === "article-delete" ||
		!matchesRecoveryContext(operation, status.recovery.kind)
	) {
		throw new ApiError(409, "CONFLICT", "恢复操作与原始文章操作不一致。");
	}

	const repository = createRepository(context, dependencies);
	const recovered = await recoverArticleCommit(
		status.recovery.storageSlug,
		status.candidateCommitSha,
		{
			gitProvider: repository.provider,
			...(repository.config === undefined ? {} : { pathConfig: repository.config }),
		},
	);
	if (!recovered)
		throw new ApiError(409, "COMMIT_STATUS_UNKNOWN", "当前分支未指向候选 Commit，请人工核对。");
	const expectedArticleUrl = buildExpectedArticleUrl(
		loadArticleUrlTemplate(context.env),
		recovered.storageSlug,
	);
	const result = articleRecoveryResultSchema.parse(
		expectedArticleUrl ? { ...recovered, expectedArticleUrl } : recovered,
	);
	if (!store.completeUnknown) {
		throw new ApiError(503, "IDEMPOTENCY_UNAVAILABLE", "幂等恢复能力暂时不可用。");
	}
	await store.completeUnknown({ scope, requestHash: status.requestHash, result });
	writeAuditEvent(
		{
			requestId: context.requestId,
			subject: context.principal.sub,
			action: "article.commit-recover",
			outcome: "success",
			target: recovered.storageSlug,
			timestamp: new Date((dependencies.now ?? Date.now)()).toISOString(),
			metadata: { commitSha: recovered.commitSha, operation },
		},
		dependencies.auditWriter,
	);
	return jsonResponse({
		recovery: publicStatus(operation, { ...status, state: "completed", result }),
	});
}
