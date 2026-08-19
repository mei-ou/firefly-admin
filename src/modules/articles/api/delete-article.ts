import { z } from "zod";
import { type AuditWriter, writeAuditEvent } from "../../../core/audit/audit-log";
import { requireAdminCapability } from "../../../core/config/capabilities";
import { guardModule } from "../../../core/config/feature-flags";
import { ApiError } from "../../../core/http/errors";
import { jsonResponse } from "../../../core/http/response";
import { D1IdempotencyStore } from "../../../core/idempotency/d1-idempotency-store";
import { executeIdempotently } from "../../../core/idempotency/execute-idempotently";
import type { IdempotencyStore } from "../../../core/idempotency/types";
import { createIdempotencyScope, parseIdempotencyKey } from "../../../core/security/idempotency";
import { enforceRateLimit } from "../../../core/security/rate-limit";
import {
	createGitHubRepositoryFactory,
	type GitHubProviderFactoryOptions,
} from "../../../providers/git/github-factory";
import type { GitProvider } from "../../../providers/git/types";
import { initializeProvider } from "../../../providers/registry";
import type { ArticleDeleteResult } from "../../../types/article";
import type { AuthenticatedPrincipal, RuntimeEnv } from "../../../types/env";
import type { ProviderFactory } from "../../../types/provider";
import { parseSlug } from "../../../utils/slug-utils";
import {
	commitArticleDelete,
	type PrepareArticleDeleteDependencies,
	prepareArticleDelete,
} from "../services/delete-article";
import { recoverDeletedArticle } from "../services/recover-deleted-article";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const requestBodySchema = z
	.object({
		expectedHeadSha: z.string().regex(GIT_OBJECT_SHA),
		expectedSha: z.string().regex(GIT_OBJECT_SHA),
	})
	.strict();
const articleDeleteResultSchema = z
	.object({
		storageSlug: z.string(),
		pathAlias: z.string(),
		commitSha: z.string().regex(GIT_OBJECT_SHA),
		commitUrl: z.url().refine((value) => new URL(value).origin === "https://github.com"),
		deletedFiles: z.array(z.string().min(1).max(240)).min(1).max(6),
	})
	.strict();

interface ArticleDeleteRepository {
	config: NonNullable<PrepareArticleDeleteDependencies["pathConfig"]>;
	provider: Pick<
		GitProvider,
		"commitFilesAtomically" | "getFileAtCommit" | "getHead" | "listDirectoryAtCommit"
	>;
}

export interface DeleteArticleRequestContext {
	request: Request;
	requestId: string;
	slug: unknown;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

export interface DeleteArticleHandlerDependencies {
	fetch?: typeof fetch;
	now?: () => number;
	auditWriter?: AuditWriter;
	createIdempotencyStore?: () => IdempotencyStore<ArticleDeleteResult>;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<ArticleDeleteRepository>;
}

async function parseJsonBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ApiError(400, "INVALID_REQUEST", "请求 JSON 无效。");
	}
}

async function createRequestHash(
	storageSlug: string,
	expectedHeadSha: string,
	expectedSha: string,
): Promise<string> {
	const encoded = new TextEncoder().encode(
		JSON.stringify({ storageSlug, expectedHeadSha, expectedSha }),
	);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 删除能力先由服务端发布状态和部署开关裁决，再进行认证、限流、D1 和 Provider 初始化。
 * 客户端只提供读取时的 HEAD/Blob SHA，删除路径集合始终由同一 HEAD 的仓库快照派生。
 */
export async function handleDeleteArticle(
	context: DeleteArticleRequestContext,
	dependencies: DeleteArticleHandlerDependencies = {},
): Promise<Response> {
	guardModule("articles");
	requireAdminCapability(context.env, "articleDelete");
	if (!context.principal) {
		throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	}
	if (!context.env.IDEMPOTENCY_DB && !dependencies.createIdempotencyStore) {
		throw new ApiError(503, "IDEMPOTENCY_UNAVAILABLE", "重复提交保护服务暂时不可用。");
	}

	const storageSlug = parseSlug(context.slug);
	const idempotencyKey = parseIdempotencyKey(context.request);
	const body = requestBodySchema.safeParse(await parseJsonBody(context.request));
	if (!body.success) {
		throw new ApiError(400, "INVALID_REQUEST", "文章删除请求无效。");
	}
	const requestHash = await createRequestHash(
		storageSlug,
		body.data.expectedHeadSha,
		body.data.expectedSha,
	);
	await enforceRateLimit(context.env.RATE_LIMITER, context.principal.sub, "article-delete");

	const now = dependencies.now ?? Date.now;
	const store =
		dependencies.createIdempotencyStore?.() ??
		new D1IdempotencyStore(
			context.env.IDEMPOTENCY_DB as NonNullable<RuntimeEnv["IDEMPOTENCY_DB"]>,
			(input) => articleDeleteResultSchema.parse(input),
			now,
		);
	const scope = createIdempotencyScope(context.principal.sub, "article-delete", idempotencyKey);
	let initializedRepository: ArticleDeleteRepository | undefined;
	const getRepository = (): ArticleDeleteRepository => {
		if (initializedRepository) return initializedRepository;
		const factoryOptions: GitHubProviderFactoryOptions = { readEnv: () => context.env };
		if (dependencies.fetch !== undefined) factoryOptions.fetch = dependencies.fetch;
		const factory = dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory;
		const repository = initializeProvider("articles", factory(factoryOptions));
		if (!repository) throw new ApiError(404, "NOT_FOUND", "资源不存在。");
		initializedRepository = repository;
		return repository;
	};
	const output = await executeIdempotently({
		store,
		scope,
		requestHash,
		expiresAt: now() + IDEMPOTENCY_TTL_MS,
		recovery: { kind: "article-delete", storageSlug },
		recoverUnknown: async ({ baseHeadSha, candidateCommitSha }) => {
			if (baseHeadSha !== body.data.expectedHeadSha || !candidateCommitSha) return undefined;
			const repository = getRepository();
			return recoverDeletedArticle(storageSlug, baseHeadSha, candidateCommitSha, {
				gitProvider: repository.provider,
				pathConfig: repository.config,
			});
		},
		execute: async ({ markSideEffectPossible }) => {
			if (!store.markUnknown || !store.recordCandidateCommit) {
				throw new ApiError(503, "IDEMPOTENCY_UNAVAILABLE", "重复提交保护服务暂时不可用。");
			}
			const repository = getRepository();
			const plan = await prepareArticleDelete(
				storageSlug,
				body.data.expectedHeadSha,
				body.data.expectedSha,
				{ gitProvider: repository.provider, pathConfig: repository.config },
			);
			await store.markUnknown({
				scope,
				requestHash,
				baseHeadSha: body.data.expectedHeadSha,
				recovery: { kind: "article-delete", storageSlug },
			});
			markSideEffectPossible();
			return commitArticleDelete(plan, {
				gitProvider: repository.provider,
				checkpointCandidateCommit: async (candidateCommitSha) => {
					await store.recordCandidateCommit?.({ scope, requestHash, candidateCommitSha });
				},
			});
		},
	});

	writeAuditEvent(
		{
			requestId: context.requestId,
			subject: context.principal.sub,
			action: "article.delete",
			outcome: "success",
			target: storageSlug,
			timestamp: new Date(now()).toISOString(),
			metadata: {
				commitSha: output.result.commitSha,
				replayed: output.replayed,
				deletedFileCount: output.result.deletedFiles.length,
			},
		},
		dependencies.auditWriter,
	);
	const response = jsonResponse({ deletion: output.result });
	response.headers.set("Idempotency-Replayed", output.replayed ? "true" : "false");
	return response;
}
