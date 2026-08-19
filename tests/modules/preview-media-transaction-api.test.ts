import { describe, expect, it, vi } from "vitest";
import { handlePreviewMediaTransaction } from "../../src/modules/media/api/preview-media-transaction";
import type { MediaTransactionPreviewStore } from "../../src/modules/media/d1-media-transaction-preview-store";
import type { GitProvider } from "../../src/providers/git/types";
import type { RuntimeEnv } from "../../src/types/env";

const HEAD_SHA = "a".repeat(40);
const ARTICLE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const principal = { sub: "subject-1", email: "admin@example.com" };
const articlePath = "src/content/posts/hello-world/index.md";
const resourcePath = "src/content/posts/hello-world/old-guide.pdf";
const DESTINATION_ARTICLE_SHA = "d".repeat(40);
const body = {
	version: 1,
	operation: "rename",
	storageSlug: "hello-world",
	sourceFilename: "old-guide.pdf",
	destinationFilename: "new-guide.pdf",
	expectedHeadSha: HEAD_SHA,
	expectedArticleSha: ARTICLE_SHA,
	expectedBlobSha: BLOB_SHA,
};
const moveBody = {
	version: 1,
	operation: "move",
	expectedHeadSha: HEAD_SHA,
	source: {
		storageSlug: "source-post",
		filename: "guide.png",
		expectedArticleSha: ARTICLE_SHA,
		expectedBlobSha: BLOB_SHA,
	},
	destination: {
		storageSlug: "destination-post",
		filename: "moved-guide.png",
		expectedArticleSha: DESTINATION_ARTICLE_SHA,
	},
};
const article = `---
title: 测试文章
published: 2026-08-17T00:00:00.000Z
draft: true
description: ""
image: ""
tags: []
category: null
lang: zh_CN
pinned: false
author: ""
sourceLink: ""
licenseName: ""
licenseUrl: ""
comment: true
password: ""
passwordHint: ""
---
正文
`;

function createRequest(input: unknown = body) {
	return new Request("https://admin.example.com/api/media/transactions/preview", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: typeof input === "string" ? input : JSON.stringify(input),
	});
}

function createRepositoryFactory() {
	const getHead = vi.fn<GitProvider["getHead"]>().mockResolvedValue({
		commitSha: HEAD_SHA,
		commitUrl: `https://github.com/owner/repo/commit/${HEAD_SHA}`,
		treeSha: "d".repeat(40),
	});
	const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
		path: articlePath,
		sha: ARTICLE_SHA,
		content: article,
		encoding: "utf-8",
	});
	const listDirectoryAtCommit = vi.fn<GitProvider["listDirectoryAtCommit"]>().mockResolvedValue([
		{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file", size: 100 },
		{
			name: "old-guide.pdf",
			path: resourcePath,
			sha: BLOB_SHA,
			type: "file",
			size: 1024,
		},
	]);
	const factory = vi.fn(() => ({
		id: "test-git",
		moduleId: "articles" as const,
		create: () => ({
			config: {
				contentRoot: "src/content/posts",
				entryFilename: "index.md",
				usePageBundle: true,
			},
			provider: { getHead, getFileAtCommit, listDirectoryAtCommit },
		}),
	}));
	return { factory, getHead, getFileAtCommit, listDirectoryAtCommit };
}

function createStore(): MediaTransactionPreviewStore & { createOrReuse: ReturnType<typeof vi.fn> } {
	return {
		createOrReuse: vi.fn(async ({ preview }) => ({ preview, reused: false })),
	};
}

const env: RuntimeEnv = {
	FEATURE_ARTICLE_ASSET_RENAME: "true",
	RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

describe("媒体事务 Preview API", () => {
	it("使用独立限流、持久化 Preview 并返回 no-store 响应和脱敏审计", async () => {
		const repository = createRepositoryFactory();
		const store = createStore();
		const auditWriter = vi.fn();
		const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		const response = await handlePreviewMediaTransaction(
			{
				request: createRequest(),
				requestId: "req-preview",
				principal,
				env: { FEATURE_ARTICLE_ASSET_RENAME: "true", RATE_LIMITER: limiter },
			},
			{
				createRepositoryFactory: repository.factory,
				createPreviewStore: () => store,
				createPreviewId: () => "preview_1234567890abcdef",
				now: () => Date.parse("2026-08-17T01:00:00.000Z"),
				auditWriter,
			},
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Preview-Reused")).toBe("false");
		expect(limiter.limit).toHaveBeenCalledWith({ key: "subject-1:media-transaction-preview" });
		expect(store.createOrReuse).toHaveBeenCalledWith(
			expect.objectContaining({
				subject: principal.sub,
				requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			}),
		);
		expect(await response.json()).toMatchObject({
			preview: { previewId: "preview_1234567890abcdef", operation: "rename" },
		});
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "media.transaction-preview",
				target: "hello-world",
				metadata: {
					previewId: "preview_1234567890abcdef",
					operation: "rename",
					riskLevel: "low",
					effectCount: 2,
					referenceCount: 0,
					baseCommitSha: HEAD_SHA,
					reused: false,
				},
			}),
		);
		expect(JSON.stringify(auditWriter.mock.calls)).not.toContain(article);
	});

	it("匿名、缺少 D1 和无效 strict 输入均在 Git 初始化前失败", async () => {
		for (const [request, requestPrincipal, requestEnv, expected] of [
			[createRequest(), undefined, env, { status: 401, code: "AUTH_REQUIRED" }],
			[createRequest(), principal, env, { status: 503, code: "MEDIA_PREVIEW_UNAVAILABLE" }],
			[
				createRequest({ ...body, repositoryPath: "README.md" }),
				principal,
				{ ...env, IDEMPOTENCY_DB: {} },
				undefined,
			],
			[
				createRequest({
					...moveBody,
					destination: { ...moveBody.destination, repositoryPath: "README.md" },
				}),
				principal,
				{ ...env, IDEMPOTENCY_DB: {} },
				undefined,
			],
		] as const) {
			const createRepositoryFactory = vi.fn();
			const operation = handlePreviewMediaTransaction(
				{
					request,
					requestId: "req-invalid-preview",
					principal: requestPrincipal,
					env: requestEnv as RuntimeEnv,
				},
				{ createRepositoryFactory },
			);
			if (expected) await expect(operation).rejects.toMatchObject(expected);
			else await expect(operation).rejects.toBeDefined();
			expect(createRepositoryFactory).not.toHaveBeenCalled();
		}
	});

	it("限流拒绝发生在 Git 和 Preview Store 之前", async () => {
		const createRepositoryFactory = vi.fn();
		const createPreviewStore = vi.fn();
		await expect(
			handlePreviewMediaTransaction(
				{
					request: createRequest(),
					requestId: "req-limited-preview",
					principal,
					env: {
						FEATURE_ARTICLE_ASSET_RENAME: "true",
						RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
					},
				},
				{ createRepositoryFactory, createPreviewStore },
			),
		).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
		expect(createRepositoryFactory).not.toHaveBeenCalled();
		expect(createPreviewStore).not.toHaveBeenCalled();
	});
});
