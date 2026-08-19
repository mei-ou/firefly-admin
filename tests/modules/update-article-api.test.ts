import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import type { IdempotencyStore } from "../../src/core/idempotency/types";
import { handleUpdateArticle } from "../../src/modules/articles/api/update-article";
import type { GitProvider } from "../../src/providers/git/types";
import type { ArticleCommitResult } from "../../src/types/article";
import type { RuntimeEnv } from "../../src/types/env";
import type { ProviderFactory } from "../../src/types/provider";

const ORIGINAL_SHA = "a".repeat(40);
const FILE_SHA = "b".repeat(40);
const COMMIT_SHA = "c".repeat(40);
const HEAD_SHA = "d".repeat(40);
const repositoryPath = "src/content/posts/hello-world/index.md";
const imagePath = "src/content/posts/hello-world/cover-123e4567e89b.png";
const DELETED_SHA = "9".repeat(40);
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
		title: "更新后的文章",
		published: "2026-08-12T00:00:00.000Z",
	},
	format: "md",
	markdown: "# 更新正文\n",
};
const result: ArticleCommitResult = {
	storageSlug: "hello-world",
	pathAlias: "hello-world/index.md",
	commitSha: COMMIT_SHA,
	commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
	fileSha: FILE_SHA,
};

function createRequest(
	body: unknown = { expectedHeadSha: HEAD_SHA, expectedSha: ORIGINAL_SHA, article },
) {
	return new Request("https://admin.example.com/api/articles/hello-world", {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": "unique-update-key-123456",
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
			treeSha: "f".repeat(40),
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

const env: RuntimeEnv = {
	RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

describe("文章更新 API", () => {
	it("携带原始 Blob SHA 更新并返回当前文件版本", async () => {
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

		const response = await handleUpdateArticle(
			{
				request: createRequest(),
				requestId: "req-update",
				slug: "hello-world",
				principal,
				env,
			},
			{
				createIdempotencyStore: () => store,
				createRepositoryFactory: createRepositoryFactory(commitFilesAtomically),
				auditWriter,
				now: () => 1_000_000,
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Idempotency-Replayed")).toBe("false");
		expect(commitFilesAtomically).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedHeadSha: HEAD_SHA,
				files: [expect.objectContaining({ path: repositoryPath, expectedSha: ORIGINAL_SHA })],
				message: "docs(post): update hello-world",
			}),
		);
		expect(store.markUnknown).toHaveBeenCalledWith(
			expect.objectContaining({ baseHeadSha: HEAD_SHA }),
		);
		expect(store.recordCandidateCommit).toHaveBeenCalledWith(
			expect.objectContaining({ candidateCommitSha: COMMIT_SHA }),
		);
		expect(await response.json()).toEqual({ article: result });
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "article.update-draft",
				target: "hello-world",
				metadata: {
					commitSha: COMMIT_SHA,
					replayed: false,
					resourceChanges: { deleted: 0, replaced: 0, moved: 0 },
				},
			}),
		);
	});

	it("旧资源变更必须先 Preview，且在所有外部副作用前失败关闭", async () => {
		const legacyChanges = [
			[{ operation: "delete", filename: "old-guide.pdf", expectedSha: DELETED_SHA }],
			[
				{
					operation: "replace",
					filename: "cover.png",
					expectedSha: DELETED_SHA,
					assetId,
				},
			],
			[
				{
					operation: "move",
					filename: "old-guide.pdf",
					destinationFilename: "new-guide.pdf",
					expectedSha: DELETED_SHA,
				},
			],
		] as const;

		for (const changes of legacyChanges) {
			const store = createStore({ state: "claimed" });
			const bucket = createBucket();
			const createRepository = vi.fn();
			const createRepositoryFactory = vi.fn(() => ({
				id: "test-git",
				moduleId: "articles" as const,
				create: createRepository,
			}));
			const auditWriter = vi.fn();
			const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };

			await expect(
				handleUpdateArticle(
					{
						request: createRequest({
							expectedHeadSha: HEAD_SHA,
							expectedSha: ORIGINAL_SHA,
							article,
							assetManifest: changes[0]?.operation === "replace" ? assetManifest : undefined,
							resourceChanges: { version: 1, changes },
						}),
						requestId: "req-legacy-resource-change",
						slug: "hello-world",
						principal,
						env: { ...env, RATE_LIMITER: limiter, MEDIA_STAGING_BUCKET: bucket },
					},
					{
						createIdempotencyStore: () => store,
						createRepositoryFactory,
						auditWriter,
					},
				),
			).rejects.toMatchObject({ status: 409, code: "MEDIA_PREVIEW_REQUIRED" });

			expect(limiter.limit).not.toHaveBeenCalled();
			expect(store.claim).not.toHaveBeenCalled();
			expect(bucket.get).not.toHaveBeenCalled();
			expect(createRepositoryFactory).not.toHaveBeenCalled();
			expect(createRepository).not.toHaveBeenCalled();
			expect(auditWriter).not.toHaveBeenCalled();
		}
	});

	it("拒绝重复、跨目录和无效移动且不进入 claim", async () => {
		for (const changes of [
			[
				{ operation: "delete", filename: "old-guide.pdf", expectedSha: DELETED_SHA },
				{ operation: "delete", filename: "old-guide.pdf", expectedSha: DELETED_SHA },
			],
			[{ operation: "delete", filename: "../secret.pdf", expectedSha: DELETED_SHA }],
			[
				{
					operation: "move",
					filename: "old-guide.pdf",
					destinationFilename: "../secret.pdf",
					expectedSha: DELETED_SHA,
				},
			],
		]) {
			const store = createStore({ state: "claimed" });
			await expect(
				handleUpdateArticle(
					{
						request: createRequest({
							expectedHeadSha: HEAD_SHA,
							expectedSha: ORIGINAL_SHA,
							article,
							resourceChanges: { version: 1, changes },
						}),
						requestId: "req-invalid-resource-change",
						slug: "hello-world",
						principal,
						env,
					},
					{ createIdempotencyStore: () => store },
				),
			).rejects.toBeDefined();
			expect(store.claim).not.toHaveBeenCalled();
		}
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
						{ path: imagePath, fileSha: "e".repeat(40) },
					],
				};
			});

		await handleUpdateArticle(
			{
				request: createRequest({
					expectedHeadSha: HEAD_SHA,
					expectedSha: ORIGINAL_SHA,
					article: articleWithCover,
					assetManifest: coverManifest,
				}),
				requestId: "req-update-assets",
				slug: "hello-world",
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
			expectedSha: ORIGINAL_SHA,
			content: expect.stringContaining("image: ./cover-123e4567e89b.png"),
		});
		expect(files?.[1]).toEqual({ path: imagePath, content: pngBytes, expectedSha: null });
		expect(bucket.delete).toHaveBeenCalledWith([objectKey]);
		expect(store.complete.mock.invocationCallOrder[0]).toBeLessThan(
			bucket.delete.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("R2 清理失败只记录审计，不改变已完成的更新结果", async () => {
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
						{ path: imagePath, fileSha: "e".repeat(40) },
					],
				};
			});

		const response = await handleUpdateArticle(
			{
				request: createRequest({
					expectedHeadSha: HEAD_SHA,
					expectedSha: ORIGINAL_SHA,
					article,
					assetManifest,
				}),
				requestId: "req-cleanup-failed",
				slug: "hello-world",
				principal,
				env: { ...env, MEDIA_STAGING_BUCKET: bucket },
			},
			{
				createIdempotencyStore: () => store,
				createRepositoryFactory: createRepositoryFactory(commitFilesAtomically),
				auditWriter,
			},
		);

		expect(response.status).toBe(200);
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
		const response = await handleUpdateArticle(
			{
				request: createRequest({
					expectedHeadSha: HEAD_SHA,
					expectedSha: ORIGINAL_SHA,
					article,
					assetManifest,
				}),
				requestId: "req-assets-replay",
				slug: "hello-world",
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
			handleUpdateArticle(
				{
					request: createRequest({
						expectedHeadSha: HEAD_SHA,
						expectedSha: ORIGINAL_SHA,
						article,
						assetManifest,
					}),
					requestId: "req-no-r2",
					slug: "hello-world",
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
			handleUpdateArticle(
				{
					request: createRequest({
						expectedHeadSha: HEAD_SHA,
						expectedSha: ORIGINAL_SHA,
						article,
						assetManifest,
					}),
					requestId: "req-stale-r2",
					slug: "hello-world",
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
			treeSha: "f".repeat(40),
		});
		const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
			path: repositoryPath,
			sha: FILE_SHA,
			content: "# recovered\n",
			encoding: "utf-8",
		});

		const response = await handleUpdateArticle(
			{
				request: createRequest(),
				requestId: "req-recover",
				slug: "hello-world",
				principal,
				env,
			},
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

	it("unknown 缺少 candidate 时不初始化 Git 并保持失败关闭", async () => {
		const store = createStore({ state: "unknown", baseHeadSha: HEAD_SHA });
		const createRepositoryFactory = vi.fn();

		await expect(
			handleUpdateArticle(
				{
					request: createRequest(),
					requestId: "req-recover-no-candidate",
					slug: "hello-world",
					principal,
					env,
				},
				{ createIdempotencyStore: () => store, createRepositoryFactory },
			),
		).rejects.toMatchObject({ status: 503, code: "COMMIT_STATUS_UNKNOWN" });
		expect(createRepositoryFactory).not.toHaveBeenCalled();
		expect(store.complete).not.toHaveBeenCalled();
	});

	it("已完成请求直接回放，不再次更新 GitHub", async () => {
		const createRepositoryFactory = vi.fn();
		const response = await handleUpdateArticle(
			{
				request: createRequest(),
				requestId: "req-replay",
				slug: "hello-world",
				principal,
				env,
			},
			{
				createIdempotencyStore: () => createStore({ state: "completed", result }),
				createRepositoryFactory,
				auditWriter: vi.fn(),
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Idempotency-Replayed")).toBe("true");
		expect(createRepositoryFactory).not.toHaveBeenCalled();
	});

	it("拒绝无效 SHA、非法路由 slug 和未知字段", async () => {
		for (const [slug, body] of [
			["hello-world", { expectedHeadSha: HEAD_SHA, expectedSha: "not-a-sha", article }],
			["../secret", { expectedHeadSha: HEAD_SHA, expectedSha: ORIGINAL_SHA, article }],
			[
				"hello-world",
				{
					expectedHeadSha: HEAD_SHA,
					expectedSha: ORIGINAL_SHA,
					article,
					repositoryPath: "README.md",
				},
			],
		] as const) {
			const store = createStore({ state: "claimed" });
			await expect(
				handleUpdateArticle(
					{ request: createRequest(body), requestId: "req-invalid", slug, principal, env },
					{ createIdempotencyStore: () => store },
				),
			).rejects.toBeDefined();
			expect(store.claim).not.toHaveBeenCalled();
		}
	});

	it("GitHub 冲突保持 409 且 unknown 记录不释放", async () => {
		const store = createStore({ state: "claimed" });
		const conflict = new ApiError(409, "CONFLICT", "远端文件已经变化，请重新加载后再提交。");

		await expect(
			handleUpdateArticle(
				{
					request: createRequest(),
					requestId: "req-conflict",
					slug: "hello-world",
					principal,
					env,
				},
				{
					createIdempotencyStore: () => store,
					createRepositoryFactory: createRepositoryFactory(
						vi.fn<GitProvider["commitFilesAtomically"]>().mockRejectedValue(conflict),
					),
				},
			),
		).rejects.toBe(conflict);
		expect(store.markUnknown).toHaveBeenCalledOnce();
		expect(store.release).not.toHaveBeenCalled();
		expect(store.complete).not.toHaveBeenCalled();
	});

	it("幂等冲突或处理中不会初始化 GitHub", async () => {
		for (const [state, code] of [
			["conflict", "IDEMPOTENCY_CONFLICT"],
			["processing", "IDEMPOTENCY_IN_PROGRESS"],
		] as const) {
			const createRepositoryFactory = vi.fn();
			await expect(
				handleUpdateArticle(
					{
						request: createRequest(),
						requestId: "req-idempotency",
						slug: "hello-world",
						principal,
						env,
					},
					{
						createIdempotencyStore: () => createStore({ state }),
						createRepositoryFactory,
					},
				),
			).rejects.toMatchObject({ status: 409, code });
			expect(createRepositoryFactory).not.toHaveBeenCalled();
		}
	});

	it("正式发布使用独立限流和幂等作用域，并拒绝 draft=true", async () => {
		const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const publishArticle = { ...article, frontmatter: { ...article.frontmatter, draft: false } };
		const store = createStore({ state: "completed", result });
		await handleUpdateArticle(
			{
				request: createRequest({
					expectedHeadSha: HEAD_SHA,
					expectedSha: ORIGINAL_SHA,
					article: publishArticle,
					action: "publish",
				}),
				requestId: "req-publish",
				slug: "hello-world",
				principal,
				env: { RATE_LIMITER: limiter },
			},
			{ createIdempotencyStore: () => store, auditWriter: vi.fn() },
		);
		expect(limiter.limit).toHaveBeenCalledWith({ key: "subject-1:article-publish" });
		expect(store.claim).toHaveBeenCalledWith(
			expect.objectContaining({
				scope: "subject-1:article-update-publish:unique-update-key-123456",
			}),
		);

		await expect(
			handleUpdateArticle(
				{
					request: createRequest({
						expectedHeadSha: HEAD_SHA,
						expectedSha: ORIGINAL_SHA,
						article,
						action: "publish",
					}),
					requestId: "req-invalid-publish",
					slug: "hello-world",
					principal,
					env,
				},
				{ createIdempotencyStore: () => createStore({ state: "claimed" }) },
			),
		).rejects.toMatchObject({ status: 400, code: "INVALID_REQUEST" });
	});

	it("限流拒绝发生在 D1 claim 和 GitHub 之前", async () => {
		const store = createStore({ state: "claimed" });
		const createRepositoryFactory = vi.fn();
		await expect(
			handleUpdateArticle(
				{
					request: createRequest(),
					requestId: "req-limited",
					slug: "hello-world",
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

	it("请求指纹和作用域包含更新语义及 expected SHA", async () => {
		const store = createStore({ state: "completed", result });
		await handleUpdateArticle(
			{
				request: createRequest(),
				requestId: "req-scope",
				slug: "hello-world",
				principal,
				env,
			},
			{
				createIdempotencyStore: () => store,
				auditWriter: vi.fn(),
				now: () => 1_000_000,
			},
		);

		expect(store.claim).toHaveBeenCalledWith({
			scope: "subject-1:article-update-draft:unique-update-key-123456",
			requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			expiresAt: 87_400_000,
			recovery: { kind: "article-update", storageSlug: "hello-world" },
		});
	});
});
