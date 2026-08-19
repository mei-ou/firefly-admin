import { describe, expect, it } from "vitest";
import {
	type D1DatabaseLike,
	D1IdempotencyStore,
	type D1PreparedStatementLike,
} from "../../src/core/idempotency/d1-idempotency-store";

interface TestResult {
	commitSha: string;
}

function createDatabase(options: {
	insertChanges?: number;
	row?: unknown;
	updateChanges?: number;
	deleteSuccess?: boolean;
}) {
	const calls: Array<{ query: string; values: unknown[] }> = [];
	const database: D1DatabaseLike = {
		prepare(query: string): D1PreparedStatementLike {
			let values: unknown[] = [];
			const statement: D1PreparedStatementLike = {
				bind(...nextValues) {
					values = nextValues;
					calls.push({ query, values });
					return statement;
				},
				async run() {
					if (query.startsWith("INSERT")) {
						return { success: true, meta: { changes: options.insertChanges ?? 0 } };
					}
					if (query.startsWith("UPDATE")) {
						return { success: true, meta: { changes: options.updateChanges ?? 1 } };
					}
					return { success: options.deleteSuccess ?? true, meta: { changes: 1 } };
				},
				async first<T>() {
					return (options.row ?? null) as T | null;
				},
			};
			return statement;
		},
	};
	return { database, calls };
}

const claimInput = {
	scope: "subject-1:article-create:key-123456789012",
	requestHash: "hash-1",
	expiresAt: 2_000_000,
};

const parseResult = (input: unknown): TestResult => {
	if (
		typeof input !== "object" ||
		input === null ||
		typeof Reflect.get(input, "commitSha") !== "string"
	) {
		throw new TypeError("invalid result");
	}
	return { commitSha: Reflect.get(input, "commitSha") as string };
};

describe("D1 幂等存储", () => {
	it("使用 INSERT OR IGNORE 原子获得首次执行权", async () => {
		const { database, calls } = createDatabase({ insertChanges: 1 });
		const store = new D1IdempotencyStore(database, parseResult, () => 1_000_000);

		await expect(store.claim(claimInput)).resolves.toEqual({ state: "claimed" });
		expect(calls[0]?.query).toContain("INSERT OR IGNORE");
		expect(calls[0]?.values).toEqual([
			claimInput.scope,
			claimInput.requestHash,
			null,
			1_000_000,
			claimInput.expiresAt,
		]);
	});

	it("相同请求已完成时解析并回放存储结果", async () => {
		const { database } = createDatabase({
			row: {
				request_hash: "hash-1",
				status: "completed",
				response_json: JSON.stringify({ commitSha: "commit-1" }),
				base_head_sha: null,
				candidate_commit_sha: null,
				expires_at: 2_000_000,
			},
		});
		const store = new D1IdempotencyStore(database, parseResult, () => 1_000_000);

		await expect(store.claim(claimInput)).resolves.toEqual({
			state: "completed",
			result: { commitSha: "commit-1" },
		});
	});

	it("相同作用域但请求指纹不同返回冲突", async () => {
		const { database } = createDatabase({
			row: {
				request_hash: "other-hash",
				status: "processing",
				response_json: null,
				base_head_sha: null,
				candidate_commit_sha: null,
				expires_at: 2_000_000,
			},
		});
		const store = new D1IdempotencyStore(database, parseResult, () => 1_000_000);

		await expect(store.claim(claimInput)).resolves.toEqual({ state: "conflict" });
	});

	it("相同请求正在处理中返回 processing", async () => {
		const { database } = createDatabase({
			row: {
				request_hash: "hash-1",
				status: "processing",
				response_json: null,
				base_head_sha: null,
				candidate_commit_sha: null,
				expires_at: 2_000_000,
			},
		});
		const store = new D1IdempotencyStore(database, parseResult, () => 1_000_000);

		await expect(store.claim(claimInput)).resolves.toEqual({ state: "processing" });
	});

	it("过期或损坏记录失败关闭，不在非事务路径抢占", async () => {
		for (const row of [
			{
				request_hash: "hash-1",
				status: "processing",
				response_json: null,
				base_head_sha: null,
				candidate_commit_sha: null,
				expires_at: 900_000,
			},
			{
				request_hash: "hash-1",
				status: "completed",
				response_json: "not-json",
				base_head_sha: null,
				candidate_commit_sha: null,
				expires_at: 2_000_000,
			},
		]) {
			const { database } = createDatabase({ row });
			const store = new D1IdempotencyStore(database, parseResult, () => 1_000_000);
			await expect(store.claim(claimInput)).rejects.toMatchObject({
				status: 503,
				code: "IDEMPOTENCY_UNAVAILABLE",
			});
		}
	});

	it("unknown 记录返回基线和候选 Commit，不允许再次执行", async () => {
		const { database } = createDatabase({
			row: {
				request_hash: "hash-1",
				status: "unknown",
				response_json: null,
				base_head_sha: "a".repeat(40),
				candidate_commit_sha: "b".repeat(40),
				recovery_json: JSON.stringify({ kind: "article-update", storageSlug: "hello-world" }),
				expires_at: 2_000_000,
			},
		});
		const store = new D1IdempotencyStore(database, parseResult, () => 1_000_000);

		await expect(store.claim(claimInput)).resolves.toEqual({
			state: "unknown",
			baseHeadSha: "a".repeat(40),
			candidateCommitSha: "b".repeat(40),
			recovery: { kind: "article-update", storageSlug: "hello-world" },
		});
	});

	it("按顺序写入 unknown 基线和候选 Commit 检查点", async () => {
		const { database, calls } = createDatabase({ updateChanges: 1 });
		const store = new D1IdempotencyStore(database, parseResult);

		await store.markUnknown({
			scope: claimInput.scope,
			requestHash: claimInput.requestHash,
			baseHeadSha: "a".repeat(40),
			recovery: { kind: "article-update", storageSlug: "hello-world" },
		});
		await store.recordCandidateCommit({
			scope: claimInput.scope,
			requestHash: claimInput.requestHash,
			candidateCommitSha: "b".repeat(40),
		});

		const updates = calls.filter((call) => call.query.startsWith("UPDATE"));
		expect(updates[0]?.query).toContain("status = 'unknown'");
		expect(updates[1]?.query).toContain("candidate_commit_sha IS NULL");
	});

	it("完成操作仅更新匹配的 processing 或 unknown 记录", async () => {
		const { database, calls } = createDatabase({ updateChanges: 1 });
		const store = new D1IdempotencyStore(database, parseResult);

		await store.complete({
			scope: claimInput.scope,
			requestHash: claimInput.requestHash,
			result: { commitSha: "commit-1" },
		});

		const update = calls.find((call) => call.query.startsWith("UPDATE"));
		expect(update?.query).toContain("status IN ('processing', 'unknown')");
		expect(update?.values).toEqual([
			JSON.stringify({ commitSha: "commit-1" }),
			claimInput.scope,
			claimInput.requestHash,
		]);
	});

	it("释放操作只删除匹配的 processing 占位", async () => {
		const { database, calls } = createDatabase({ deleteSuccess: true });
		const store = new D1IdempotencyStore(database, parseResult);

		await store.release({ scope: claimInput.scope, requestHash: claimInput.requestHash });

		const deletion = calls.find((call) => call.query.startsWith("DELETE"));
		expect(deletion?.query).toContain("status = 'processing'");
		expect(deletion?.values).toEqual([claimInput.scope, claimInput.requestHash]);
	});

	it("D1 异常或更新零行时统一失败关闭", async () => {
		const { database } = createDatabase({ updateChanges: 0 });
		const store = new D1IdempotencyStore(database, parseResult);

		await expect(
			store.complete({
				scope: claimInput.scope,
				requestHash: claimInput.requestHash,
				result: { commitSha: "commit-1" },
			}),
		).rejects.toMatchObject({ status: 503, code: "IDEMPOTENCY_UNAVAILABLE" });
	});
});
