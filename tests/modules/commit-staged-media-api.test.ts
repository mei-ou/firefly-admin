import { describe, expect, it, vi } from "vitest";
import type { IdempotencyStore } from "../../src/core/idempotency/types";
import { handleCommitStagedMedia } from "../../src/modules/media/api/commit-staged-media";
import type { R2BucketBinding, RuntimeEnv } from "../../src/types/env";

const principal = { sub: "subject-1", email: "admin@example.com" };
const id = "123e4567-e89b-12d3-a456-426614174000";
const objectKey = `staging/2026/08/${id}.png`;
const commitSha = "a".repeat(40);
const fileSha = "b".repeat(40);
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const now = Date.parse("2026-08-13T14:00:00.000Z");

function createRequest(key = "media-commit-key-0001"): Request {
	return new Request("https://admin.example.com/api/media/staging/commit", {
		method: "POST",
		headers: { "Content-Type": "application/json", "Idempotency-Key": key },
		body: JSON.stringify({ storageSlug: "hello-world", objectKey, etag: "etag-1" }),
	});
}

function createBucket(): { bucket: R2BucketBinding; deleteObject: ReturnType<typeof vi.fn> } {
	const deleteObject = vi.fn().mockResolvedValue(undefined);
	return {
		bucket: {
			put: vi.fn(),
			get: vi.fn().mockResolvedValue({
				key: objectKey,
				size: pngBytes.byteLength,
				etag: "etag-1",
				uploaded: new Date("2026-08-13T13:00:00.000Z"),
				httpMetadata: { contentType: "image/png" },
				customMetadata: { originalFilename: "cover.png", uploaderSubject: principal.sub },
				arrayBuffer: async () => pngBytes.slice().buffer,
			}),
			list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
			delete: deleteObject,
		},
		deleteObject,
	};
}

function createStore(): IdempotencyStore<never> {
	return {
		claim: vi.fn().mockResolvedValue({ state: "claimed" }),
		complete: vi.fn().mockResolvedValue(undefined),
		release: vi.fn().mockResolvedValue(undefined),
	};
}

function createEnv(bucket: R2BucketBinding | undefined): RuntimeEnv {
	return {
		...(bucket ? { MEDIA_STAGING_BUCKET: bucket } : {}),
		RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
	};
}

function createRepositoryFactory() {
	const getFile = vi.fn().mockResolvedValue({
		path: "src/content/posts/hello-world/index.md",
		sha: "c".repeat(40),
		content: "# Existing article",
		encoding: "utf-8" as const,
	});
	const createBinaryFile = vi.fn().mockImplementation(async ({ path }) => ({
		commitSha,
		commitUrl: `https://github.com/firefly-owner/firefly-blog/commit/${commitSha}`,
		fileSha,
		filePath: path,
	}));
	return {
		getFile,
		createBinaryFile,
		factory: () => ({
			id: "github",
			moduleId: "articles" as const,
			create: () => ({
				config: {
					contentRoot: "src/content/posts",
					usePageBundle: true,
					entryFilename: "index.md",
				},
				provider: { getFile, createBinaryFile },
			}),
		}),
	};
}

describe("R2 暂存图片转存 API", () => {
	it("幂等提交 GitHub 后删除暂存对象并返回严格相对路径", async () => {
		const { bucket, deleteObject } = createBucket();
		const repository = createRepositoryFactory();
		const auditWriter = vi.fn();
		const response = await handleCommitStagedMedia(
			{
				request: createRequest(),
				requestId: "req-media-commit",
				principal,
				env: createEnv(bucket),
			},
			{
				now: () => now,
				auditWriter,
				createIdempotencyStore: createStore,
				createRepositoryFactory: repository.factory,
			},
		);

		expect(response.status).toBe(201);
		expect(deleteObject).toHaveBeenCalledWith(objectKey);
		expect(await response.json()).toMatchObject({
			asset: {
				storageSlug: "hello-world",
				relativePath: "./cover-123e4567e89b.png",
				commitSha,
			},
		});
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({ action: "media.commit", outcome: "success" }),
		);
	});

	it("认证、R2、幂等或限流保护缺失时不触发外部写入", async () => {
		const { bucket, deleteObject } = createBucket();
		const repository = createRepositoryFactory();
		const cases = [
			{ principal: undefined, env: createEnv(bucket), status: 401, store: createStore },
			{ principal, env: createEnv(undefined), status: 503, store: createStore },
			{ principal, env: createEnv(bucket), status: 503, store: undefined },
			{
				principal,
				env: {
					...createEnv(bucket),
					RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
				},
				status: 429,
				store: createStore,
			},
		];
		for (const item of cases) {
			await expect(
				handleCommitStagedMedia(
					{
						request: createRequest(),
						requestId: "req-rejected",
						principal: item.principal,
						env: item.env,
					},
					{
						now: () => now,
						...(item.store ? { createIdempotencyStore: item.store } : {}),
						createRepositoryFactory: repository.factory,
					},
				),
			).rejects.toMatchObject({ status: item.status });
		}
		expect(repository.createBinaryFile).not.toHaveBeenCalled();
		expect(deleteObject).not.toHaveBeenCalled();
	});

	it("R2 清理失败不把已完成 Commit 误报为失败", async () => {
		const { bucket, deleteObject } = createBucket();
		deleteObject.mockRejectedValue(new Error("cleanup failed"));
		const repository = createRepositoryFactory();
		const auditWriter = vi.fn();
		const response = await handleCommitStagedMedia(
			{
				request: createRequest(),
				requestId: "req-cleanup",
				principal,
				env: createEnv(bucket),
			},
			{
				now: () => now,
				auditWriter,
				createIdempotencyStore: createStore,
				createRepositoryFactory: repository.factory,
			},
		);
		expect(response.status).toBe(201);
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({ action: "media.cleanup-staging", outcome: "failure" }),
		);
	});
});
