import { describe, expect, it, vi } from "vitest";
import type { IdempotencyStore } from "../../src/core/idempotency/types";
import { handleDeleteArticle } from "../../src/modules/articles/api/delete-article";
import type { GitProvider } from "../../src/providers/git/types";
import type { ArticleDeleteResult } from "../../src/types/article";
import type { RuntimeEnv } from "../../src/types/env";

const HEAD_SHA = "a".repeat(40);
const ARTICLE_SHA = "b".repeat(40);
const IMAGE_SHA = "c".repeat(40);
const COMMIT_SHA = "d".repeat(40);
const articlePath = "src/content/posts/hello-world/index.md";
const imagePath = "src/content/posts/hello-world/cover-123e4567e89b.png";
const principal = { sub: "subject-1", email: "admin@example.com" };
const result: ArticleDeleteResult = {
	storageSlug: "hello-world",
	pathAlias: "hello-world/index.md",
	commitSha: COMMIT_SHA,
	commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
	deletedFiles: ["hello-world/index.md", "hello-world/cover-123e4567e89b.png"],
};

function request(body: unknown = { expectedHeadSha: HEAD_SHA, expectedSha: ARTICLE_SHA }) {
	return new Request("https://admin.example.com/api/articles/hello-world", {
		method: "DELETE",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": "delete-key-1234567890",
		},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});
}

function store(claim: Awaited<ReturnType<IdempotencyStore<ArticleDeleteResult>["claim"]>>) {
	return {
		claim: vi.fn().mockResolvedValue(claim),
		markUnknown: vi.fn().mockResolvedValue(undefined),
		recordCandidateCommit: vi.fn().mockResolvedValue(undefined),
		complete: vi.fn().mockResolvedValue(undefined),
		release: vi.fn().mockResolvedValue(undefined),
	};
}

function repositoryFactory(
	overrides: {
		entries?: Array<{
			name: string;
			path: string;
			sha: string;
			type: "file" | "directory";
			size: number | null;
		}>;
		commit?: GitProvider["commitFilesAtomically"];
		getHead?: GitProvider["getHead"];
	} = {},
) {
	const entries = overrides.entries ?? [
		{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file", size: 512 },
		{ name: "cover-123e4567e89b.png", path: imagePath, sha: IMAGE_SHA, type: "file", size: 1024 },
	];
	const commit =
		overrides.commit ??
		vi.fn<GitProvider["commitFilesAtomically"]>().mockImplementation(async (input) => {
			await input.checkpointCandidateCommit(COMMIT_SHA);
			return {
				commitSha: COMMIT_SHA,
				commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
				files: input.files.map((file) => ({ path: file.path, fileSha: null })),
			};
		});
	return () => ({
		id: "test-git",
		moduleId: "articles" as const,
		create: () => ({
			config: {
				contentRoot: "src/content/posts",
				entryFilename: "index.md",
				usePageBundle: true,
			},
			provider: {
				getFileAtCommit: vi.fn().mockResolvedValue({
					path: articlePath,
					sha: ARTICLE_SHA,
					content: "# test\n",
					encoding: "utf-8" as const,
				}),
				listDirectoryAtCommit: vi.fn().mockResolvedValue(entries),
				getHead:
					overrides.getHead ??
					vi.fn().mockResolvedValue({
						commitSha: COMMIT_SHA,
						commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
						treeSha: "f".repeat(40),
					}),
				commitFilesAtomically: commit,
			},
		}),
	});
}

function enabledEnv(): RuntimeEnv {
	return {
		FEATURE_ARTICLE_DELETE: "true",
		RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
	};
}

describe("文章删除 API", () => {
	it("在同一原子 Commit 删除文章和可归属小图并记录审计", async () => {
		const idempotency = store({ state: "claimed" });
		const commit = vi
			.fn<GitProvider["commitFilesAtomically"]>()
			.mockImplementation(async (input) => {
				await input.checkpointCandidateCommit(COMMIT_SHA);
				return {
					commitSha: COMMIT_SHA,
					commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
					files: input.files.map((file) => ({ path: file.path, fileSha: null })),
				};
			});
		const auditWriter = vi.fn();
		const response = await handleDeleteArticle(
			{
				request: request(),
				requestId: "req-delete",
				slug: "hello-world",
				principal,
				env: enabledEnv(),
			},
			{
				createIdempotencyStore: () => idempotency,
				createRepositoryFactory: repositoryFactory({ commit }),
				auditWriter,
				now: () => 1_000_000,
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ deletion: result });
		expect(commit.mock.calls[0]?.[0].files).toEqual([
			{ operation: "delete", path: articlePath, expectedSha: ARTICLE_SHA },
			{ operation: "delete", path: imagePath, expectedSha: IMAGE_SHA },
		]);
		expect(idempotency.markUnknown).toHaveBeenCalledWith(
			expect.objectContaining({
				baseHeadSha: HEAD_SHA,
				recovery: { kind: "article-delete", storageSlug: "hello-world" },
			}),
		);
		expect(idempotency.recordCandidateCommit).toHaveBeenCalledWith(
			expect.objectContaining({ candidateCommitSha: COMMIT_SHA }),
		);
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "article.delete",
				target: "hello-world",
				metadata: { commitSha: COMMIT_SHA, replayed: false, deletedFileCount: 2 },
			}),
		);
	});

	it("能力关闭时在认证、限流、D1 和 Provider 前返回 404", async () => {
		const createStore = vi.fn();
		const createRepositoryFactory = vi.fn();
		const limiter = { limit: vi.fn().mockResolvedValue({ success: true }) };
		await expect(
			handleDeleteArticle(
				{
					request: request(),
					requestId: "req-disabled",
					slug: "hello-world",
					principal: undefined,
					env: { FEATURE_ARTICLE_DELETE: "false", RATE_LIMITER: limiter },
				},
				{ createIdempotencyStore: createStore, createRepositoryFactory },
			),
		).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
		expect(limiter.limit).not.toHaveBeenCalled();
		expect(createStore).not.toHaveBeenCalled();
		expect(createRepositoryFactory).not.toHaveBeenCalled();
	});

	it("未知文件在 markUnknown 和 Git 前失败并释放幂等占位", async () => {
		const idempotency = store({ state: "claimed" });
		const commit = vi.fn<GitProvider["commitFilesAtomically"]>();
		await expect(
			handleDeleteArticle(
				{
					request: request(),
					requestId: "req-unsafe",
					slug: "hello-world",
					principal,
					env: enabledEnv(),
				},
				{
					createIdempotencyStore: () => idempotency,
					createRepositoryFactory: repositoryFactory({
						commit,
						entries: [
							{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file", size: 512 },
							{
								name: "manual.png",
								path: "src/content/posts/hello-world/manual.png",
								sha: IMAGE_SHA,
								type: "file",
								size: 12,
							},
						],
					}),
				},
			),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		expect(idempotency.markUnknown).not.toHaveBeenCalled();
		expect(idempotency.release).toHaveBeenCalledOnce();
		expect(commit).not.toHaveBeenCalled();
	});

	it("unknown 候选已成为 HEAD 时只读恢复，不再次调用 Git 写", async () => {
		const idempotency = store({
			state: "unknown",
			baseHeadSha: HEAD_SHA,
			candidateCommitSha: COMMIT_SHA,
			recovery: { kind: "article-delete", storageSlug: "hello-world" },
		});
		const commit = vi.fn<GitProvider["commitFilesAtomically"]>();
		const factory = repositoryFactory({ commit });
		const response = await handleDeleteArticle(
			{
				request: request(),
				requestId: "req-recover",
				slug: "hello-world",
				principal,
				env: enabledEnv(),
			},
			{
				createIdempotencyStore: () => idempotency,
				createRepositoryFactory: () => {
					const created = factory();
					const originalCreate = created.create;
					return {
						...created,
						create: () => {
							const repository = originalCreate();
							return {
								...repository,
								provider: {
									...repository.provider,
									listDirectoryAtCommit: vi.fn(async (_path: string, sha: string) => {
										if (sha === HEAD_SHA) {
											return [
												{
													name: "index.md",
													path: articlePath,
													sha: ARTICLE_SHA,
													type: "file" as const,
													size: 512,
												},
												{
													name: "cover-123e4567e89b.png",
													path: imagePath,
													sha: IMAGE_SHA,
													type: "file" as const,
													size: 1024,
												},
											];
										}
										const { ApiError } = await import("../../src/core/http/errors");
										throw new ApiError(404, "NOT_FOUND", "远端文件不存在。");
									}),
								},
							};
						},
					};
				},
			},
		);
		expect(response.headers.get("Idempotency-Replayed")).toBe("true");
		expect(commit).not.toHaveBeenCalled();
		expect(idempotency.complete).toHaveBeenCalledWith(expect.objectContaining({ result }));
	});

	it("幂等完成记录直接回放，不初始化 Provider", async () => {
		const createRepositoryFactory = vi.fn();
		const response = await handleDeleteArticle(
			{
				request: request(),
				requestId: "req-replay",
				slug: "hello-world",
				principal,
				env: enabledEnv(),
			},
			{
				createIdempotencyStore: () => store({ state: "completed", result }),
				createRepositoryFactory,
			},
		);
		expect(response.headers.get("Idempotency-Replayed")).toBe("true");
		expect(createRepositoryFactory).not.toHaveBeenCalled();
	});
});
