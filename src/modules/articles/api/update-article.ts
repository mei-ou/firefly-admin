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
import { parseArticleResourceChangeManifest } from "../article-resource-changes";
import { parseArticleEditorInput } from "../article-schema";
import { recoverArticleCommit } from "../services/recover-article-commit";
import { updateArticle, type WriteArticleDependencies } from "../services/write-article";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const requestBodySchema = z
	.object({
		expectedHeadSha: z.string().regex(GIT_OBJECT_SHA),
		expectedSha: z.string().regex(GIT_OBJECT_SHA),
		article: z.unknown(),
		assetManifest: z.unknown().optional(),
		resourceChanges: z.unknown().optional(),
		action: z.enum(["draft", "publish"]).default("draft"),
	})
	.strict();
const articleCommitResultSchema = z
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

type ArticleCommitResultData = z.infer<typeof articleCommitResultSchema>;

interface ArticleWriteRepository {
	config: NonNullable<WriteArticleDependencies["pathConfig"]>;
	provider: WriteArticleDependencies["gitProvider"] &
		Pick<GitProvider, "getFileAtCommit" | "getHead">;
}

export interface UpdateArticleRequestContext {
	request: Request;
	requestId: string;
	slug: unknown;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

export interface UpdateArticleHandlerDependencies {
	fetch?: typeof fetch;
	now?: () => number;
	auditWriter?: AuditWriter;
	createIdempotencyStore?: () => IdempotencyStore<ArticleCommitResultData>;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<ArticleWriteRepository>;
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
	action: "draft" | "publish",
	article: unknown,
	assetManifest: ReturnType<typeof parseStagedArticleAssetManifest>,
	resourceChanges: ReturnType<typeof parseArticleResourceChangeManifest>,
): Promise<string> {
	const encoded = new TextEncoder().encode(
		JSON.stringify({
			storageSlug,
			expectedHeadSha,
			expectedSha,
			action,
			article,
			assetManifest,
			resourceChanges,
		}),
	);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 更新 API 使用路由 slug 定位远端文件，并要求客户端携带读取时得到的 Blob SHA。
 * 所有输入与限流在 D1 占位和 GitHub 初始化前完成，冲突时不会尝试强制覆盖远端内容。
 */
export async function handleUpdateArticle(
	context: UpdateArticleRequestContext,
	dependencies: UpdateArticleHandlerDependencies = {},
): Promise<Response> {
	guardModule("articles");
	if (!context.principal) {
		throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	}
	const principal = context.principal;
	if (!context.env.IDEMPOTENCY_DB && !dependencies.createIdempotencyStore) {
		throw new ApiError(503, "IDEMPOTENCY_UNAVAILABLE", "重复提交保护服务暂时不可用。");
	}

	const storageSlug = parseSlug(context.slug);
	const idempotencyKey = parseIdempotencyKey(context.request);
	const bodyResult = requestBodySchema.safeParse(await parseJsonBody(context.request));
	if (!bodyResult.success) {
		throw new ApiError(400, "INVALID_REQUEST", "文章更新请求无效。");
	}
	const article = parseArticleEditorInput(bodyResult.data.article);
	const assetManifest = parseStagedArticleAssetManifest(
		bodyResult.data.assetManifest ?? { version: 1, assets: [] },
	);
	const resourceChanges = parseArticleResourceChangeManifest(
		bodyResult.data.resourceChanges ?? { version: 1, changes: [] },
	);
	// 旧协议没有绑定影响预览，继续接收会让调用方绕过后续 Preview/Commit 安全控制面。
	// 在任何限流、D1、R2 或 Git 副作用前失败关闭；空清单仍兼容普通文章与新资源保存。
	if (resourceChanges.changes.length > 0) {
		throw new ApiError(409, "MEDIA_PREVIEW_REQUIRED", "资源操作必须先生成影响预览。");
	}
	const replacementCount = resourceChanges.changes.filter(
		(change) => change.operation === "replace",
	).length;
	const moveCount = resourceChanges.changes.filter((change) => change.operation === "move").length;
	// 新建和替换都消费一个暂存对象；每个移动会产生目标复用和源删除两条 Tree 变更。
	const treeChangeCount =
		1 + assetManifest.assets.length - replacementCount + resourceChanges.changes.length + moveCount;
	if (treeChangeCount > 11) {
		throw new ApiError(400, "INVALID_REQUEST", "单次文章资源变更数量超过限制。");
	}
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
		bodyResult.data.expectedSha,
		action,
		article,
		assetManifest,
		resourceChanges,
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
		action === "publish" ? "article-update-publish" : "article-update-draft",
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
		recovery: { kind: "article-update", storageSlug },
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
				recovery: { kind: "article-update", storageSlug },
			});
			markSideEffectPossible();
			const result = await updateArticle(
				storageSlug,
				bodyResult.data.expectedHeadSha,
				bodyResult.data.expectedSha,
				article,
				{
					gitProvider: repository.provider,
					pathConfig: repository.config,
					assets,
					resourceChanges: resourceChanges.changes,
					checkpointCandidateCommit: async (candidateCommitSha) => {
						await store.recordCandidateCommit?.({ scope, requestHash, candidateCommitSha });
					},
				},
			);
			return expectedArticleUrl ? { ...result, expectedArticleUrl } : result;
		},
	});

	const timestamp = new Date(now()).toISOString();
	writeAuditEvent(
		{
			requestId: context.requestId,
			subject: principal.sub,
			action: action === "publish" ? "article.publish" : "article.update-draft",
			outcome: "success",
			target: storageSlug,
			timestamp,
			metadata: {
				commitSha: output.result.commitSha,
				replayed: output.replayed,
				resourceChanges: {
					deleted: resourceChanges.changes.filter((change) => change.operation === "delete").length,
					replaced: resourceChanges.changes.filter((change) => change.operation === "replace")
						.length,
					moved: resourceChanges.changes.filter((change) => change.operation === "move").length,
				},
			},
		},
		dependencies.auditWriter,
	);

	if (!output.replayed && assetManifest.assets.length > 0) {
		try {
			await (
				context.env.MEDIA_STAGING_BUCKET as NonNullable<RuntimeEnv["MEDIA_STAGING_BUCKET"]>
			).delete(assetManifest.assets.map((asset) => asset.objectKey));
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

	const response = jsonResponse({ article: output.result });
	response.headers.set("Idempotency-Replayed", output.replayed ? "true" : "false");
	return response;
}
