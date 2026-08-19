import { describe, expect, it, vi } from "vitest";
import type { IdempotencyStatus, IdempotencyStore } from "../../src/core/idempotency/types";
import { handleRecoverArticleCommit } from "../../src/modules/articles/api/recover-article-commit";
import type { GitProvider } from "../../src/providers/git/types";
import type { ArticleCommitResult } from "../../src/types/article";
import type { RuntimeEnv } from "../../src/types/env";
import type { ProviderFactory } from "../../src/types/provider";

const BASE_HEAD_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const FILE_SHA = "c".repeat(40);
const principal = { sub: "subject-1", email: "admin@example.com" };
const result: ArticleCommitResult = {
	storageSlug: "hello-world",
	pathAlias: "hello-world/index.md",
	commitSha: CANDIDATE_SHA,
	commitUrl: `https://github.com/owner/repo/commit/${CANDIDATE_SHA}`,
	fileSha: FILE_SHA,
};
const env: RuntimeEnv = {
	RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

function createStatus(
	overrides: Partial<IdempotencyStatus<ArticleCommitResult>> = {},
): IdempotencyStatus<ArticleCommitResult> {
	return {
		state: "unknown",
		requestHash: "request-hash",
		baseHeadSha: BASE_HEAD_SHA,
		candidateCommitSha: CANDIDATE_SHA,
		recovery: { kind: "article-update", storageSlug: "hello-world" },
		expiresAt: 2_000_000,
		...overrides,
	};
}

function createStore(status: IdempotencyStatus<ArticleCommitResult> | undefined) {
	return {
		getStatusByScope: vi.fn().mockResolvedValue(status),
		completeUnknown: vi.fn().mockResolvedValue(undefined),
	} as unknown as IdempotencyStore<ArticleCommitResult> & {
		getStatusByScope: ReturnType<typeof vi.fn>;
		completeUnknown: ReturnType<typeof vi.fn>;
	};
}

function createRequest(method: "GET" | "POST", body?: unknown) {
	return new Request(
		"https://admin.example.com/api/articles/recover?operation=article-update-draft",
		{
			method,
			headers: {
				...(method === "POST" ? { "Content-Type": "application/json" } : {}),
				"Idempotency-Key": "recover-request-key-123456",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		},
	);
}

function createRepositoryFactory(
	getHead: GitProvider["getHead"] = vi.fn().mockResolvedValue({
		commitSha: CANDIDATE_SHA,
		commitUrl: result.commitUrl,
		treeSha: "d".repeat(40),
	}),
	getFileAtCommit: GitProvider["getFileAtCommit"] = vi.fn().mockResolvedValue({
		path: "src/content/posts/hello-world/index.md",
		sha: FILE_SHA,
		content: "# recovered\n",
		encoding: "utf-8",
	}),
) {
	return (): ProviderFactory<{
		config: { contentRoot: string; entryFilename: string; usePageBundle: boolean };
		provider: Pick<GitProvider, "getFileAtCommit" | "getHead">;
	}> => ({
		id: "test-git",
		moduleId: "articles",
		create: () => ({
			config: {
				contentRoot: "src/content/posts",
				entryFilename: "index.md",
				usePageBundle: true,
			},
			provider: { getHead, getFileAtCommit },
		}),
	});
}

describe("文章 unknown 人工恢复 API", () => {
	it("GET 只返回状态和检查点，不初始化 Git Provider", async () => {
		const store = createStore(createStatus());
		const createRepositoryFactorySpy = vi.fn(createRepositoryFactory());

		const response = await handleRecoverArticleCommit(
			{ request: createRequest("GET"), requestId: "req-status", principal, env },
			{ createIdempotencyStore: () => store, createRepositoryFactory: createRepositoryFactorySpy },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			recovery: {
				status: "unknown",
				baseHeadSha: BASE_HEAD_SHA,
				candidateCommitSha: CANDIDATE_SHA,
				canConfirm: true,
			},
		});
		expect(createRepositoryFactorySpy).not.toHaveBeenCalled();
		expect(store.completeUnknown).not.toHaveBeenCalled();
	});

	it("候选 Commit 已成为 HEAD 时才完成原 unknown 记录", async () => {
		const store = createStore(createStatus());
		const getHead = vi.fn<GitProvider["getHead"]>().mockResolvedValue({
			commitSha: CANDIDATE_SHA,
			commitUrl: result.commitUrl,
			treeSha: "d".repeat(40),
		});

		const response = await handleRecoverArticleCommit(
			{
				request: createRequest("POST", {
					operation: "article-update-draft",
					baseHeadSha: BASE_HEAD_SHA,
				}),
				requestId: "req-confirm",
				principal,
				env,
			},
			{
				createIdempotencyStore: () => store,
				createRepositoryFactory: createRepositoryFactory(getHead),
			},
		);

		expect(response.status).toBe(200);
		expect(store.completeUnknown).toHaveBeenCalledWith({
			scope: expect.stringContaining("article-update-draft"),
			requestHash: "request-hash",
			result,
		});
		expect(await response.json()).toMatchObject({ recovery: { status: "completed" } });
	});

	it("HEAD 已分叉时保持 unknown 且不完成记录", async () => {
		const store = createStore(createStatus());
		const divergentHead = "e".repeat(40);
		const getHead = vi.fn<GitProvider["getHead"]>().mockResolvedValue({
			commitSha: divergentHead,
			commitUrl: `https://github.com/owner/repo/commit/${divergentHead}`,
			treeSha: "d".repeat(40),
		});

		await expect(
			handleRecoverArticleCommit(
				{
					request: createRequest("POST", {
						operation: "article-update-draft",
						baseHeadSha: BASE_HEAD_SHA,
					}),
					requestId: "req-diverged",
					principal,
					env,
				},
				{
					createIdempotencyStore: () => store,
					createRepositoryFactory: createRepositoryFactory(getHead),
				},
			),
		).rejects.toMatchObject({ status: 409, code: "COMMIT_STATUS_UNKNOWN" });
		expect(store.completeUnknown).not.toHaveBeenCalled();
	});

	it("确认基线不一致时在读取 Git 前拒绝", async () => {
		const store = createStore(createStatus());
		const createRepositoryFactorySpy = vi.fn(createRepositoryFactory());

		await expect(
			handleRecoverArticleCommit(
				{
					request: createRequest("POST", {
						operation: "article-update-draft",
						baseHeadSha: "f".repeat(40),
					}),
					requestId: "req-conflict",
					principal,
					env,
				},
				{
					createIdempotencyStore: () => store,
					createRepositoryFactory: createRepositoryFactorySpy,
				},
			),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		expect(createRepositoryFactorySpy).not.toHaveBeenCalled();
	});
});
