import { z } from "zod";
import { type AuditWriter, writeAuditEvent } from "../../../core/audit/audit-log";
import { buildExpectedArticleUrl, loadArticleUrlTemplate } from "../../../core/config/article-url";
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
import type { AuthenticatedPrincipal, RuntimeEnv } from "../../../types/env";
import type { ProviderFactory } from "../../../types/provider";
import { parseSlug } from "../../../utils/slug-utils";
import { parseStagedArticleAssetManifest } from "../../media/article-asset-manifest";
import { loadStagedArticleAssets } from "../../media/services/load-staged-article-assets";
import { parseArticleEditorInput } from "../article-schema";
import { recoverArticleCommit } from "../services/recover-article-commit";
import { createArticle, type WriteArticleDependencies } from "../services/write-article";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const requestBodySchema = z
	.object({
		storageSlug: z.unknown(),
		expectedHeadSha: z.string().regex(/^[a-f0-9]{40,64}$/),
		article: z.unknown(),
		assetManifest: z.unknown().optional(),
		action: z.enum(["draft", "publish"]).default("draft"),
	})
	.strict();
const articleCommitResultSchema = z
	.object({
		storageSlug: z.string(),
		pathAlias: z.string(),
		commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
		commitUrl: z.url().refine((value) => new URL(value).origin === "https://github.com"),
		fileSha: z.string().regex(/^[a-f0-9]{40,64}$/),
		expectedArticleUrl: z
			.url()
			.refine((value) => new URL(value).protocol === "https:")
			.optional(),
	})
	.strict();

export interface CreateArticleRequestContext {
	request: Request;
	requestId: string;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

export interface CreateArticleHandlerDependencies {
	fetch?: typeof fetch;
	now?: () => number;
	auditWriter?: AuditWriter;
	createIdempotencyStore?: () => IdempotencyStore<ArticleCommitResultData>;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<ArticleWriteRepository>;
}

type ArticleCommitResultData = z.infer<typeof articleCommitResultSchema>;

interface ArticleWriteRepository {
	config: NonNullable<WriteArticleDependencies["pathConfig"]>;
	provider: WriteArticleDependencies["gitProvider"] &
		Pick<GitProvider, "getFileAtCommit" | "getHead">;
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
	action: "draft" | "publish",
	article: unknown,
	assetManifest: ReturnType<typeof parseStagedArticleAssetManifest>,
): Promise<string> {
	const encoded = new TextEncoder().encode(
		JSON.stringify({ storageSlug, expectedHeadSha, action, article, assetManifest }),
	);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 文章创建 API 编排层。Middleware 已处理 Origin/Fetch Metadata/Content-Type 和 Access
 * JWT；这里保留主体纵深检查，并在任何 GitHub 副作用前完成输入、限流和 D1 原子占位。
 */
export async function handleCreateArticle(
	context: CreateArticleRequestContext,
	dependencies: CreateArticleHandlerDependencies = {},
): Promise<Response> {
	guardModule("articles");
	if (!context.principal) {
		throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	}
	const principal = context.principal;
	if (!context.env.IDEMPOTENCY_DB && !dependencies.createIdempotencyStore) {
		throw new ApiError(503, "IDEMPOTENCY_UNAVAILABLE", "重复提交保护服务暂时不可用。");
	}

	const idempotencyKey = parseIdempotencyKey(context.request);
	const bodyResult = requestBodySchema.safeParse(await parseJsonBody(context.request));
	if (!bodyResult.success) {
		throw new ApiError(400, "INVALID_REQUEST", "文章创建请求无效。");
	}
	const storageSlug = parseSlug(bodyResult.data.storageSlug);
	const article = parseArticleEditorInput(bodyResult.data.article);
	const assetManifest = parseStagedArticleAssetManifest(
		bodyResult.data.assetManifest ?? { version: 1, assets: [] },
	);
	if (assetManifest.assets.length > 0 && !context.env.MEDIA_STAGING_BUCKET) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "媒体暂存服务暂时不可用。");
	}
	const action = bodyResult.data.action;
	if (action === "publish" && article.frontmatter.draft) {
		throw new ApiError(400, "INVALID_REQUEST", "正式发布时文章不能标记为草稿。");
	}
	const expectedArticleUrl = buildExpectedArticleUrl(
		loadArticleUrlTemplate(context.env),
		article.slug ?? storageSlug,
	);
	const requestHash = await createRequestHash(
		storageSlug,
		bodyResult.data.expectedHeadSha,
		action,
		article,
		assetManifest,
	);

	await enforceRateLimit(
		context.env.RATE_LIMITER,
		principal.sub,
		action === "publish" ? "article-publish" : "article-draft",
	);
	const now = dependencies.now ?? Date.now;
	const store =
		dependencies.createIdempotencyStore?.() ??
		new D1IdempotencyStore(
			context.env.IDEMPOTENCY_DB as NonNullable<RuntimeEnv["IDEMPOTENCY_DB"]>,
			(input) => articleCommitResultSchema.parse(input),
			now,
		);
	const scope = createIdempotencyScope(
		principal.sub,
		action === "publish" ? "article-create-publish" : "article-create-draft",
		idempotencyKey,
	);
	let initializedRepository: ArticleWriteRepository | undefined;
	const getRepository = (): ArticleWriteRepository => {
		if (initializedRepository) return initializedRepository;
		const factoryOptions: GitHubProviderFactoryOptions = { readEnv: () => context.env };
		if (dependencies.fetch !== undefined) factoryOptions.fetch = dependencies.fetch;
		const createRepositoryFactory =
			dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory;
		const repository = initializeProvider("articles", createRepositoryFactory(factoryOptions));
		if (!repository) throw new ApiError(404, "NOT_FOUND", "资源不存在。");
		initializedRepository = repository;
		return repository;
	};
	const output = await executeIdempotently({
		store,
		scope,
		requestHash,
		expiresAt: now() + IDEMPOTENCY_TTL_MS,
		recovery: { kind: "article-create", storageSlug },
		recoverUnknown: async ({ baseHeadSha, candidateCommitSha }) => {
			if (baseHeadSha !== bodyResult.data.expectedHeadSha || !candidateCommitSha) {
				return undefined;
			}
			const repository = getRepository();
			const recovered = await recoverArticleCommit(storageSlug, candidateCommitSha, {
				gitProvider: repository.provider,
				pathConfig: repository.config,
			});
			return recovered && expectedArticleUrl ? { ...recovered, expectedArticleUrl } : recovered;
		},
		execute: async ({ markSideEffectPossible }) => {
			if (!store.markUnknown || !store.recordCandidateCommit) {
				throw new ApiError(503, "IDEMPOTENCY_UNAVAILABLE", "重复提交保护服务暂时不可用。");
			}
			const repository = getRepository();
			const assets =
				assetManifest.assets.length === 0
					? []
					: await loadStagedArticleAssets(
							{ storageSlug, subject: principal.sub, manifest: assetManifest },
							{
								bucket: context.env.MEDIA_STAGING_BUCKET as NonNullable<
									RuntimeEnv["MEDIA_STAGING_BUCKET"]
								>,
								pathConfig: repository.config,
							},
						);
			await store.markUnknown({
				scope,
				requestHash,
				baseHeadSha: bodyResult.data.expectedHeadSha,
				recovery: { kind: "article-create", storageSlug },
			});
			markSideEffectPossible();
			const result = await createArticle(storageSlug, bodyResult.data.expectedHeadSha, article, {
				gitProvider: repository.provider,
				pathConfig: repository.config,
				assets,
				checkpointCandidateCommit: async (candidateCommitSha) => {
					await store.recordCandidateCommit?.({ scope, requestHash, candidateCommitSha });
				},
			});
			return expectedArticleUrl ? { ...result, expectedArticleUrl } : result;
		},
	});

	const timestamp = new Date(now()).toISOString();
	writeAuditEvent(
		{
			requestId: context.requestId,
			subject: principal.sub,
			action: action === "publish" ? "article.publish" : "article.create-draft",
			outcome: "success",
			target: storageSlug,
			timestamp,
			metadata: {
				commitSha: output.result.commitSha,
				replayed: output.replayed,
			},
		},
		dependencies.auditWriter,
	);

	if (!output.replayed && assetManifest.assets.length > 0) {
		try {
			await context.env.MEDIA_STAGING_BUCKET?.delete(
				assetManifest.assets.map((asset) => asset.objectKey),
			);
		} catch {
			writeAuditEvent(
				{
					requestId: context.requestId,
					subject: principal.sub,
					action: "article.cleanup-staging",
					outcome: "failure",
					target: storageSlug,
					errorCode: "UPSTREAM_UNAVAILABLE",
					timestamp,
					metadata: { assetCount: assetManifest.assets.length },
				},
				dependencies.auditWriter,
			);
		}
	}

	const response = jsonResponse({ article: output.result }, output.replayed ? 200 : 201);
	response.headers.set("Idempotency-Replayed", output.replayed ? "true" : "false");
	return response;
}
