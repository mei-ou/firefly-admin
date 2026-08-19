import { describe, expect, it, vi } from "vitest";
import { handleCommitMediaTransaction } from "../../src/modules/media/api/commit-media-transaction";
import type {
	MediaTransactionCommitClaimResult,
	MediaTransactionCommitReadResult,
	MediaTransactionPreviewCommitStore,
} from "../../src/modules/media/d1-media-transaction-preview-store";
import type {
	MediaTransactionCommitResult,
	RenameMediaTransactionCommitPlan,
} from "../../src/modules/media/media-transaction-commit";
import type { MediaTransactionPreview } from "../../src/modules/media/media-transaction-preview";
import type { GitProvider } from "../../src/providers/git/types";
import type { RuntimeEnv } from "../../src/types/env";

const HEAD_SHA = "a".repeat(40);
const ARTICLE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const COMMIT_SHA = "d".repeat(40);
const previewId = "preview_1234567890abcdef";
const principal = { sub: "subject-1", email: "admin@example.com" };
const pathConfig = {
	contentRoot: "src/content/posts",
	entryFilename: "index.md",
	usePageBundle: true,
};

function createPreview(): MediaTransactionPreview {
	return {
		version: 1,
		previewId,
		operation: "rename",
		storageSlug: "hello-world",
		createdAt: "2026-08-17T01:00:00.000Z",
		expiresAt: "2026-08-17T01:10:00.000Z",
		baseCommitSha: HEAD_SHA,
		expectedArticleSha: ARTICLE_SHA,
		expectedBlobSha: BLOB_SHA,
		source: {
			filename: "old-guide.pdf",
			relativePath: "./old-guide.pdf",
			repositoryPath: "src/content/posts/hello-world/old-guide.pdf",
		},
		destination: {
			filename: "new-guide.pdf",
			relativePath: "./new-guide.pdf",
			repositoryPath: "src/content/posts/hello-world/new-guide.pdf",
		},
		effects: [
			{
				type: "resource-reuse",
				repositoryPath: "src/content/posts/hello-world/new-guide.pdf",
				from: null,
				to: BLOB_SHA,
			},
			{
				type: "resource-delete",
				repositoryPath: "src/content/posts/hello-world/old-guide.pdf",
				from: BLOB_SHA,
				to: null,
			},
		],
		references: [],
		referenceAnalysis: { complete: true, issues: [] },
		policyLevel: "L0",
		riskLevel: "low",
		riskReasons: [],
		confirmation: { kind: "button" },
	};
}

function createPlan(): RenameMediaTransactionCommitPlan {
	return {
		version: 1,
		operation: "rename",
		previewId,
		storageSlug: "hello-world",
		baseCommitSha: HEAD_SHA,
		source: {
			repositoryPath: "src/content/posts/hello-world/old-guide.pdf",
			blobSha: BLOB_SHA,
		},
		destination: {
			repositoryPath: "src/content/posts/hello-world/new-guide.pdf",
			reusedBlobSha: BLOB_SHA,
		},
		article: {
			mode: "unchanged",
			repositoryPath: "src/content/posts/hello-world/index.md",
			expectedSha: ARTICLE_SHA,
			originalContent: "article",
			plannedContent: "article",
			replacements: [],
		},
	};
}

function createResult(): MediaTransactionCommitResult {
	return {
		version: 1,
		operation: "rename",
		previewId,
		commitSha: COMMIT_SHA,
		url: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
		article: { updated: false, fileSha: ARTICLE_SHA },
		source: { deleted: true },
		destination: { blobSha: BLOB_SHA },
		completedAt: "2026-08-17T01:02:00.000Z",
	};
}

function createRequest(
	input: unknown = { previewId, confirmation: { kind: "button" } },
	key = "media-key-1234567890",
) {
	return new Request("https://admin.example.com/api/media/transactions/commit", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Idempotency-Key": key,
		},
		body: typeof input === "string" ? input : JSON.stringify(input),
	});
}

function createRepositoryFactory() {
	const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>();
	const factory = vi.fn(() => ({
		id: "test-git",
		moduleId: "articles" as const,
		create: () => ({
			config: pathConfig,
			provider: {
				getHead: vi.fn(),
				getFileAtCommit: vi.fn(),
				listDirectoryAtCommit: vi.fn(),
				commitFilesAtomically,
			},
		}),
	}));
	return { factory, commitFilesAtomically };
}

function createStore(initial: MediaTransactionCommitReadResult) {
	let state = initial;
	const store: MediaTransactionPreviewCommitStore = {
		createOrReuse: vi.fn(),
		getForCommit: vi.fn(async () => state),
		claimCommit: vi.fn<MediaTransactionPreviewCommitStore["claimCommit"]>(
			async ({ claimToken }) => {
				if (state.state !== "ready") return state as MediaTransactionCommitClaimResult;
				return {
					state: "claimed" as const,
					preview: state.preview,
					claimToken,
					claimExpiresAt: Date.parse("2026-08-17T01:01:00.000Z"),
				};
			},
		),
		armUnknown: vi.fn(async ({ plan }) => ({ plan, planHash: "e".repeat(64) })),
		recordCandidateCommit: vi.fn(),
		releaseBeforeCandidate: vi.fn(),
		consume: vi.fn(async ({ result, planHash, candidateCommitSha }) => {
			state = {
				state: "consumed",
				preview: createPreview(),
				plan: createPlan(),
				planHash,
				candidateCommitSha,
				result,
			};
		}),
		completeRecovered: vi.fn(),
	};
	return store;
}

const env: RuntimeEnv = {
	FEATURE_ARTICLE_ASSET_RENAME: "true",
	RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: true }) },
};

function context(request = createRequest(), requestEnv = env) {
	return {
		request,
		requestId: "req-media-commit",
		principal,
		env: requestEnv,
	};
}

function anonymousContext(request = createRequest(), requestEnv = env) {
	return {
		request,
		requestId: "req-media-commit",
		principal: undefined,
		env: requestEnv,
	};
}

describe("媒体事务 Commit API", () => {
	it("正常调用顺序为 claim、prepare、arm、Git checkpoint、consume，并返回 no-store", async () => {
		const events: string[] = [];
		const store = createStore({ state: "ready", preview: createPreview() });
		vi.mocked(store.claimCommit).mockImplementation(async ({ claimToken }) => {
			events.push("claim");
			return {
				state: "claimed",
				preview: createPreview(),
				claimToken,
				claimExpiresAt: Date.parse("2026-08-17T01:01:00.000Z"),
			};
		});
		vi.mocked(store.armUnknown).mockImplementation(async ({ plan }) => {
			events.push("arm");
			return { plan, planHash: "e".repeat(64) };
		});
		vi.mocked(store.recordCandidateCommit).mockImplementation(async () => {
			events.push("candidate");
		});
		vi.mocked(store.consume).mockImplementation(async () => {
			events.push("consume");
		});
		const repository = createRepositoryFactory();
		const auditWriter = vi.fn();
		const response = await handleCommitMediaTransaction(context(), {
			createRepositoryFactory: repository.factory,
			createCommitStore: () => store,
			createClaimToken: () => "claim_1234567890abcdef",
			prepareCommit: vi.fn(async () => {
				events.push("prepare");
				return createPlan();
			}),
			executeCommit: vi.fn(async (_plan, _preview, dependencies) => {
				events.push("git");
				await dependencies.checkpointCandidateCommit(COMMIT_SHA);
				return createResult();
			}),
			now: () => Date.parse("2026-08-17T01:02:00.000Z"),
			auditWriter,
		});

		expect(events).toEqual(["claim", "prepare", "arm", "git", "candidate", "consume"]);
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(response.headers.get("Idempotency-Replayed")).toBe("false");
		expect(await response.json()).toEqual({ transaction: createResult() });
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "media.transaction-commit",
				metadata: expect.objectContaining({
					previewId,
					candidateCommitSha: COMMIT_SHA,
					replayed: false,
					recovered: false,
				}),
			}),
		);
		const audit = JSON.stringify(auditWriter.mock.calls);
		expect(audit).not.toContain("media-key-1234567890");
		expect(audit).not.toContain("article");
	});

	it("consumed 稳定回放不调用 prepare、execute 或 Git", async () => {
		const store = createStore({
			state: "consumed",
			preview: createPreview(),
			plan: createPlan(),
			planHash: "e".repeat(64),
			candidateCommitSha: COMMIT_SHA,
			result: createResult(),
		});
		const repository = createRepositoryFactory();
		const prepareCommit = vi.fn();
		const executeCommit = vi.fn();
		const response = await handleCommitMediaTransaction(context(), {
			createRepositoryFactory: repository.factory,
			createCommitStore: () => store,
			prepareCommit,
			executeCommit,
			auditWriter: vi.fn(),
		});
		expect(response.headers.get("Idempotency-Replayed")).toBe("true");
		expect(prepareCommit).not.toHaveBeenCalled();
		expect(executeCommit).not.toHaveBeenCalled();
		expect(repository.commitFilesAtomically).not.toHaveBeenCalled();
	});

	it("unknown 只调用恢复；无法证明时保持 COMMIT_STATUS_UNKNOWN", async () => {
		const store = createStore({
			state: "unknown",
			preview: createPreview(),
			plan: createPlan(),
			planHash: "e".repeat(64),
			candidateCommitSha: COMMIT_SHA,
		});
		const repository = createRepositoryFactory();
		const recoverCommit = vi.fn().mockResolvedValue(undefined);
		await expect(
			handleCommitMediaTransaction(context(), {
				createRepositoryFactory: repository.factory,
				createCommitStore: () => store,
				recoverCommit,
			}),
		).rejects.toMatchObject({ status: 503, code: "COMMIT_STATUS_UNKNOWN" });
		expect(recoverCommit).toHaveBeenCalledOnce();
		expect(store.claimCommit).not.toHaveBeenCalled();
		expect(repository.commitFilesAtomically).not.toHaveBeenCalled();
	});

	it("candidate checkpoint 后错误不 release，candidate 前错误才 release", async () => {
		for (const checkpoint of [false, true]) {
			const store = createStore({ state: "ready", preview: createPreview() });
			const repository = createRepositoryFactory();
			const operation = handleCommitMediaTransaction(context(), {
				createRepositoryFactory: repository.factory,
				createCommitStore: () => store,
				createClaimToken: () => "claim_1234567890abcdef",
				prepareCommit: vi.fn().mockResolvedValue(createPlan()),
				executeCommit: vi.fn(async (_plan, _preview, dependencies) => {
					if (checkpoint) await dependencies.checkpointCandidateCommit(COMMIT_SHA);
					throw new Error("upstream");
				}),
			});
			if (checkpoint) {
				await expect(operation).rejects.toMatchObject({ code: "COMMIT_STATUS_UNKNOWN" });
				expect(store.releaseBeforeCandidate).not.toHaveBeenCalled();
			} else {
				await expect(operation).rejects.toThrow("upstream");
				expect(store.releaseBeforeCandidate).toHaveBeenCalledOnce();
			}
		}
	});

	it("consume 失败且不能证明 consumed 时返回 unknown", async () => {
		const store = createStore({ state: "ready", preview: createPreview() });
		vi.mocked(store.consume).mockRejectedValue(new Error("D1 failed"));
		const repository = createRepositoryFactory();
		await expect(
			handleCommitMediaTransaction(context(), {
				createRepositoryFactory: repository.factory,
				createCommitStore: () => store,
				createClaimToken: () => "claim_1234567890abcdef",
				prepareCommit: vi.fn().mockResolvedValue(createPlan()),
				executeCommit: vi.fn(async (_plan, _preview, dependencies) => {
					await dependencies.checkpointCandidateCommit(COMMIT_SHA);
					return createResult();
				}),
			}),
		).rejects.toMatchObject({ code: "COMMIT_STATUS_UNKNOWN" });
	});

	it("认证、D1、strict body、幂等键和限流均在 Git 写前失败", async () => {
		const cases: Array<{
			request: Request;
			principal: typeof principal | undefined;
			env: RuntimeEnv;
			dependencies?: Parameters<typeof handleCommitMediaTransaction>[1];
			code: string;
		}> = [
			{ request: createRequest(), principal: undefined, env, code: "AUTH_REQUIRED" },
			{ request: createRequest(), principal, env, code: "MEDIA_TRANSACTION_UNAVAILABLE" },
			{
				request: createRequest({ previewId, confirmation: { kind: "button" }, path: "README.md" }),
				principal,
				env: { ...env, IDEMPOTENCY_DB: { prepare: vi.fn() } },
				code: "INVALID_REQUEST",
			},
			{
				request: createRequest(undefined, "short"),
				principal,
				env: { ...env, IDEMPOTENCY_DB: { prepare: vi.fn() } },
				code: "INVALID_REQUEST",
			},
			{
				request: createRequest(),
				principal,
				env: {
					FEATURE_ARTICLE_ASSET_RENAME: "true",
					RATE_LIMITER: { limit: vi.fn().mockResolvedValue({ success: false }) },
				},
				dependencies: {
					createCommitStore: () => createStore({ state: "ready", preview: createPreview() }),
				},
				code: "RATE_LIMITED",
			},
		];
		for (const testCase of cases) {
			const createRepositoryFactory = vi.fn();
			const requestContext =
				testCase.principal === undefined
					? anonymousContext(testCase.request, testCase.env)
					: context(testCase.request, testCase.env);
			await expect(
				handleCommitMediaTransaction(requestContext, {
					...testCase.dependencies,
					createRepositoryFactory,
				}),
			).rejects.toMatchObject({ code: testCase.code });
			expect(createRepositoryFactory).not.toHaveBeenCalled();
		}
	});
});
