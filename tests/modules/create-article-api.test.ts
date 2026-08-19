import { describe, expect, it, vi } from "vitest";
import type { IdempotencyStore } from "../../src/core/idempotency/types";
import { handleCreateArticle } from "../../src/modules/articles/api/create-article";
import type { GitProvider } from "../../src/providers/git/types";
import type { ArticleCommitResult } from "../../src/types/article";
import type { RuntimeEnv } from "../../src/types/env";
import type { ProviderFactory } from "../../src/types/provider";

const FILE_SHA = "a".repeat(40);
const COMMIT_SHA = "b".repeat(40);
const HEAD_SHA = "c".repeat(40);
const repositoryPath = "src/content/posts/hello-world/index.md";
const imagePath = "src/content/posts/hello-world/cover-123e4567e89b.png";
const assetId = "123e4567-e89b-12d3-a456-426614174000";
const objectKey = `staging/2026/08/${assetId}.png`;
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const assetManifest = {
	version: 1 as const,
	assets: [
		{
			version: 1 as const,
			assetId,
			objectKey,
			etag: "etag-1",
			originalFilename: "client-cover.png",
			contentType: "image/png" as const,
			size: pngBytes.byteLength,
			role: "inline" as const,
		},
	],
};
const principal = { sub: "subject-1", email: "admin@example.com" };
const article = {
	frontmatter: {
		title: "你好，Firefly",
		published: "2026-08-12T00:00:00.000Z",
	},
	format: "md",
	markdown: "# 正文\n",
};
const result: ArticleCommitResult = {
	storageSlug: "hello-world",
	pathAlias: "hello-world/index.md",
	commitSha: COMMIT_SHA,
	commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
	fileSha: FILE_SHA,
};

function createRequest(
	body: unknown = { storageSlug: "hello-world", expectedHeadSha: HEAD_SHA, article },
) {
	return new Request("https://admin.example.com/api/articles", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": "unique-request-key-123456",
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function createStore(claim: Awaited<ReturnType<IdempotencyStore<ArticleCommitResult>["claim"]>>) {
	return {
		claim: vi.fn().mockResolvedValue(claim),
		markUnknown: vi.fn().mockResolvedValue(undefined),
		recordCandidateCommit: vi.fn().mockResolvedValue(undefined),
		complete: vi.fn().mockResolvedValue(undefined),
		release: vi.fn().mockResolvedValue(undefined),
	};
}

function createRepositoryFactory(
	commitFilesAtomically: GitProvider["commitFilesAtomically"] = vi
		.fn<GitProvider["commitFilesAtomically"]>()
		.mockImplementation(async (input) => {
			await input.checkpointCandidateCommit(COMMIT_SHA);
			return {
				commitSha: COMMIT_SHA,
				commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
				files: [{ path: repositoryPath, fileSha: FILE_SHA }],
			};
		}),
	readOverrides: Partial<Pick<GitProvider, "getFileAtCommit" | "getHead">> = {},
) {
	const getHead =
		readOverrides.getHead ??
		vi.fn<GitProvider["getHead"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			treeSha: "d".repeat(40),
		});
	const getFileAtCommit =
		readOverrides.getFileAtCommit ??
		vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
			path: repositoryPath,
			sha: FILE_SHA,
			content: "# recovered\n",
			encoding: "utf-8",
		});
	return (): ProviderFactory<{
		config: { contentRoot: string; entryFilename: string; usePageBundle: boolean };
		provider: Pick<GitProvider, "commitFilesAtomically" | "getFileAtCommit" | "getHead">;
	}> => ({
		id: "test-git",
		moduleId: "articles",
		create: () => ({
			config: {
				contentRoot: "src/content/posts",
				entryFilename: "index.md",
				usePageBundle: true,
			},
			provider: { commitFilesAtomically, getFileAtCommit, getHead },
		}),
	});
}

function createBucket(overrides: Record<string, unknown> = {}) {
	return {
		put: vi.fn(),
		get: vi.fn().mockResolvedValue({
			key: objectKey,
			size: pngBytes.byteLength,
			etag: "etag-1",
			uploaded: new Date("2026-08-15T00:00:00.000Z"),
			httpMetadata: { contentType: "image/png" },
			customMetadata: { originalFilename: "Cover (最终).png", uploaderSubject: principal.sub },
			arrayBuffer: async () => pngBytes.slice().buffer,
			...overrides,
		}),
		list: vi.fn(),
		delete: vi.fn(),
	};
}

const env: RuntimeEnv = {
	RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

describe("文章创建 API", () => {
	it("首次请求原子占位后创建文章并返回 201", async () => {
		const store = createStore({ state: "claimed" });
		const commitFilesAtomically = vi
			.fn<GitProvider["commitFilesAtomically"]>()
			.mockImplementation(async (input) => {
				await input.checkpointCandidateCommit(COMMIT_SHA);
				return {
					commitSha: COMMIT_SHA,
					commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
					files: [{ path: repositoryPath, fileSha: FILE_SHA }],
				};
			});
		const auditWriter = vi.fn();

		const response = await handleCreateArticle(
			{ request: createRequest(), requestId: "req-create", principal, env },
			{
				createIdempotencyStore: () => store,
				createRepositoryFactory: createRepositoryFactory(commitFilesAtomically),
				auditWriter,
				now: () => 1_000_000,
			},
		);

		expect(response.status).toBe(201);
		expect(response.headers.get("Idempotency-Replayed")).toBe("false");
		expect(commitFilesAtomically).toHaveBeenCalledOnce();
		expect(store.markUnknown).toHaveBeenCalledWith(
			expect.objectContaining({ baseHeadSha: HEAD_SHA }),
		);
		expect(store.recordCandidateCommit).toHaveBeenCalledWith(
			expect.objectContaining({ candidateCommitSha: COMMIT_SHA }),
		);
		expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({ result }));
		expect(await response.json()).toEqual({ article: result });
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "req-create",
				subject: "subject-1",
				action: "article.create-draft",
				target: "hello-world",
				metadata: { commitSha: COMMIT_SHA, replayed: false },
			}),
		);
	});

	it("复核 R2 后将 Frontmatter 绑定的封面与文章放入同一次原子提交", async () => {
		const store = createStore({ state: "claimed" });
		const bucket = createBucket();
		const coverManifest = {
			...assetManifest,
			assets: [{ ...assetManifest.assets[0], role: "cover" as const }],
		};
		const articleWithCover = {
			...article,
			frontmatter: { ...article.frontmatter, image: "./cover-123e4567e89b.png" },
		};
		const commitFilesAtomically = vi
			.fn<GitProvider["commitFilesAtomically"]>()
			.mockImplementation(async (input) => {
				await input.checkpointCandidateCommit(COMMIT_SHA);
				return {
					commitSha: COMMIT_SHA,
					commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
					files: [
						{ path: repositoryPath, fileSha: FILE_SHA },
						{ path: imagePath, fileSha: "d".repeat(40) },
					],
				};
			});

		await handleCreateArticle(
			{
				request: createRequest({
					storageSlug: "hello-world",
					expectedHeadSha: HEAD_SHA,
					article: articleWithCover,
					assetManifest: coverManifest,
				}),
				requestId: "req-create-assets",
				principal,
				env: { ...env, MEDIA_STAGING_BUCKET: bucket },
			},
			{
				createIdempotencyStore: () => store,
				createRepositoryFactory: createRepositoryFactory(commitFilesAtomically),
			},
		);

		expect(bucket.get).toHaveBeenCalledWith(objectKey);
		const files = commitFilesAtomically.mock.calls[0]?.[0].files;
		expect(files).toHaveLength(2);
		expect(files?.[0]).toMatchObject({
			path: repositoryPath,
			expectedSha: null,
			content: expect.stringContaining("image: ./cover-123e4567e89b.png"),
		});
		expect(files?.[1]).toEqual({ path: imagePath, content: pngBytes, expectedSha: null });
		expect(bucket.delete).toHaveBeenCalledWith([objectKey]);
		expect(store.complete.mock.invocationCallOrder[0]).toBeLessThan(
			bucket.delete.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("R2 清理失败只记录审计，不改变已完成的发布结果", async () => {
		const store = createStore({ state: "claimed" });
		const bucket = createBucket();
		bucket.delete.mockRejectedValue(new Error("R2 delete failed"));
		const auditWriter = vi.fn();
		const commitFilesAtomically = vi
			.fn<GitProvider["commitFilesAtomically"]>()
			.mockImplementation(async (input) => {
				await input.checkpointCandidateCommit(COMMIT_SHA);
				return {
					commitSha: COMMIT_SHA,
					commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
					files: [
						{ path: repositoryPath, fileSha: FILE_SHA },
						{ path: imagePath, fileSha: "d".repeat(40) },
					],
				};
			});

		const response = await handleCreateArticle(
			{
				request: createRequest({
					storageSlug: "hello-world",
					expectedHeadSha: HEAD_SHA,
					article,
					assetManifest,
				}),
				requestId: "req-cleanup-failed",
				principal,
				env: { ...env, MEDIA_STAGING_BUCKET: bucket },
			},
			{
				createIdempotencyStore: () => store,
				createRepositoryFactory: createRepositoryFactory(commitFilesAtomically),
				auditWriter,
			},
		);

		expect(response.status).toBe(201);
		expect(store.complete).toHaveBeenCalledOnce();
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "article.cleanup-staging",
				outcome: "failure",
				target: "hello-world",
				errorCode: "UPSTREAM_UNAVAILABLE",
				metadata: { assetCount: 1 },
			}),
		);
	});

	it("幂等回放不会再次清理 R2", async () => {
		const bucket = createBucket();
		const createRepositoryFactory = vi.fn();
		const response = await handleCreateArticle(
			{
				request: createRequest({
					storageSlug: "hello-world",
					expectedHeadSha: HEAD_SHA,
					article,
					assetManifest,
				}),
				requestId: "req-assets-replay",
				principal,
				env: { ...env, MEDIA_STAGING_BUCKET: bucket },
			},
			{
				createIdempotencyStore: () => createStore({ state: "completed", result }),
				createRepositoryFactory,
				auditWriter: vi.fn(),
			},
		);

		expect(response.status).toBe(200);
		expect(createRepositoryFactory).not.toHaveBeenCalled();
		expect(bucket.get).not.toHaveBeenCalled();
		expect(bucket.delete).not.toHaveBeenCalled();
	});

	it("有资源但缺少 R2 Binding 时在限流和 claim 前失败", async () => {
		const store = createStore({ state: "claimed" });
		const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		await expect(
			handleCreateArticle(
				{
					request: createRequest({
						storageSlug: "hello-world",
						expectedHeadSha: HEAD_SHA,
						article,
						assetManifest,
					}),
					requestId: "req-no-r2",
					principal,
					env: { RATE_LIMITER: limiter },
				},
				{ createIdempotencyStore: () => store },
			),
		).rejects.toMatchObject({ status: 503, code: "CONFIGURATION_ERROR" });
		expect(limiter.limit).not.toHaveBeenCalled();
		expect(store.claim).not.toHaveBeenCalled();
	});

	it("R2 复核失败不会进入 unknown 或调用 Git，并释放 processing 占位", async () => {
		const store = createStore({ state: "claimed" });
		const bucket = createBucket({ etag: "changed-etag" });
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>();
		await expect(
			handleCreateArticle(
				{
					request: createRequest({
						storageSlug: "hello-world",
						expectedHeadSha: HEAD_SHA,
						article,
						assetManifest,
					}),
					requestId: "req-stale-r2",
					principal,
					env: { ...env, MEDIA_STAGING_BUCKET: bucket },
				},
				{
					createIdempotencyStore: () => store,
					createRepositoryFactory: createRepositoryFactory(commitFilesAtomically),
				},
			),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		expect(store.markUnknown).not.toHaveBeenCalled();
		expect(store.release).toHaveBeenCalledOnce();
		expect(commitFilesAtomically).not.toHaveBeenCalled();
	});

	it("unknown 候选已成为 HEAD 时只读恢复并完成原记录", async () => {
		const store = createStore({
			state: "unknown",
			baseHeadSha: HEAD_SHA,
			candidateCommitSha: COMMIT_SHA,
		});
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>();
		const getHead = vi.fn<GitProvider["getHead"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			treeSha: "d".repeat(40),
		});
		const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
			path: repositoryPath,
			sha: FILE_SHA,
			content: "# recovered\n",
			encoding: "utf-8",
		});

		const response = await handleCreateArticle(
			{ request: createRequest(), requestId: "req-recover", principal, env },
			{
				createIdempotencyStore: () => store,
				createRepositoryFactory: createRepositoryFactory(commitFilesAtomically, {
					getHead,
					getFileAtCommit,
				}),
				auditWriter: vi.fn(),
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Idempotency-Replayed")).toBe("true");
		expect(commitFilesAtomically).not.toHaveBeenCalled();
		expect(getHead).toHaveBeenCalledOnce();
		expect(getFileAtCommit).toHaveBeenCalledWith(repositoryPath, COMMIT_SHA);
		expect(store.complete).toHaveBeenCalledWith(expect.objectContaining({ result }));
		expect(await response.json()).toEqual({ article: result });
	});

	it("unknown HEAD 不匹配时保持失败关闭且不创建新 Commit", async () => {
		const store = createStore({
			state: "unknown",
			baseHeadSha: HEAD_SHA,
			candidateCommitSha: COMMIT_SHA,
		});
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>();
		const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>();

		await expect(
			handleCreateArticle(
				{ request: createRequest(), requestId: "req-recover-mismatch", principal, env },
				{
					createIdempotencyStore: () => store,
					createRepositoryFactory: createRepositoryFactory(commitFilesAtomically, {
						getHead: vi.fn<GitProvider["getHead"]>().mockResolvedValue({
							commitSha: "e".repeat(40),
							commitUrl: `https://github.com/owner/repo/commit/${"e".repeat(40)}`,
							treeSha: "d".repeat(40),
						}),
						getFileAtCommit,
					}),
				},
			),
		).rejects.toMatchObject({ status: 503, code: "COMMIT_STATUS_UNKNOWN" });
		expect(commitFilesAtomically).not.toHaveBeenCalled();
		expect(getFileAtCommit).not.toHaveBeenCalled();
		expect(store.complete).not.toHaveBeenCalled();
	});

	it("已完成请求回放结果并且不初始化 GitHub", async () => {
		const store = createStore({ state: "completed", result });
		const createRepositoryFactory = vi.fn();

		const response = await handleCreateArticle(
			{ request: createRequest(), requestId: "req-replay", principal, env },
			{
				createIdempotencyStore: () => store,
				createRepositoryFactory,
				auditWriter: vi.fn(),
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Idempotency-Replayed")).toBe("true");
		expect(createRepositoryFactory).not.toHaveBeenCalled();
	});

	it("相同键请求冲突和处理中时不会访问 GitHub", async () => {
		for (const [state, code] of [
			["conflict", "IDEMPOTENCY_CONFLICT"],
			["processing", "IDEMPOTENCY_IN_PROGRESS"],
		] as const) {
			const createRepositoryFactory = vi.fn();
			await expect(
				handleCreateArticle(
					{ request: createRequest(), requestId: "req-conflict", principal, env },
					{
						createIdempotencyStore: () => createStore({ state }),
						createRepositoryFactory,
					},
				),
			).rejects.toMatchObject({ status: 409, code });
			expect(createRepositoryFactory).not.toHaveBeenCalled();
		}
	});

	it("拒绝未认证、缺失幂等存储和缺失幂等键", async () => {
		await expect(
			handleCreateArticle({
				request: createRequest(),
				requestId: "req-anonymous",
				principal: undefined,
				env,
			}),
		).rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });

		await expect(
			handleCreateArticle({ request: createRequest(), requestId: "req-no-db", principal, env }),
		).rejects.toMatchObject({ status: 503, code: "IDEMPOTENCY_UNAVAILABLE" });

		const request = createRequest();
		request.headers.delete("Idempotency-Key");
		await expect(
			handleCreateArticle(
				{ request, requestId: "req-no-key", principal, env },
				{ createIdempotencyStore: () => createStore({ state: "claimed" }) },
			),
		).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
	});

	it("拒绝无效 JSON、未知请求字段和非法文章输入", async () => {
		for (const request of [
			createRequest("{"),
			createRequest({
				storageSlug: "hello-world",
				expectedHeadSha: HEAD_SHA,
				article,
				repositoryPath: "README.md",
			}),
			createRequest({ storageSlug: "../secret", expectedHeadSha: HEAD_SHA, article }),
			createRequest({
				storageSlug: "hello-world",
				expectedHeadSha: HEAD_SHA,
				article: { ...article, format: "mdx" },
			}),
		]) {
			await expect(
				handleCreateArticle(
					{ request, requestId: "req-invalid", principal, env },
					{ createIdempotencyStore: () => createStore({ state: "claimed" }) },
				),
			).rejects.toBeDefined();
		}
	});

	it("正式发布使用独立限流和幂等作用域，并拒绝 draft=true", async () => {
		const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const publishArticle = { ...article, frontmatter: { ...article.frontmatter, draft: false } };
		const store = createStore({ state: "completed", result });
		await handleCreateArticle(
			{
				request: createRequest({
					storageSlug: "hello-world",
					expectedHeadSha: HEAD_SHA,
					article: publishArticle,
					action: "publish",
				}),
				requestId: "req-publish",
				principal,
				env: { RATE_LIMITER: limiter },
			},
			{ createIdempotencyStore: () => store, auditWriter: vi.fn() },
		);
		expect(limiter.limit).toHaveBeenCalledWith({ key: "subject-1:article-publish" });
		expect(store.claim).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "subject-1:article-create-publish:unique-request-key-123456",
			}),
		);

		await expect(
			handleCreateArticle(
				{
					request: createRequest({
						storageSlug: "hello-world",
						expectedHeadSha: HEAD_SHA,
						article,
						action: "publish",
					}),
					requestId: "req-invalid-publish",
					principal,
					env,
				},
				{ createIdempotencyStore: () => createStore({ state: "claimed" }) },
			),
		).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
	});

	it("限流失败发生在 D1 claim 和 GitHub 初始化之前", async () => {
		const store = createStore({ state: "claimed" });
		const createRepositoryFactory = vi.fn();
		await expect(
			handleCreateArticle(
				{
					request: createRequest(),
					requestId: "req-limited",
					principal,
					env: {
						RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
					},
				},
				{
					createIdempotencyStore: () => store,
					createRepositoryFactory,
				},
			),
		).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
		expect(store.claim).not.toHaveBeenCalled();
		expect(createRepositoryFactory).not.toHaveBeenCalled();
	});

	it("进入 unknown 后 GitHub 失败也不释放幂等记录", async () => {
		const store = createStore({ state: "claimed" });
		const failure = new Error("GitHub failed");
		await expect(
			handleCreateArticle(
				{ request: createRequest(), requestId: "req-git-failed", principal, env },
				{
					createIdempotencyStore: () => store,
					createRepositoryFactory: createRepositoryFactory(
						vi.fn<GitProvider["commitFilesAtomically"]>().mockRejectedValue(failure),
					),
				},
			),
		).rejects.toBe(failure);
		expect(store.markUnknown).toHaveBeenCalledOnce();
		expect(store.release).not.toHaveBeenCalled();
		expect(store.complete).not.toHaveBeenCalled();
	});

	it("请求指纹稳定包含默认值，作用域按主体和操作隔离", async () => {
		const store = createStore({ state: "completed", result });
		await handleCreateArticle(
			{ request: createRequest(), requestId: "req-scope", principal, env },
			{
				createIdempotencyStore: () => store,
				auditWriter: vi.fn(),
				now: () => 1_000_000,
			},
		);

		expect(store.claim).toHaveBeenCalledWith({
			scope: "subject-1:article-create-draft:unique-request-key-123456",
			requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			expiresAt: 87_400_000,
			recovery: { kind: "article-create", storageSlug: "hello-world" },
		});
	});
});
