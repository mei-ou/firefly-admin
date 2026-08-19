import { describe, expect, it, vi } from "vitest";
import { executeIdempotently } from "../../src/core/idempotency/execute-idempotently";
import type { IdempotencyStore } from "../../src/core/idempotency/types";

interface TestResult {
	commitSha: string;
}

function createStore(overrides: Partial<IdempotencyStore<TestResult>> = {}) {
	return {
		claim: overrides.claim ?? vi.fn().mockResolvedValue({ state: "claimed" }),
		complete: overrides.complete ?? vi.fn().mockResolvedValue(undefined),
		release: overrides.release ?? vi.fn().mockResolvedValue(undefined),
	};
}

const baseOptions = {
	scope: "subject-1:article-create:unique-key-123456",
	requestHash: "request-hash",
	expiresAt: 1_800_000_000_000,
};

describe("幂等执行编排", () => {
	it("首次占位成功后只执行一次并持久化结果", async () => {
		const store = createStore();
		const execute = vi.fn().mockResolvedValue({ commitSha: "commit-1" });

		const output = await executeIdempotently({ ...baseOptions, store, execute });

		expect(output).toEqual({ result: { commitSha: "commit-1" }, replayed: false });
		expect(execute).toHaveBeenCalledOnce();
		expect(store.complete).toHaveBeenCalledWith({
			scope: baseOptions.scope,
			requestHash: baseOptions.requestHash,
			result: { commitSha: "commit-1" },
		});
		expect(store.release).not.toHaveBeenCalled();
	});

	it("已完成的相同请求直接回放结果", async () => {
		const store = createStore({
			claim: vi.fn().mockResolvedValue({
				state: "completed",
				result: { commitSha: "commit-existing" },
			}),
		});
		const execute = vi.fn();

		await expect(executeIdempotently({ ...baseOptions, store, execute })).resolves.toEqual({
			result: { commitSha: "commit-existing" },
			replayed: true,
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("相同键用于不同请求时拒绝复用", async () => {
		const store = createStore({ claim: vi.fn().mockResolvedValue({ state: "conflict" }) });
		const execute = vi.fn();

		await expect(executeIdempotently({ ...baseOptions, store, execute })).rejects.toMatchObject({
			status: 409,
			code: "IDEMPOTENCY_CONFLICT",
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("并发处理中不会重复执行外部副作用", async () => {
		const store = createStore({ claim: vi.fn().mockResolvedValue({ state: "processing" }) });
		const execute = vi.fn();

		await expect(executeIdempotently({ ...baseOptions, store, execute })).rejects.toMatchObject({
			status: 409,
			code: "IDEMPOTENCY_IN_PROGRESS",
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("unknown 请求失败关闭且不会再次执行", async () => {
		const store = createStore({
			claim: vi.fn().mockResolvedValue({
				state: "unknown",
				baseHeadSha: "a".repeat(40),
				candidateCommitSha: "b".repeat(40),
			}),
		});
		const execute = vi.fn();

		await expect(executeIdempotently({ ...baseOptions, store, execute })).rejects.toMatchObject({
			status: 503,
			code: "COMMIT_STATUS_UNKNOWN",
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("unknown 可只读证明成功时完成原记录并作为回放返回", async () => {
		const store = createStore({
			claim: vi.fn().mockResolvedValue({
				state: "unknown",
				baseHeadSha: "a".repeat(40),
				candidateCommitSha: "b".repeat(40),
			}),
		});
		const recovered = { commitSha: "b".repeat(40) };
		const recoverUnknown = vi.fn().mockResolvedValue(recovered);
		const execute = vi.fn();

		await expect(
			executeIdempotently({ ...baseOptions, store, recoverUnknown, execute }),
		).resolves.toEqual({ result: recovered, replayed: true });
		expect(recoverUnknown).toHaveBeenCalledWith({
			baseHeadSha: "a".repeat(40),
			candidateCommitSha: "b".repeat(40),
		});
		expect(store.complete).toHaveBeenCalledWith({
			scope: baseOptions.scope,
			requestHash: baseOptions.requestHash,
			result: recovered,
		});
		expect(execute).not.toHaveBeenCalled();
	});

	it("unknown 无法证明成功时保持失败关闭且不写 completed", async () => {
		const store = createStore({
			claim: vi.fn().mockResolvedValue({ state: "unknown" }),
		});
		const recoverUnknown = vi.fn().mockResolvedValue(undefined);

		await expect(
			executeIdempotently({ ...baseOptions, store, recoverUnknown, execute: vi.fn() }),
		).rejects.toMatchObject({ status: 503, code: "COMMIT_STATUS_UNKNOWN" });
		expect(store.complete).not.toHaveBeenCalled();
	});

	it("外部操作失败时释放 processing 占位供重试", async () => {
		const store = createStore();
		const failure = new Error("upstream failed");

		await expect(
			executeIdempotently({
				...baseOptions,
				store,
				execute: vi.fn().mockRejectedValue(failure),
			}),
		).rejects.toBe(failure);
		expect(store.release).toHaveBeenCalledWith({
			scope: baseOptions.scope,
			requestHash: baseOptions.requestHash,
		});
		expect(store.complete).not.toHaveBeenCalled();
	});

	it("外部操作成功但结果持久化失败时不释放占位", async () => {
		const failure = new Error("D1 complete failed");
		const store = createStore({ complete: vi.fn().mockRejectedValue(failure) });

		await expect(
			executeIdempotently({
				...baseOptions,
				store,
				execute: vi.fn().mockResolvedValue({ commitSha: "commit-created" }),
			}),
		).rejects.toBe(failure);
		expect(store.release).not.toHaveBeenCalled();
	});
});
