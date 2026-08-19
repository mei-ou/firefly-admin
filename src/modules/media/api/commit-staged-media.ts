import { z } from "zod";
import { type AuditWriter, writeAuditEvent } from "../../../core/audit/audit-log";
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
import {
	type CommitStagedMediaDependencies,
	commitStagedMedia,
} from "../services/commit-staged-media";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const requestBodySchema = z
	.object({
		storageSlug: z.unknown(),
		objectKey: z.unknown(),
		etag: z.unknown(),
	})
	.strict();
const committedMediaSchema = z
	.object({
		storageSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
		repositoryPath: z
			.string()
			.regex(/^src\/content\/posts\/[a-z0-9-]+\/[a-z0-9-]+\.(?:gif|jpg|png|webp)$/u),
		relativePath: z.string().regex(/^\.\/[a-z0-9-]+\.(?:gif|jpg|png|webp)$/u),
		commitSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
		commitUrl: z.url().refine((value) => new URL(value).origin === "https://github.com"),
		fileSha: z.string().regex(/^[a-f0-9]{40,64}$/u),
	})
	.strict();

export type CommittedMediaResult = z.infer<typeof committedMediaSchema>;

export interface CommitStagedMediaRequestContext {
	request: Request;
	requestId: string;
	principal: AuthenticatedPrincipal | undefined;
	env: RuntimeEnv;
}

interface MediaWriteRepository {
	config: CommitStagedMediaDependencies["pathConfig"];
	provider: Pick<GitProvider, "getFile" | "createBinaryFile">;
}

export interface CommitStagedMediaHandlerDependencies {
	fetch?: typeof fetch;
	now?: () => number;
	auditWriter?: AuditWriter;
	createIdempotencyStore?: () => IdempotencyStore<CommittedMediaResult>;
	createRepositoryFactory?: (
		options: GitHubProviderFactoryOptions,
	) => ProviderFactory<MediaWriteRepository>;
}

async function parseJsonBody(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new ApiError(400, "INVALID_REQUEST", "请求 JSON 无效。");
	}
}

async function createRequestHash(input: {
	storageSlug: unknown;
	objectKey: unknown;
	etag: unknown;
	subject: string;
}): Promise<string> {
	const encoded = new TextEncoder().encode(JSON.stringify(input));
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 将 R2 暂存图片提交到当前文章目录。幂等记录完成后才尝试删除 R2 对象，避免 Git Commit
 * 已成功但响应或清理失败时，客户端重试产生第二个文件。
 */
export async function handleCommitStagedMedia(
	context: CommitStagedMediaRequestContext,
	dependencies: CommitStagedMediaHandlerDependencies = {},
): Promise<Response> {
	guardModule("media");
	if (!context.principal) {
		throw new ApiError(401, "AUTH_REQUIRED", "需要登录后才能访问。");
	}
	if (!context.env.MEDIA_STAGING_BUCKET) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "媒体暂存服务暂时不可用。");
	}
	if (!context.env.IDEMPOTENCY_DB && !dependencies.createIdempotencyStore) {
		throw new ApiError(503, "IDEMPOTENCY_UNAVAILABLE", "重复提交保护服务暂时不可用。");
	}

	const idempotencyKey = parseIdempotencyKey(context.request);
	const bodyResult = requestBodySchema.safeParse(await parseJsonBody(context.request));
	if (!bodyResult.success) {
		throw new ApiError(400, "INVALID_REQUEST", "媒体转存请求无效。");
	}
	await enforceRateLimit(context.env.RATE_LIMITER, context.principal.sub, "image-commit");

	const now = dependencies.now ?? Date.now;
	const requestHash = await createRequestHash({
		...bodyResult.data,
		subject: context.principal.sub,
	});
	const store =
		dependencies.createIdempotencyStore?.() ??
		new D1IdempotencyStore(
			context.env.IDEMPOTENCY_DB as NonNullable<RuntimeEnv["IDEMPOTENCY_DB"]>,
			(input) => committedMediaSchema.parse(input),
			now,
		);
	const scope = createIdempotencyScope(context.principal.sub, "media-commit", idempotencyKey);
	const output = await executeIdempotently({
		store,
		scope,
		requestHash,
		expiresAt: now() + IDEMPOTENCY_TTL_MS,
		execute: async () => {
			const factoryOptions: GitHubProviderFactoryOptions = { readEnv: () => context.env };
			if (dependencies.fetch !== undefined) factoryOptions.fetch = dependencies.fetch;
			const createRepositoryFactory =
				dependencies.createRepositoryFactory ?? createGitHubRepositoryFactory;
			const repository = initializeProvider("articles", createRepositoryFactory(factoryOptions));
			if (!repository) throw new ApiError(404, "NOT_FOUND", "资源不存在。");
			return committedMediaSchema.parse(
				await commitStagedMedia(
					{
						...bodyResult.data,
						subject: context.principal?.sub ?? "",
					},
					{
						bucket: context.env.MEDIA_STAGING_BUCKET as NonNullable<
							RuntimeEnv["MEDIA_STAGING_BUCKET"]
						>,
						gitProvider: repository.provider,
						pathConfig: repository.config,
					},
				),
			);
		},
	});

	const timestamp = new Date(now()).toISOString();
	writeAuditEvent(
		{
			requestId: context.requestId,
			subject: context.principal.sub,
			action: "media.commit",
			outcome: "success",
			target: output.result.repositoryPath,
			timestamp,
			metadata: { commitSha: output.result.commitSha, replayed: output.replayed },
		},
		dependencies.auditWriter,
	);

	if (!output.replayed) {
		try {
			await context.env.MEDIA_STAGING_BUCKET.delete(String(bodyResult.data.objectKey));
		} catch {
			writeAuditEvent(
				{
					requestId: context.requestId,
					subject: context.principal.sub,
					action: "media.cleanup-staging",
					outcome: "failure",
					target: String(bodyResult.data.objectKey),
					errorCode: "UPSTREAM_UNAVAILABLE",
					timestamp,
				},
				dependencies.auditWriter,
			);
		}
	}

	const response = jsonResponse({ asset: output.result }, output.replayed ? 200 : 201);
	response.headers.set("Idempotency-Replayed", output.replayed ? "true" : "false");
	return response;
}
