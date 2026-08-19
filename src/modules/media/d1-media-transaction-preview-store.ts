import { z } from "zod";
import { ApiError } from "../../core/http/errors";
import type { ArticlePathConfig } from "../../core/security/path-policy";
import type { D1Database } from "../../types/env";
import {
	createMediaTransactionCommitPlanHash,
	createMediaTransactionCommitRequestHash,
	type MediaTransactionCommitPlan,
	type MediaTransactionCommitResult,
	parseMediaTransactionCommitPlan,
	parseMediaTransactionCommitResult,
} from "./media-transaction-commit";
import {
	createMediaTransactionPreviewRequestHash,
	type MediaTransactionPreview,
	parseMediaTransactionPreview,
} from "./media-transaction-preview";

const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,179}$/;
const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;

const storedPreviewRowSchema = z
	.object({
		preview_id: z.string(),
		subject: z.string(),
		request_hash: z.string().regex(HASH),
		operation: z.enum(["rename", "move"]),
		storage_slug: z.string(),
		base_commit_sha: z.string(),
		expected_article_sha: z.string(),
		expected_blob_sha: z.string(),
		destination_storage_slug: z.string().nullable(),
		destination_expected_article_sha: z.string().nullable(),
		preview_json: z.string(),
		status: z.enum(["ready", "committing", "unknown", "consumed", "expired"]),
		commit_idempotency_key_hash: z.string().regex(HASH).nullable(),
		commit_request_hash: z.string().regex(HASH).nullable(),
		commit_plan_hash: z.string().regex(HASH).nullable(),
		commit_plan_json: z.string().nullable(),
		candidate_commit_sha: z.string().regex(GIT_OBJECT_SHA).nullable(),
		result_json: z.string().nullable(),
		claim_token: z.string().regex(TOKEN).nullable(),
		claimed_at: z.number().int().nonnegative().nullable(),
		claim_expires_at: z.number().int().nonnegative().nullable(),
		created_at: z.number().int().nonnegative(),
		expires_at: z.number().int().nonnegative(),
		updated_at: z.number().int().nonnegative(),
		consumed_at: z.number().int().nonnegative().nullable(),
	})
	.strict();

type StoredPreviewRow = z.infer<typeof storedPreviewRowSchema>;

export interface MediaTransactionCommitIdentity {
	previewId: string;
	subject: string;
	idempotencyKeyHash: string;
	requestHash: string;
}

export interface MediaTransactionCommitAttempt extends MediaTransactionCommitIdentity {
	claimToken: string;
}

export type MediaTransactionCommitReadResult =
	| { state: "ready"; preview: MediaTransactionPreview }
	| {
			state: "committing";
			preview: MediaTransactionPreview;
			claimedAt: number;
			claimExpiresAt: number;
	  }
	| {
			state: "unknown";
			preview: MediaTransactionPreview;
			plan: MediaTransactionCommitPlan;
			planHash: string;
			candidateCommitSha?: string;
	  }
	| {
			state: "consumed";
			preview: MediaTransactionPreview;
			plan: MediaTransactionCommitPlan;
			planHash: string;
			candidateCommitSha: string;
			result: MediaTransactionCommitResult;
	  }
	| { state: "expired"; preview: MediaTransactionPreview }
	| { state: "not-found" }
	| { state: "conflict" };

export type MediaTransactionCommitClaimResult =
	| {
			state: "claimed";
			preview: MediaTransactionPreview;
			claimToken: string;
			claimExpiresAt: number;
	  }
	| MediaTransactionCommitReadResult;

export interface MediaTransactionPreviewStore {
	createOrReuse(input: {
		subject: string;
		requestHash: string;
		preview: MediaTransactionPreview;
	}): Promise<{ preview: MediaTransactionPreview; reused: boolean }>;
}

export interface MediaTransactionPreviewCommitStore extends MediaTransactionPreviewStore {
	claimCommit(
		input: MediaTransactionCommitAttempt & { leaseMs: number },
	): Promise<MediaTransactionCommitClaimResult>;
	armUnknown(input: MediaTransactionCommitAttempt & { plan: MediaTransactionCommitPlan }): Promise<{
		plan: MediaTransactionCommitPlan;
		planHash: string;
	}>;
	recordCandidateCommit(
		input: MediaTransactionCommitAttempt & { planHash: string; candidateCommitSha: string },
	): Promise<void>;
	releaseBeforeCandidate(
		input: MediaTransactionCommitAttempt & { planHash?: string },
	): Promise<void>;
	consume(
		input: MediaTransactionCommitAttempt & {
			planHash: string;
			candidateCommitSha: string;
			result: MediaTransactionCommitResult;
		},
	): Promise<void>;
	completeRecovered(
		input: MediaTransactionCommitIdentity & {
			planHash: string;
			candidateCommitSha: string;
			result: MediaTransactionCommitResult;
		},
	): Promise<void>;
	getForCommit(input: MediaTransactionCommitIdentity): Promise<MediaTransactionCommitReadResult>;
}

const SELECT_COLUMNS =
	"preview_id, subject, request_hash, operation, storage_slug, base_commit_sha, expected_article_sha, expected_blob_sha, destination_storage_slug, destination_expected_article_sha, preview_json, status, commit_idempotency_key_hash, commit_request_hash, commit_plan_hash, commit_plan_json, candidate_commit_sha, result_json, claim_token, claimed_at, claim_expires_at, created_at, expires_at, updated_at, consumed_at";

function unavailable(): ApiError {
	return new ApiError(503, "MEDIA_PREVIEW_UNAVAILABLE", "资源影响预览服务暂时不可用。");
}

function assertHash(value: string): void {
	if (!HASH.test(value)) throw unavailable();
}

function assertToken(value: string): void {
	if (!TOKEN.test(value)) throw unavailable();
}

/** Preview 与 Commit 共用一行 CAS 状态机；所有 D1、JSON、哈希或冗余字段异常均失败关闭。 */
export class D1MediaTransactionPreviewStore implements MediaTransactionPreviewCommitStore {
	readonly #database: D1Database;
	readonly #now: () => number;
	readonly #pathConfig: ArticlePathConfig | undefined;

	constructor(database: D1Database, now: () => number = Date.now, pathConfig?: ArticlePathConfig) {
		this.#database = database;
		this.#now = now;
		this.#pathConfig = pathConfig;
	}

	async createOrReuse(input: {
		subject: string;
		requestHash: string;
		preview: MediaTransactionPreview;
	}): Promise<{ preview: MediaTransactionPreview; reused: boolean }> {
		try {
			assertHash(input.requestHash);
			const preview = parseMediaTransactionPreview(input.preview, this.#pathConfig);
			if ((await this.#createPreviewRequestHash(preview)) !== input.requestHash)
				throw unavailable();
			const createdAt = Date.parse(preview.createdAt);
			const expiresAt = Date.parse(preview.expiresAt);
			const locks =
				preview.operation === "rename"
					? {
							storageSlug: preview.storageSlug,
							expectedArticleSha: preview.expectedArticleSha,
							expectedBlobSha: preview.expectedBlobSha,
							destinationStorageSlug: null,
							destinationExpectedArticleSha: null,
						}
					: {
							storageSlug: preview.source.storageSlug,
							expectedArticleSha: preview.source.article.expectedSha,
							expectedBlobSha: preview.source.resource.blobSha,
							destinationStorageSlug: preview.destination.storageSlug,
							destinationExpectedArticleSha: preview.destination.article.expectedSha,
						};
			const inserted = await this.#database
				.prepare(
					"INSERT OR IGNORE INTO media_transaction_previews (preview_id, subject, request_hash, operation, storage_slug, base_commit_sha, expected_article_sha, expected_blob_sha, destination_storage_slug, destination_expected_article_sha, preview_json, status, created_at, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)",
				)
				.bind(
					preview.previewId,
					input.subject,
					input.requestHash,
					preview.operation,
					locks.storageSlug,
					preview.baseCommitSha,
					locks.expectedArticleSha,
					locks.expectedBlobSha,
					locks.destinationStorageSlug,
					locks.destinationExpectedArticleSha,
					JSON.stringify(preview),
					createdAt,
					expiresAt,
					createdAt,
				)
				.run();
			this.#assertChanges(inserted, [0, 1]);
			if (inserted.meta?.changes === 1) return { preview, reused: false };

			const row = await this.#readRowBySubjectAndPreview(
				input.subject,
				undefined,
				input.requestHash,
			);
			if (row === null || row.status !== "ready" || row.expires_at <= this.#now())
				throw unavailable();
			const storedPreview = await this.#parseAndValidateRow(row);
			const requestedPreview = {
				...preview,
				previewId: storedPreview.previewId,
				createdAt: storedPreview.createdAt,
				expiresAt: storedPreview.expiresAt,
			};
			if (JSON.stringify(storedPreview) !== JSON.stringify(requestedPreview)) throw unavailable();
			return { preview: storedPreview, reused: true };
		} catch (error) {
			this.#rethrow(error);
		}
	}

	async claimCommit(
		input: MediaTransactionCommitAttempt & { leaseMs: number },
	): Promise<MediaTransactionCommitClaimResult> {
		try {
			this.#assertIdentity(input);
			assertToken(input.claimToken);
			if (!Number.isInteger(input.leaseMs) || input.leaseMs <= 0) throw unavailable();
			const existingRow = await this.#readRowBySubjectAndPreview(input.subject, input.previewId);
			if (existingRow === null) return { state: "not-found" };
			const existingPreview = await this.#parseAndValidateRow(existingRow);
			await this.#assertCommitRequestHash(existingPreview, input.requestHash);
			const now = this.#now();
			const claimExpiresAt = now + input.leaseMs;
			if (!Number.isSafeInteger(claimExpiresAt)) throw unavailable();
			const updated = await this.#database
				.prepare(
					"UPDATE media_transaction_previews SET status = 'committing', commit_idempotency_key_hash = COALESCE(commit_idempotency_key_hash, ?), commit_request_hash = COALESCE(commit_request_hash, ?), claim_token = ?, claimed_at = ?, claim_expires_at = ?, updated_at = ? WHERE preview_id = ? AND subject = ? AND expires_at > ? AND ((status = 'ready' AND commit_plan_hash IS NULL AND candidate_commit_sha IS NULL) OR (status = 'committing' AND claim_expires_at <= ?)) AND (commit_idempotency_key_hash IS NULL OR commit_idempotency_key_hash = ?) AND (commit_request_hash IS NULL OR commit_request_hash = ?)",
				)
				.bind(
					input.idempotencyKeyHash,
					input.requestHash,
					input.claimToken,
					now,
					claimExpiresAt,
					now,
					input.previewId,
					input.subject,
					now,
					now,
					input.idempotencyKeyHash,
					input.requestHash,
				)
				.run();
			this.#assertChanges(updated, [0, 1]);
			if (updated.meta?.changes === 0) {
				return this.getForCommit(input);
			}
			const row = await this.#readRowBySubjectAndPreview(input.subject, input.previewId);
			if (
				row === null ||
				row.status !== "committing" ||
				row.claim_token !== input.claimToken ||
				row.claim_expires_at !== claimExpiresAt
			) {
				throw unavailable();
			}
			const preview = await this.#parseAndValidateRow(row);
			await this.#assertCommitRequestHash(preview, input.requestHash);
			return { state: "claimed", preview, claimToken: input.claimToken, claimExpiresAt };
		} catch (error) {
			this.#rethrow(error);
		}
	}

	async armUnknown(
		input: MediaTransactionCommitAttempt & { plan: MediaTransactionCommitPlan },
	): Promise<{ plan: MediaTransactionCommitPlan; planHash: string }> {
		try {
			this.#assertIdentity(input);
			assertToken(input.claimToken);
			const row = await this.#requireAttemptRow(input, "committing");
			const preview = await this.#parseAndValidateRow(row);
			const plan = parseMediaTransactionCommitPlan(input.plan, preview, this.#pathConfig);
			const planHash = await createMediaTransactionCommitPlanHash(plan, preview, this.#pathConfig);
			const now = this.#now();
			const updated = await this.#database
				.prepare(
					"UPDATE media_transaction_previews SET status = 'unknown', commit_plan_hash = ?, commit_plan_json = ?, updated_at = ? WHERE preview_id = ? AND subject = ? AND status = 'committing' AND commit_idempotency_key_hash = ? AND commit_request_hash = ? AND claim_token = ? AND claim_expires_at > ? AND commit_plan_hash IS NULL AND commit_plan_json IS NULL AND candidate_commit_sha IS NULL",
				)
				.bind(
					planHash,
					JSON.stringify(plan),
					now,
					input.previewId,
					input.subject,
					input.idempotencyKeyHash,
					input.requestHash,
					input.claimToken,
					now,
				)
				.run();
			this.#assertChanges(updated, [1]);
			return { plan, planHash };
		} catch (error) {
			this.#rethrow(error);
		}
	}

	async recordCandidateCommit(
		input: MediaTransactionCommitAttempt & { planHash: string; candidateCommitSha: string },
	): Promise<void> {
		try {
			this.#assertIdentity(input);
			assertToken(input.claimToken);
			assertHash(input.planHash);
			if (!GIT_OBJECT_SHA.test(input.candidateCommitSha)) throw unavailable();
			const updated = await this.#database
				.prepare(
					"UPDATE media_transaction_previews SET candidate_commit_sha = COALESCE(candidate_commit_sha, ?), updated_at = ? WHERE preview_id = ? AND subject = ? AND status = 'unknown' AND commit_idempotency_key_hash = ? AND commit_request_hash = ? AND commit_plan_hash = ? AND claim_token = ? AND (candidate_commit_sha IS NULL OR candidate_commit_sha = ?)",
				)
				.bind(
					input.candidateCommitSha,
					this.#now(),
					input.previewId,
					input.subject,
					input.idempotencyKeyHash,
					input.requestHash,
					input.planHash,
					input.claimToken,
					input.candidateCommitSha,
				)
				.run();
			this.#assertChanges(updated, [1]);
		} catch (error) {
			this.#rethrow(error);
		}
	}

	async releaseBeforeCandidate(
		input: MediaTransactionCommitAttempt & { planHash?: string },
	): Promise<void> {
		try {
			this.#assertIdentity(input);
			assertToken(input.claimToken);
			if (input.planHash !== undefined) assertHash(input.planHash);
			const row = await this.#requireAttemptRow(
				input,
				input.planHash === undefined ? "committing" : "unknown",
			);
			const now = this.#now();
			const nextStatus = row.expires_at > now ? "ready" : "expired";
			const updated = await this.#database
				.prepare(
					"UPDATE media_transaction_previews SET status = ?, commit_plan_hash = NULL, commit_plan_json = NULL, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL, updated_at = ? WHERE preview_id = ? AND subject = ? AND status IN ('committing', 'unknown') AND commit_idempotency_key_hash = ? AND commit_request_hash = ? AND claim_token = ? AND candidate_commit_sha IS NULL AND (? IS NULL OR commit_plan_hash = ?)",
				)
				.bind(
					nextStatus,
					now,
					input.previewId,
					input.subject,
					input.idempotencyKeyHash,
					input.requestHash,
					input.claimToken,
					input.planHash ?? null,
					input.planHash ?? null,
				)
				.run();
			this.#assertChanges(updated, [1]);
		} catch (error) {
			this.#rethrow(error);
		}
	}

	async consume(
		input: MediaTransactionCommitAttempt & {
			planHash: string;
			candidateCommitSha: string;
			result: MediaTransactionCommitResult;
		},
	): Promise<void> {
		return this.#complete(input, true);
	}

	async completeRecovered(
		input: MediaTransactionCommitIdentity & {
			planHash: string;
			candidateCommitSha: string;
			result: MediaTransactionCommitResult;
		},
	): Promise<void> {
		return this.#complete(input, false);
	}

	async getForCommit(
		input: MediaTransactionCommitIdentity,
	): Promise<MediaTransactionCommitReadResult> {
		try {
			this.#assertIdentity(input);
			const rawRow = await this.#database
				.prepare(`SELECT ${SELECT_COLUMNS} FROM media_transaction_previews WHERE preview_id = ?`)
				.bind(input.previewId)
				.first();
			if (rawRow === null) return { state: "not-found" };
			const parsed = storedPreviewRowSchema.safeParse(rawRow);
			if (!parsed.success) throw unavailable();
			const row = parsed.data;
			const preview = await this.#parseAndValidateRow(row);
			if (row.subject !== input.subject) return { state: "not-found" };
			if (
				(row.commit_idempotency_key_hash !== null &&
					row.commit_idempotency_key_hash !== input.idempotencyKeyHash) ||
				(row.commit_request_hash !== null && row.commit_request_hash !== input.requestHash)
			) {
				return { state: "conflict" };
			}
			await this.#assertCommitRequestHash(preview, input.requestHash);
			return await this.#classify(row, preview);
		} catch (error) {
			this.#rethrow(error);
		}
	}

	async #complete(
		input: MediaTransactionCommitIdentity & {
			claimToken?: string;
			planHash: string;
			candidateCommitSha: string;
			result: MediaTransactionCommitResult;
		},
		requireAttempt: boolean,
	): Promise<void> {
		try {
			this.#assertIdentity(input);
			assertHash(input.planHash);
			if (!GIT_OBJECT_SHA.test(input.candidateCommitSha)) throw unavailable();
			if (requireAttempt) {
				if (input.claimToken === undefined) throw unavailable();
				assertToken(input.claimToken);
			}
			const row = await this.#readRowBySubjectAndPreview(input.subject, input.previewId);
			if (
				row === null ||
				row.status !== "unknown" ||
				row.commit_idempotency_key_hash !== input.idempotencyKeyHash ||
				row.commit_request_hash !== input.requestHash ||
				row.commit_plan_hash !== input.planHash ||
				row.candidate_commit_sha !== input.candidateCommitSha ||
				(requireAttempt && row.claim_token !== input.claimToken)
			) {
				throw unavailable();
			}
			const preview = await this.#parseAndValidateRow(row);
			const plan = await this.#parsePlan(row, preview);
			const result = parseMediaTransactionCommitResult(
				input.result,
				plan,
				preview,
				input.candidateCommitSha,
				this.#pathConfig,
			);
			const now = this.#now();
			const tokenCondition = requireAttempt ? " AND claim_token = ?" : "";
			const values: unknown[] = [
				JSON.stringify(result),
				now,
				now,
				input.previewId,
				input.subject,
				input.idempotencyKeyHash,
				input.requestHash,
				input.planHash,
				input.candidateCommitSha,
			];
			if (requireAttempt) values.push(input.claimToken);
			const updated = await this.#database
				.prepare(
					`UPDATE media_transaction_previews SET status = 'consumed', result_json = ?, claim_token = NULL, claimed_at = NULL, claim_expires_at = NULL, consumed_at = ?, updated_at = ? WHERE preview_id = ? AND subject = ? AND status = 'unknown' AND commit_idempotency_key_hash = ? AND commit_request_hash = ? AND commit_plan_hash = ? AND candidate_commit_sha = ?${tokenCondition}`,
				)
				.bind(...values)
				.run();
			this.#assertChanges(updated, [1]);
		} catch (error) {
			this.#rethrow(error);
		}
	}

	async #classify(
		row: StoredPreviewRow,
		preview: MediaTransactionPreview,
	): Promise<MediaTransactionCommitReadResult> {
		if ((row.status === "ready" || row.status === "expired") && row.expires_at <= this.#now()) {
			return { state: "expired", preview };
		}
		if (row.status === "ready") return { state: "ready", preview };
		if (row.status === "expired") return { state: "expired", preview };
		if (row.status === "committing") {
			if (row.claimed_at === null || row.claim_expires_at === null) throw unavailable();
			return {
				state: "committing",
				preview,
				claimedAt: row.claimed_at,
				claimExpiresAt: row.claim_expires_at,
			};
		}
		const plan = await this.#parsePlan(row, preview);
		if (row.commit_plan_hash === null) throw unavailable();
		if (row.status === "unknown") {
			return {
				state: "unknown",
				preview,
				plan,
				planHash: row.commit_plan_hash,
				...(row.candidate_commit_sha === null
					? {}
					: { candidateCommitSha: row.candidate_commit_sha }),
			};
		}
		if (row.candidate_commit_sha === null || row.result_json === null) throw unavailable();
		const result = (() => {
			try {
				return parseMediaTransactionCommitResult(
					JSON.parse(row.result_json),
					plan,
					preview,
					row.candidate_commit_sha,
					this.#pathConfig,
				);
			} catch {
				throw unavailable();
			}
		})();
		return {
			state: "consumed",
			preview,
			plan,
			planHash: row.commit_plan_hash,
			candidateCommitSha: row.candidate_commit_sha,
			result,
		};
	}

	async #parsePlan(
		row: StoredPreviewRow,
		preview: MediaTransactionPreview,
	): Promise<MediaTransactionCommitPlan> {
		if (row.commit_plan_hash === null || row.commit_plan_json === null) throw unavailable();
		let plan: MediaTransactionCommitPlan;
		try {
			plan = parseMediaTransactionCommitPlan(
				JSON.parse(row.commit_plan_json),
				preview,
				this.#pathConfig,
			);
		} catch {
			throw unavailable();
		}
		if (
			(await createMediaTransactionCommitPlanHash(plan, preview, this.#pathConfig)) !==
			row.commit_plan_hash
		) {
			throw unavailable();
		}
		return plan;
	}

	async #parseAndValidateRow(row: StoredPreviewRow): Promise<MediaTransactionPreview> {
		let preview: MediaTransactionPreview;
		try {
			preview = parseMediaTransactionPreview(JSON.parse(row.preview_json), this.#pathConfig);
		} catch {
			throw unavailable();
		}
		const locksMatch =
			preview.operation === "rename"
				? preview.storageSlug === row.storage_slug &&
					preview.expectedArticleSha === row.expected_article_sha &&
					preview.expectedBlobSha === row.expected_blob_sha &&
					row.destination_storage_slug === null &&
					row.destination_expected_article_sha === null
				: preview.source.storageSlug === row.storage_slug &&
					preview.source.article.expectedSha === row.expected_article_sha &&
					preview.source.resource.blobSha === row.expected_blob_sha &&
					preview.destination.storageSlug === row.destination_storage_slug &&
					preview.destination.article.expectedSha === row.destination_expected_article_sha;
		if (
			preview.previewId !== row.preview_id ||
			preview.operation !== row.operation ||
			!locksMatch ||
			preview.baseCommitSha !== row.base_commit_sha ||
			Date.parse(preview.createdAt) !== row.created_at ||
			Date.parse(preview.expiresAt) !== row.expires_at ||
			row.updated_at < row.created_at ||
			(await this.#createPreviewRequestHash(preview)) !== row.request_hash
		) {
			throw unavailable();
		}
		this.#assertRowState(row);
		return preview;
	}

	#assertRowState(row: StoredPreviewRow): void {
		const hasIdentity =
			row.commit_idempotency_key_hash !== null && row.commit_request_hash !== null;
		if (row.status === "ready") {
			if (
				row.commit_plan_hash !== null ||
				row.commit_plan_json !== null ||
				row.candidate_commit_sha !== null ||
				row.result_json !== null ||
				row.claim_token !== null ||
				row.claimed_at !== null ||
				row.claim_expires_at !== null ||
				row.consumed_at !== null
			) {
				throw unavailable();
			}
			return;
		}
		if (row.status === "expired") {
			if (
				row.commit_plan_hash !== null ||
				row.commit_plan_json !== null ||
				row.candidate_commit_sha !== null ||
				row.result_json !== null ||
				row.claim_token !== null ||
				row.claimed_at !== null ||
				row.claim_expires_at !== null ||
				row.consumed_at !== null
			) {
				throw unavailable();
			}
			return;
		}
		if (!hasIdentity) throw unavailable();
		if (row.status === "committing") {
			if (
				row.commit_plan_hash !== null ||
				row.commit_plan_json !== null ||
				row.candidate_commit_sha !== null ||
				row.result_json !== null ||
				row.claim_token === null ||
				row.claimed_at === null ||
				row.claim_expires_at === null ||
				row.consumed_at !== null
			) {
				throw unavailable();
			}
			return;
		}
		if (
			row.commit_plan_hash === null ||
			row.commit_plan_json === null ||
			(row.status === "unknown" &&
				(row.result_json !== null ||
					row.claim_token === null ||
					row.claimed_at === null ||
					row.claim_expires_at === null ||
					row.consumed_at !== null)) ||
			(row.status === "consumed" &&
				(row.candidate_commit_sha === null ||
					row.result_json === null ||
					row.claim_token !== null ||
					row.claimed_at !== null ||
					row.claim_expires_at !== null ||
					row.consumed_at === null))
		) {
			throw unavailable();
		}
	}

	async #requireAttemptRow(
		input: MediaTransactionCommitAttempt,
		status: "committing" | "unknown",
	): Promise<StoredPreviewRow> {
		const row = await this.#readRowBySubjectAndPreview(input.subject, input.previewId);
		if (
			row === null ||
			row.status !== status ||
			row.commit_idempotency_key_hash !== input.idempotencyKeyHash ||
			row.commit_request_hash !== input.requestHash ||
			row.claim_token !== input.claimToken
		) {
			throw unavailable();
		}
		return row;
	}

	async #readRowBySubjectAndPreview(
		subject: string,
		previewId?: string,
		requestHash?: string,
	): Promise<StoredPreviewRow | null> {
		const byPreview = previewId !== undefined;
		const rawRow = await this.#database
			.prepare(
				`SELECT ${SELECT_COLUMNS} FROM media_transaction_previews WHERE subject = ? AND ${byPreview ? "preview_id" : "request_hash"} = ?`,
			)
			.bind(subject, byPreview ? previewId : requestHash)
			.first();
		if (rawRow === null) return null;
		const parsed = storedPreviewRowSchema.safeParse(rawRow);
		if (!parsed.success) throw unavailable();
		return parsed.data;
	}

	async #createPreviewRequestHash(preview: MediaTransactionPreview): Promise<string> {
		return createMediaTransactionPreviewRequestHash(
			preview.operation === "rename"
				? {
						version: 1,
						operation: "rename",
						storageSlug: preview.storageSlug,
						sourceFilename: preview.source.filename,
						destinationFilename: preview.destination.filename,
						expectedHeadSha: preview.baseCommitSha,
						expectedArticleSha: preview.expectedArticleSha,
						expectedBlobSha: preview.expectedBlobSha,
					}
				: {
						version: 1,
						operation: "move",
						expectedHeadSha: preview.baseCommitSha,
						source: {
							storageSlug: preview.source.storageSlug,
							filename: preview.source.resource.filename,
							expectedArticleSha: preview.source.article.expectedSha,
							expectedBlobSha: preview.source.resource.blobSha,
						},
						destination: {
							storageSlug: preview.destination.storageSlug,
							filename: preview.destination.resource.filename,
							expectedArticleSha: preview.destination.article.expectedSha,
						},
					},
		);
	}

	async #assertCommitRequestHash(
		preview: MediaTransactionPreview,
		requestHash: string,
	): Promise<void> {
		const expected = await createMediaTransactionCommitRequestHash({
			previewId: preview.previewId,
			confirmation: preview.confirmation,
		});
		if (expected !== requestHash) throw unavailable();
	}

	#assertIdentity(input: MediaTransactionCommitIdentity): void {
		if (!TOKEN.test(input.previewId) || input.subject.length === 0) throw unavailable();
		assertHash(input.idempotencyKeyHash);
		assertHash(input.requestHash);
	}

	#assertChanges(
		result: { success: boolean; meta?: { changes?: number } },
		allowed: readonly number[],
	): void {
		const changes = result.meta?.changes;
		if (!result.success || changes === undefined || !allowed.includes(changes)) throw unavailable();
	}

	#rethrow(error: unknown): never {
		if (error instanceof ApiError) throw error;
		throw unavailable();
	}
}
