import { z } from "zod";
import { ApiError } from "../http/errors";
import type {
	IdempotencyClaimResult,
	IdempotencyRecoveryContext,
	IdempotencyStatus,
	IdempotencyStore,
} from "./types";

const recoverySchema = z
	.object({
		kind: z.enum(["article-create", "article-update", "article-delete"]),
		storageSlug: z.string().min(1).max(120),
	})
	.strict();

const storedRowSchema = z.object({
	request_hash: z.string().min(1),
	status: z.enum(["processing", "unknown", "completed"]),
	response_json: z.string().nullable(),
	base_head_sha: z.string().nullable(),
	candidate_commit_sha: z.string().nullable(),
	recovery_json: z.string().nullable().optional(),
	expires_at: z.number().int().nonnegative(),
});

export interface D1PreparedStatementLike {
	bind(...values: unknown[]): D1PreparedStatementLike;
	run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
	first<T = unknown>(): Promise<T | null>;
}

export interface D1DatabaseLike {
	prepare(query: string): D1PreparedStatementLike;
}

function unavailable(): ApiError {
	return new ApiError(503, "IDEMPOTENCY_UNAVAILABLE", "重复提交保护服务暂时不可用。");
}

/**
 * D1 幂等存储。claim 先用主键执行 INSERT OR IGNORE，依赖 SQLite 唯一约束原子决定
 * 唯一所有者；失败方随后读取已有记录，因此不会出现“先查询、再同时插入”的竞态。
 */
export class D1IdempotencyStore<TResult> implements IdempotencyStore<TResult> {
	readonly #database: D1DatabaseLike;
	readonly #parseResult: (input: unknown) => TResult;
	readonly #now: () => number;

	constructor(
		database: D1DatabaseLike,
		parseResult: (input: unknown) => TResult,
		now: () => number = () => Date.now(),
	) {
		this.#database = database;
		this.#parseResult = parseResult;
		this.#now = now;
	}

	async claim(record: {
		scope: string;
		requestHash: string;
		expiresAt: number;
		recovery?: IdempotencyRecoveryContext;
	}): Promise<IdempotencyClaimResult<TResult>> {
		try {
			const inserted = await this.#database
				.prepare(
					"INSERT OR IGNORE INTO idempotency_records (scope, request_hash, status, response_json, recovery_json, created_at, expires_at) VALUES (?, ?, 'processing', NULL, ?, ?, ?)",
				)
				.bind(
					record.scope,
					record.requestHash,
					record.recovery ? JSON.stringify(record.recovery) : null,
					this.#now(),
					record.expiresAt,
				)
				.run();
			if (!inserted.success) {
				throw unavailable();
			}
			if ((inserted.meta?.changes ?? 0) === 1) {
				return { state: "claimed" };
			}

			const rawRow = await this.#database
				.prepare(
					"SELECT request_hash, status, response_json, base_head_sha, candidate_commit_sha, recovery_json, expires_at FROM idempotency_records WHERE scope = ?",
				)
				.bind(record.scope)
				.first();
			const row = storedRowSchema.safeParse(rawRow);
			if (!row.success) {
				throw unavailable();
			}
			if (row.data.request_hash !== record.requestHash) {
				return { state: "conflict" };
			}
			if (row.data.expires_at <= this.#now()) {
				// 过期记录由定时清理或后续迁移回收；本次不在非事务路径中抢占，避免双重执行。
				throw unavailable();
			}
			if (row.data.status === "processing") {
				return { state: "processing" };
			}
			const recovery = this.#parseRecovery(row.data.recovery_json);
			if (row.data.status === "unknown") {
				return {
					state: "unknown",
					...(row.data.base_head_sha === null ? {} : { baseHeadSha: row.data.base_head_sha }),
					...(row.data.candidate_commit_sha === null
						? {}
						: { candidateCommitSha: row.data.candidate_commit_sha }),
					...(recovery === undefined ? {} : { recovery }),
				};
			}
			if (row.data.response_json === null) {
				throw unavailable();
			}

			return {
				state: "completed",
				result: this.#parseResult(JSON.parse(row.data.response_json)),
			};
		} catch (error) {
			if (error instanceof ApiError) {
				throw error;
			}
			throw unavailable();
		}
	}

	async getStatus(record: {
		scope: string;
		requestHash: string;
	}): Promise<IdempotencyStatus<TResult> | undefined> {
		return this.#readStatus(record.scope, record.requestHash);
	}

	async getStatusByScope(scope: string): Promise<IdempotencyStatus<TResult> | undefined> {
		return this.#readStatus(scope);
	}

	async #readStatus(
		scope: string,
		requestHash?: string,
	): Promise<IdempotencyStatus<TResult> | undefined> {
		try {
			const rawRow = await this.#database
				.prepare(
					"SELECT request_hash, status, response_json, base_head_sha, candidate_commit_sha, recovery_json, expires_at FROM idempotency_records WHERE scope = ?",
				)
				.bind(scope)
				.first();
			if (rawRow === null) return undefined;
			const parsed = storedRowSchema.safeParse(rawRow);
			if (
				!parsed.success ||
				(requestHash !== undefined && parsed.data.request_hash !== requestHash)
			) {
				return undefined;
			}
			const recovery = this.#parseRecovery(parsed.data.recovery_json);
			const result =
				parsed.data.response_json === null
					? undefined
					: this.#parseResult(JSON.parse(parsed.data.response_json));
			return {
				state: parsed.data.status,
				requestHash: parsed.data.request_hash,
				...(parsed.data.base_head_sha === null ? {} : { baseHeadSha: parsed.data.base_head_sha }),
				...(parsed.data.candidate_commit_sha === null
					? {}
					: { candidateCommitSha: parsed.data.candidate_commit_sha }),
				...(recovery === undefined ? {} : { recovery }),
				...(result === undefined ? {} : { result }),
				expiresAt: parsed.data.expires_at,
			};
		} catch (error) {
			if (error instanceof ApiError) throw error;
			throw unavailable();
		}
	}

	async markUnknown(record: {
		scope: string;
		requestHash: string;
		baseHeadSha: string;
		recovery?: IdempotencyRecoveryContext;
	}): Promise<void> {
		await this.#updateExactlyOne(
			"UPDATE idempotency_records SET status = 'unknown', base_head_sha = ?, recovery_json = COALESCE(recovery_json, ?) WHERE scope = ? AND request_hash = ? AND status = 'processing'",
			[
				record.baseHeadSha,
				record.recovery ? JSON.stringify(record.recovery) : null,
				record.scope,
				record.requestHash,
			],
		);
	}

	async recordCandidateCommit(record: {
		scope: string;
		requestHash: string;
		candidateCommitSha: string;
	}): Promise<void> {
		await this.#updateExactlyOne(
			"UPDATE idempotency_records SET candidate_commit_sha = ? WHERE scope = ? AND request_hash = ? AND status = 'unknown' AND base_head_sha IS NOT NULL AND candidate_commit_sha IS NULL",
			[record.candidateCommitSha, record.scope, record.requestHash],
		);
	}

	async complete(record: { scope: string; requestHash: string; result: TResult }): Promise<void> {
		await this.#complete(record, "status IN ('processing', 'unknown')");
	}

	async completeUnknown(record: {
		scope: string;
		requestHash: string;
		result: TResult;
	}): Promise<void> {
		await this.#complete(record, "status = 'unknown'");
	}

	#parseRecovery(input: string | null | undefined): IdempotencyRecoveryContext | undefined {
		if (input === null || input === undefined) return undefined;
		const parsed = recoverySchema.safeParse(JSON.parse(input));
		if (!parsed.success) throw unavailable();
		return parsed.data;
	}

	async #complete(
		record: { scope: string; requestHash: string; result: TResult },
		statusCondition: string,
	): Promise<void> {
		try {
			const updated = await this.#database
				.prepare(
					`UPDATE idempotency_records SET status = 'completed', response_json = ? WHERE scope = ? AND request_hash = ? AND ${statusCondition}`,
				)
				.bind(JSON.stringify(record.result), record.scope, record.requestHash)
				.run();
			if (!updated.success || (updated.meta?.changes ?? 0) !== 1) {
				throw unavailable();
			}
		} catch (error) {
			if (error instanceof ApiError) {
				throw error;
			}
			throw unavailable();
		}
	}

	async #updateExactlyOne(query: string, values: unknown[]): Promise<void> {
		try {
			const updated = await this.#database
				.prepare(query)
				.bind(...values)
				.run();
			if (!updated.success || (updated.meta?.changes ?? 0) !== 1) throw unavailable();
		} catch (error) {
			if (error instanceof ApiError) throw error;
			throw unavailable();
		}
	}

	async release(record: { scope: string; requestHash: string }): Promise<void> {
		try {
			const deleted = await this.#database
				.prepare(
					"DELETE FROM idempotency_records WHERE scope = ? AND request_hash = ? AND status = 'processing'",
				)
				.bind(record.scope, record.requestHash)
				.run();
			if (!deleted.success) {
				throw unavailable();
			}
		} catch (error) {
			if (error instanceof ApiError) {
				throw error;
			}
			throw unavailable();
		}
	}
}
