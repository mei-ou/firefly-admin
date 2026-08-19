import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	D1MediaTransactionPreviewStore,
	type MediaTransactionCommitAttempt,
} from "../../src/modules/media/d1-media-transaction-preview-store";
import {
	createMediaTransactionCommitIdempotencyKeyHash,
	createMediaTransactionCommitPlanHash,
	createMediaTransactionCommitRequestHash,
	type MediaTransactionCommitResult,
	type MoveMediaTransactionCommitPlan,
	type MoveMediaTransactionCommitResult,
	type RenameMediaTransactionCommitPlan,
} from "../../src/modules/media/media-transaction-commit";
import {
	createMediaTransactionPreviewRequestHash,
	type MoveMediaTransactionPreview,
	type RenameMediaTransactionPreview,
} from "../../src/modules/media/media-transaction-preview";
import type { D1Database, D1PreparedStatement } from "../../src/types/env";

const HEAD_SHA = "a".repeat(40);
const ARTICLE_SHA = "b".repeat(40);
const DESTINATION_ARTICLE_SHA = "e".repeat(40);
const BLOB_SHA = "c".repeat(40);
const CANDIDATE_SHA = "d".repeat(40);
const CREATED_AT = Date.parse("2026-08-17T01:00:00.000Z");
const EXPIRES_AT = Date.parse("2026-08-17T01:10:00.000Z");
const CLAIM_TOKEN = "claim_1234567890abcdef";
const OTHER_TOKEN = "claim_abcdef1234567890";

type Row = Record<string, unknown>;

function createPreview(): RenameMediaTransactionPreview {
	return {
		version: 1,
		previewId: "preview_1234567890abcdef",
		operation: "rename",
		storageSlug: "hello-world",
		createdAt: new Date(CREATED_AT).toISOString(),
		expiresAt: new Date(EXPIRES_AT).toISOString(),
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
		previewId: createPreview().previewId,
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
		previewId: createPreview().previewId,
		commitSha: CANDIDATE_SHA,
		url: `https://github.com/owner/repo/commit/${CANDIDATE_SHA}`,
		article: { updated: false, fileSha: ARTICLE_SHA },
		source: { deleted: true },
		destination: { blobSha: BLOB_SHA },
		completedAt: "2026-08-17T01:02:00.000Z",
	};
}

function createMovePreview(): MoveMediaTransactionPreview {
	return {
		version: 1,
		previewId: "move_preview_1234567890abcdef",
		operation: "move",
		createdAt: new Date(CREATED_AT).toISOString(),
		expiresAt: new Date(EXPIRES_AT).toISOString(),
		baseCommitSha: HEAD_SHA,
		source: {
			storageSlug: "hello-world",
			article: {
				expectedSha: ARTICLE_SHA,
				repositoryPath: "src/content/posts/hello-world/index.md",
			},
			resource: {
				filename: "guide.pdf",
				relativePath: "./guide.pdf",
				repositoryPath: "src/content/posts/hello-world/guide.pdf",
				blobSha: BLOB_SHA,
			},
			references: [],
		},
		destination: {
			storageSlug: "target-article",
			article: {
				expectedSha: DESTINATION_ARTICLE_SHA,
				repositoryPath: "src/content/posts/target-article/index.md",
			},
			resource: {
				filename: "moved-guide.pdf",
				relativePath: "./moved-guide.pdf",
				repositoryPath: "src/content/posts/target-article/moved-guide.pdf",
				blobSha: BLOB_SHA,
			},
			references: [],
		},
		referenceClosure: {
			complete: true,
			scannedArticleCount: 2,
			thirdPartyReferenceCount: 0,
		},
		effects: [
			{
				type: "resource-reuse",
				repositoryPath: "src/content/posts/target-article/moved-guide.pdf",
				from: null,
				to: BLOB_SHA,
			},
			{
				type: "resource-delete",
				repositoryPath: "src/content/posts/hello-world/guide.pdf",
				from: BLOB_SHA,
				to: null,
			},
		],
		policyLevel: "L1",
		riskLevel: "high",
		riskReasons: ["cross-article-change"],
		confirmation: {
			kind: "phrase",
			phrase: "移动 guide.pdf 到 target-article/moved-guide.pdf",
		},
	};
}

function createMovePlan(): MoveMediaTransactionCommitPlan {
	return {
		version: 1,
		operation: "move",
		previewId: createMovePreview().previewId,
		baseCommitSha: HEAD_SHA,
		source: {
			storageSlug: "hello-world",
			resource: {
				repositoryPath: "src/content/posts/hello-world/guide.pdf",
				blobSha: BLOB_SHA,
			},
			article: {
				mode: "unchanged",
				repositoryPath: "src/content/posts/hello-world/index.md",
				expectedSha: ARTICLE_SHA,
				originalContent: "source article",
				plannedContent: "source article",
				replacements: [],
			},
		},
		destination: {
			storageSlug: "target-article",
			resource: {
				repositoryPath: "src/content/posts/target-article/moved-guide.pdf",
				reusedBlobSha: BLOB_SHA,
			},
			article: {
				mode: "unchanged",
				repositoryPath: "src/content/posts/target-article/index.md",
				expectedSha: DESTINATION_ARTICLE_SHA,
				originalContent: "destination article",
				plannedContent: "destination article",
				replacements: [],
			},
		},
	};
}

function createMoveResult(): MoveMediaTransactionCommitResult {
	return {
		version: 1,
		operation: "move",
		previewId: createMovePreview().previewId,
		commitSha: CANDIDATE_SHA,
		url: `https://github.com/owner/repo/commit/${CANDIDATE_SHA}`,
		articles: {
			source: { updated: false, fileSha: ARTICLE_SHA },
			destination: { updated: false, fileSha: DESTINATION_ARTICLE_SHA },
		},
		source: { deleted: true },
		destination: { blobSha: BLOB_SHA },
		completedAt: "2026-08-17T01:02:00.000Z",
	};
}

async function createHashes() {
	const preview = createPreview();
	return {
		previewRequestHash: await createMediaTransactionPreviewRequestHash({
			version: 1,
			operation: "rename",
			storageSlug: preview.storageSlug,
			sourceFilename: preview.source.filename,
			destinationFilename: preview.destination.filename,
			expectedHeadSha: preview.baseCommitSha,
			expectedArticleSha: preview.expectedArticleSha,
			expectedBlobSha: preview.expectedBlobSha,
		}),
		commitRequestHash: await createMediaTransactionCommitRequestHash({
			previewId: preview.previewId,
			confirmation: preview.confirmation,
		}),
		keyHash: await createMediaTransactionCommitIdempotencyKeyHash("key-1234567890123456"),
		otherKeyHash: await createMediaTransactionCommitIdempotencyKeyHash("key-abcdefghijklmnop"),
		planHash: await createMediaTransactionCommitPlanHash(createPlan(), preview),
	};
}

async function createMoveHashes() {
	const preview = createMovePreview();
	return {
		previewRequestHash: await createMediaTransactionPreviewRequestHash({
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
		}),
		commitRequestHash: await createMediaTransactionCommitRequestHash({
			previewId: preview.previewId,
			confirmation: preview.confirmation,
		}),
		keyHash: await createMediaTransactionCommitIdempotencyKeyHash("move-key-123456789012"),
		planHash: await createMediaTransactionCommitPlanHash(createMovePlan(), preview),
	};
}

async function createRow(overrides: Row = {}): Promise<Row> {
	const preview = createPreview();
	const hashes = await createHashes();
	return {
		preview_id: preview.previewId,
		subject: "subject-1",
		request_hash: hashes.previewRequestHash,
		operation: "rename",
		storage_slug: preview.storageSlug,
		base_commit_sha: preview.baseCommitSha,
		expected_article_sha: preview.expectedArticleSha,
		expected_blob_sha: preview.expectedBlobSha,
		destination_storage_slug: null,
		destination_expected_article_sha: null,
		preview_json: JSON.stringify(preview),
		status: "ready",
		commit_idempotency_key_hash: null,
		commit_request_hash: null,
		commit_plan_hash: null,
		commit_plan_json: null,
		candidate_commit_sha: null,
		result_json: null,
		claim_token: null,
		claimed_at: null,
		claim_expires_at: null,
		created_at: CREATED_AT,
		expires_at: EXPIRES_AT,
		updated_at: CREATED_AT,
		consumed_at: null,
		...overrides,
	};
}

async function createMoveRow(overrides: Row = {}): Promise<Row> {
	const preview = createMovePreview();
	const hashes = await createMoveHashes();
	return {
		preview_id: preview.previewId,
		subject: "subject-1",
		request_hash: hashes.previewRequestHash,
		operation: "move",
		storage_slug: preview.source.storageSlug,
		base_commit_sha: preview.baseCommitSha,
		expected_article_sha: preview.source.article.expectedSha,
		expected_blob_sha: preview.source.resource.blobSha,
		destination_storage_slug: preview.destination.storageSlug,
		destination_expected_article_sha: preview.destination.article.expectedSha,
		preview_json: JSON.stringify(preview),
		status: "ready",
		commit_idempotency_key_hash: null,
		commit_request_hash: null,
		commit_plan_hash: null,
		commit_plan_json: null,
		candidate_commit_sha: null,
		result_json: null,
		claim_token: null,
		claimed_at: null,
		claim_expires_at: null,
		created_at: CREATED_AT,
		expires_at: EXPIRES_AT,
		updated_at: CREATED_AT,
		consumed_at: null,
		...overrides,
	};
}

function createDatabase(initialRow: Row | null, failRuns = false) {
	let row = initialRow;
	const calls: Array<{ query: string; values: unknown[] }> = [];
	const database: D1Database = {
		prepare(query: string): D1PreparedStatement {
			let values: unknown[] = [];
			const statement: D1PreparedStatement = {
				bind(...nextValues) {
					values = nextValues;
					calls.push({ query, values });
					return statement;
				},
				async run() {
					if (failRuns) return { success: false, meta: { changes: 0 } };
					let changes = 0;
					if (query.startsWith("INSERT OR IGNORE")) {
						if (row === null) {
							row = await createRow({
								preview_id: values[0],
								subject: values[1],
								request_hash: values[2],
								operation: values[3],
								storage_slug: values[4],
								base_commit_sha: values[5],
								expected_article_sha: values[6],
								expected_blob_sha: values[7],
								destination_storage_slug: values[8],
								destination_expected_article_sha: values[9],
								preview_json: values[10],
								created_at: values[11],
								expires_at: values[12],
								updated_at: values[13],
							});
							changes = 1;
						}
					} else if (query.includes("SET status = 'committing'")) {
						const currentRow = row;
						if (
							currentRow !== null &&
							currentRow.preview_id === values[6] &&
							currentRow.subject === values[7] &&
							Number(currentRow.expires_at) > Number(values[8]) &&
							(currentRow.status === "ready" ||
								(currentRow.status === "committing" &&
									Number(currentRow.claim_expires_at) <= Number(values[9]))) &&
							(currentRow.commit_idempotency_key_hash === null ||
								currentRow.commit_idempotency_key_hash === values[10]) &&
							(currentRow.commit_request_hash === null ||
								currentRow.commit_request_hash === values[11])
						) {
							Object.assign(currentRow, {
								status: "committing",
								commit_idempotency_key_hash: currentRow.commit_idempotency_key_hash ?? values[0],
								commit_request_hash: currentRow.commit_request_hash ?? values[1],
								claim_token: values[2],
								claimed_at: values[3],
								claim_expires_at: values[4],
								updated_at: values[5],
							});
							changes = 1;
						}
					} else if (query.includes("SET status = 'unknown'")) {
						if (
							row?.status === "committing" &&
							row.preview_id === values[3] &&
							row.subject === values[4] &&
							row.commit_idempotency_key_hash === values[5] &&
							row.commit_request_hash === values[6] &&
							row.claim_token === values[7] &&
							Number(row.claim_expires_at) > Number(values[8])
						) {
							Object.assign(row, {
								status: "unknown",
								commit_plan_hash: values[0],
								commit_plan_json: values[1],
								updated_at: values[2],
							});
							changes = 1;
						}
					} else if (query.includes("candidate_commit_sha = COALESCE")) {
						if (
							row?.status === "unknown" &&
							row.preview_id === values[2] &&
							row.subject === values[3] &&
							row.commit_idempotency_key_hash === values[4] &&
							row.commit_request_hash === values[5] &&
							row.commit_plan_hash === values[6] &&
							row.claim_token === values[7] &&
							(row.candidate_commit_sha === null || row.candidate_commit_sha === values[8])
						) {
							row.candidate_commit_sha = row.candidate_commit_sha ?? values[0];
							row.updated_at = values[1];
							changes = 1;
						}
					} else if (query.includes("SET status = ?")) {
						if (
							(row?.status === "committing" || row?.status === "unknown") &&
							row.preview_id === values[2] &&
							row.subject === values[3] &&
							row.commit_idempotency_key_hash === values[4] &&
							row.commit_request_hash === values[5] &&
							row.claim_token === values[6] &&
							row.candidate_commit_sha === null &&
							(values[7] === null || row.commit_plan_hash === values[8])
						) {
							Object.assign(row, {
								status: values[0],
								commit_plan_hash: null,
								commit_plan_json: null,
								claim_token: null,
								claimed_at: null,
								claim_expires_at: null,
								updated_at: values[1],
							});
							changes = 1;
						}
					} else if (query.includes("SET status = 'consumed'")) {
						const tokenMatches = values.length === 10 ? row?.claim_token === values[9] : true;
						if (
							row?.status === "unknown" &&
							row.preview_id === values[3] &&
							row.subject === values[4] &&
							row.commit_idempotency_key_hash === values[5] &&
							row.commit_request_hash === values[6] &&
							row.commit_plan_hash === values[7] &&
							row.candidate_commit_sha === values[8] &&
							tokenMatches
						) {
							Object.assign(row, {
								status: "consumed",
								result_json: values[0],
								claim_token: null,
								claimed_at: null,
								claim_expires_at: null,
								consumed_at: values[1],
								updated_at: values[2],
							});
							changes = 1;
						}
					}
					return { success: true, meta: { changes } };
				},
				async first<T>() {
					if (row === null) return null;
					if (query.includes("WHERE subject = ?") && row.subject !== values[0]) return null;
					if (query.includes("request_hash = ?") && row.request_hash !== values[1]) return null;
					return { ...row } as T;
				},
			};
			return statement;
		},
	};
	return { database, calls, getRow: () => row };
}

async function createAttempt(overrides: Partial<MediaTransactionCommitAttempt> = {}) {
	const hashes = await createHashes();
	return {
		previewId: createPreview().previewId,
		subject: "subject-1",
		idempotencyKeyHash: hashes.keyHash,
		requestHash: hashes.commitRequestHash,
		claimToken: CLAIM_TOKEN,
		...overrides,
	};
}

async function createMoveAttempt(overrides: Partial<MediaTransactionCommitAttempt> = {}) {
	const hashes = await createMoveHashes();
	return {
		previewId: createMovePreview().previewId,
		subject: "subject-1",
		idempotencyKeyHash: hashes.keyHash,
		requestHash: hashes.commitRequestHash,
		claimToken: CLAIM_TOKEN,
		...overrides,
	};
}

async function createUnknownRow(candidateCommitSha: string | null = null): Promise<Row> {
	const hashes = await createHashes();
	return createRow({
		status: "unknown",
		commit_idempotency_key_hash: hashes.keyHash,
		commit_request_hash: hashes.commitRequestHash,
		commit_plan_hash: hashes.planHash,
		commit_plan_json: JSON.stringify(createPlan()),
		candidate_commit_sha: candidateCommitSha,
		claim_token: CLAIM_TOKEN,
		claimed_at: CREATED_AT + 1,
		claim_expires_at: CREATED_AT + 60_000,
		updated_at: CREATED_AT + 1,
	});
}

async function createMoveUnknownRow(candidateCommitSha: string | null = null): Promise<Row> {
	const hashes = await createMoveHashes();
	return createMoveRow({
		status: "unknown",
		commit_idempotency_key_hash: hashes.keyHash,
		commit_request_hash: hashes.commitRequestHash,
		commit_plan_hash: hashes.planHash,
		commit_plan_json: JSON.stringify(createMovePlan()),
		candidate_commit_sha: candidateCommitSha,
		claim_token: CLAIM_TOKEN,
		claimed_at: CREATED_AT + 1,
		claim_expires_at: CREATED_AT + 60_000,
		updated_at: CREATED_AT + 1,
	});
}

describe("D1 媒体事务 Preview Commit CAS Store", () => {
	it("首次创建并复用严格校验的 ready Preview", async () => {
		const hashes = await createHashes();
		const firstDatabase = createDatabase(null);
		const firstStore = new D1MediaTransactionPreviewStore(firstDatabase.database, () => CREATED_AT);
		await expect(
			firstStore.createOrReuse({
				subject: "subject-1",
				requestHash: hashes.previewRequestHash,
				preview: createPreview(),
			}),
		).resolves.toEqual({ preview: createPreview(), reused: false });

		const reusedDatabase = createDatabase(await createRow());
		const reusedStore = new D1MediaTransactionPreviewStore(
			reusedDatabase.database,
			() => CREATED_AT + 1,
		);
		await expect(
			reusedStore.createOrReuse({
				subject: "subject-1",
				requestHash: hashes.previewRequestHash,
				preview: createPreview(),
			}),
		).resolves.toEqual({ preview: createPreview(), reused: true });
	});

	it("创建并复用 move Preview，显式写入源目标四层锁冗余", async () => {
		const hashes = await createMoveHashes();
		const firstMemory = createDatabase(null);
		const firstStore = new D1MediaTransactionPreviewStore(firstMemory.database, () => CREATED_AT);
		await expect(
			firstStore.createOrReuse({
				subject: "subject-1",
				requestHash: hashes.previewRequestHash,
				preview: createMovePreview(),
			}),
		).resolves.toEqual({ preview: createMovePreview(), reused: false });
		expect(firstMemory.getRow()).toMatchObject({
			operation: "move",
			storage_slug: "hello-world",
			expected_article_sha: ARTICLE_SHA,
			expected_blob_sha: BLOB_SHA,
			destination_storage_slug: "target-article",
			destination_expected_article_sha: DESTINATION_ARTICLE_SHA,
		});

		const reusedStore = new D1MediaTransactionPreviewStore(
			createDatabase(await createMoveRow()).database,
			() => CREATED_AT + 1,
		);
		await expect(
			reusedStore.createOrReuse({
				subject: "subject-1",
				requestHash: hashes.previewRequestHash,
				preview: createMovePreview(),
			}),
		).resolves.toEqual({ preview: createMovePreview(), reused: true });

		await expect(
			reusedStore.createOrReuse({
				subject: "subject-1",
				requestHash: hashes.previewRequestHash,
				preview: {
					...createMovePreview(),
					referenceClosure: {
						...createMovePreview().referenceClosure,
						scannedArticleCount: 3,
					},
				},
			}),
		).rejects.toMatchObject({ code: "MEDIA_PREVIEW_UNAVAILABLE" });
	});

	it("首次 claim 成功，并发 claim 分类为 committing", async () => {
		const memory = createDatabase(await createRow());
		const store = new D1MediaTransactionPreviewStore(memory.database, () => CREATED_AT + 1);
		const attempt = await createAttempt();
		await expect(store.claimCommit({ ...attempt, leaseMs: 30_000 })).resolves.toMatchObject({
			state: "claimed",
			claimToken: CLAIM_TOKEN,
		});
		await expect(
			store.claimCommit({ ...attempt, claimToken: OTHER_TOKEN, leaseMs: 30_000 }),
		).resolves.toMatchObject({ state: "committing" });
	});

	it("不同 key/request 冲突，跨主体隐藏为 not-found", async () => {
		const hashes = await createHashes();
		const row = await createRow({
			status: "committing",
			commit_idempotency_key_hash: hashes.keyHash,
			commit_request_hash: hashes.commitRequestHash,
			claim_token: CLAIM_TOKEN,
			claimed_at: CREATED_AT + 1,
			claim_expires_at: CREATED_AT + 30_000,
			updated_at: CREATED_AT + 1,
		});
		const store = new D1MediaTransactionPreviewStore(
			createDatabase(row).database,
			() => CREATED_AT + 2,
		);
		await expect(
			store.getForCommit({
				...(await createAttempt()),
				idempotencyKeyHash: hashes.otherKeyHash,
			}),
		).resolves.toEqual({ state: "conflict" });
		await expect(
			store.getForCommit({ ...(await createAttempt()), subject: "subject-2" }),
		).resolves.toEqual({ state: "not-found" });
	});

	it("仅 committing 租约到期可回收，旧 token 随即失效", async () => {
		const hashes = await createHashes();
		const row = await createRow({
			status: "committing",
			commit_idempotency_key_hash: hashes.keyHash,
			commit_request_hash: hashes.commitRequestHash,
			claim_token: CLAIM_TOKEN,
			claimed_at: CREATED_AT,
			claim_expires_at: CREATED_AT + 10,
			updated_at: CREATED_AT,
		});
		const store = new D1MediaTransactionPreviewStore(
			createDatabase(row).database,
			() => CREATED_AT + 20,
		);
		const attempt = await createAttempt({ claimToken: OTHER_TOKEN });
		await expect(store.claimCommit({ ...attempt, leaseMs: 30_000 })).resolves.toMatchObject({
			state: "claimed",
			claimToken: OTHER_TOKEN,
		});
		await expect(
			store.armUnknown({ ...(await createAttempt()), plan: createPlan() }),
		).rejects.toMatchObject({ code: "MEDIA_PREVIEW_UNAVAILABLE" });
	});

	it("armUnknown 原子固化 plan，candidate 同 SHA 幂等、不同 SHA 失败关闭", async () => {
		const hashes = await createHashes();
		const memory = createDatabase(
			await createRow({
				status: "committing",
				commit_idempotency_key_hash: hashes.keyHash,
				commit_request_hash: hashes.commitRequestHash,
				claim_token: CLAIM_TOKEN,
				claimed_at: CREATED_AT + 1,
				claim_expires_at: CREATED_AT + 60_000,
				updated_at: CREATED_AT + 1,
			}),
		);
		const store = new D1MediaTransactionPreviewStore(memory.database, () => CREATED_AT + 2);
		const attempt = await createAttempt();
		await expect(store.armUnknown({ ...attempt, plan: createPlan() })).resolves.toEqual({
			plan: createPlan(),
			planHash: hashes.planHash,
		});
		const checkpoint = { ...attempt, planHash: hashes.planHash, candidateCommitSha: CANDIDATE_SHA };
		await expect(store.recordCandidateCommit(checkpoint)).resolves.toBeUndefined();
		await expect(store.recordCandidateCommit(checkpoint)).resolves.toBeUndefined();
		await expect(
			store.recordCandidateCommit({ ...checkpoint, candidateCommitSha: "e".repeat(40) }),
		).rejects.toMatchObject({ code: "MEDIA_PREVIEW_UNAVAILABLE" });
	});

	it("candidate 前可 release 且保留首次 key/request；candidate 后永远不能 release", async () => {
		const hashes = await createHashes();
		const attempt = await createAttempt();
		const beforeMemory = createDatabase(await createUnknownRow());
		const beforeStore = new D1MediaTransactionPreviewStore(
			beforeMemory.database,
			() => CREATED_AT + 2,
		);
		await expect(
			beforeStore.releaseBeforeCandidate({ ...attempt, planHash: hashes.planHash }),
		).resolves.toBeUndefined();
		expect(beforeMemory.getRow()).toMatchObject({
			status: "ready",
			commit_idempotency_key_hash: hashes.keyHash,
			commit_request_hash: hashes.commitRequestHash,
		});

		const afterStore = new D1MediaTransactionPreviewStore(
			createDatabase(await createUnknownRow(CANDIDATE_SHA)).database,
			() => CREATED_AT + 2,
		);
		await expect(
			afterStore.releaseBeforeCandidate({ ...attempt, planHash: hashes.planHash }),
		).rejects.toMatchObject({ code: "MEDIA_PREVIEW_UNAVAILABLE" });
	});

	it("consume 绑定 attempt/plan/candidate，之后严格回放 result", async () => {
		const hashes = await createHashes();
		const memory = createDatabase(await createUnknownRow(CANDIDATE_SHA));
		const store = new D1MediaTransactionPreviewStore(memory.database, () => CREATED_AT + 2);
		const attempt = await createAttempt();
		await expect(
			store.consume({
				...attempt,
				planHash: hashes.planHash,
				candidateCommitSha: CANDIDATE_SHA,
				result: createResult(),
			}),
		).resolves.toBeUndefined();
		await expect(store.getForCommit(attempt)).resolves.toMatchObject({
			state: "consumed",
			candidateCommitSha: CANDIDATE_SHA,
			result: createResult(),
		});
	});

	it("move 完成 claim-arm-candidate-consume 并严格回放", async () => {
		const hashes = await createMoveHashes();
		const memory = createDatabase(await createMoveRow());
		const store = new D1MediaTransactionPreviewStore(memory.database, () => CREATED_AT + 2);
		const attempt = await createMoveAttempt();
		await expect(store.claimCommit({ ...attempt, leaseMs: 30_000 })).resolves.toMatchObject({
			state: "claimed",
			preview: createMovePreview(),
		});
		await expect(store.armUnknown({ ...attempt, plan: createMovePlan() })).resolves.toEqual({
			plan: createMovePlan(),
			planHash: hashes.planHash,
		});
		await expect(store.getForCommit(attempt)).resolves.toMatchObject({
			state: "unknown",
			plan: createMovePlan(),
			planHash: hashes.planHash,
		});
		await expect(
			store.recordCandidateCommit({
				...attempt,
				planHash: hashes.planHash,
				candidateCommitSha: CANDIDATE_SHA,
			}),
		).resolves.toBeUndefined();
		await expect(
			store.consume({
				...attempt,
				planHash: hashes.planHash,
				candidateCommitSha: CANDIDATE_SHA,
				result: createMoveResult(),
			}),
		).resolves.toBeUndefined();
		await expect(store.getForCommit(attempt)).resolves.toMatchObject({
			state: "consumed",
			preview: createMovePreview(),
			plan: createMovePlan(),
			candidateCommitSha: CANDIDATE_SHA,
			result: createMoveResult(),
		});
	});

	it("move unknown 可读取无 candidate checkpoint", async () => {
		const store = new D1MediaTransactionPreviewStore(
			createDatabase(await createMoveUnknownRow()).database,
			() => CREATED_AT + 2,
		);
		await expect(store.getForCommit(await createMoveAttempt())).resolves.toEqual({
			state: "unknown",
			preview: createMovePreview(),
			plan: createMovePlan(),
			planHash: (await createMoveHashes()).planHash,
		});
	});

	it("recovery completion 无 attempt，但绑定 identity/plan/candidate", async () => {
		const hashes = await createHashes();
		const memory = createDatabase(await createUnknownRow(CANDIDATE_SHA));
		const store = new D1MediaTransactionPreviewStore(memory.database, () => CREATED_AT + 2);
		const { claimToken: _claimToken, ...identity } = await createAttempt();
		await expect(
			store.completeRecovered({
				...identity,
				planHash: hashes.planHash,
				candidateCommitSha: CANDIDATE_SHA,
				result: createResult(),
			}),
		).resolves.toBeUndefined();
		expect(memory.getRow()).toMatchObject({ status: "consumed", result_json: expect.any(String) });
	});

	it("损坏 preview JSON/hash/冗余字段/plan/result 均失败关闭", async () => {
		const hashes = await createHashes();
		for (const row of [
			await createRow({ preview_json: "not-json" }),
			await createRow({ request_hash: "f".repeat(64) }),
			await createRow({ base_commit_sha: "f".repeat(40) }),
			await createUnknownRow(CANDIDATE_SHA).then((value) => ({
				...value,
				commit_plan_hash: "f".repeat(64),
			})),
			await createUnknownRow(CANDIDATE_SHA).then((value) => ({
				...value,
				status: "consumed",
				result_json: JSON.stringify({ ...createResult(), commitSha: "f".repeat(40) }),
				claim_token: null,
				claimed_at: null,
				claim_expires_at: null,
				consumed_at: CREATED_AT + 3,
			})),
		]) {
			const store = new D1MediaTransactionPreviewStore(
				createDatabase(row).database,
				() => CREATED_AT + 2,
			);
			await expect(store.getForCommit(await createAttempt())).rejects.toMatchObject({
				code: "MEDIA_PREVIEW_UNAVAILABLE",
			});
		}
		expect(hashes.planHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("move destination 冗余、plan 和 result 篡改均失败关闭", async () => {
		const moveHashes = await createMoveHashes();
		const consumedBase = await createMoveUnknownRow(CANDIDATE_SHA);
		for (const row of [
			await createMoveRow({ destination_storage_slug: "tampered-target" }),
			await createMoveRow({ destination_expected_article_sha: "f".repeat(40) }),
			{
				...(await createMoveUnknownRow(CANDIDATE_SHA)),
				commit_plan_json: JSON.stringify({
					...createMovePlan(),
					destination: {
						...createMovePlan().destination,
						storageSlug: "tampered-target",
					},
				}),
			},
			{
				...consumedBase,
				status: "consumed",
				result_json: JSON.stringify({
					...createMoveResult(),
					articles: {
						...createMoveResult().articles,
						destination: { updated: false, fileSha: "f".repeat(40) },
					},
				}),
				claim_token: null,
				claimed_at: null,
				claim_expires_at: null,
				consumed_at: CREATED_AT + 3,
			},
		]) {
			const store = new D1MediaTransactionPreviewStore(
				createDatabase(row).database,
				() => CREATED_AT + 2,
			);
			await expect(store.getForCommit(await createMoveAttempt())).rejects.toMatchObject({
				code: "MEDIA_PREVIEW_UNAVAILABLE",
			});
		}
		expect(moveHashes.planHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("0006 migration 保留状态约束与索引，并约束 rename/move nullable 冗余", () => {
		const migration = readFileSync(
			new URL("../../migrations/0006_media_transaction_moves.sql", import.meta.url),
			"utf8",
		);
		expect(migration).toContain("operation IN ('rename', 'move')");
		expect(migration).toContain("destination_storage_slug TEXT");
		expect(migration).toContain("destination_expected_article_sha TEXT");
		expect(migration).toContain(
			"operation = 'rename' AND destination_storage_slug IS NULL AND destination_expected_article_sha IS NULL",
		);
		expect(migration).toContain(
			"operation = 'move' AND destination_storage_slug IS NOT NULL AND destination_expected_article_sha IS NOT NULL",
		);
		expect(migration).toContain(
			"status IN ('ready', 'committing', 'unknown', 'consumed', 'expired')",
		);
		expect(migration).toContain("media_transaction_previews_expiry_idx");
		expect(migration).toContain("media_transaction_previews_lease_idx");
		expect(migration).toContain("media_transaction_previews_subject_commit_key_idx");
		expect(migration).toContain("media_transaction_previews_subject_request_idx");
	});

	it("D1 failure 和 changes 异常不降级，统一失败关闭", async () => {
		const store = new D1MediaTransactionPreviewStore(
			createDatabase(await createRow(), true).database,
			() => CREATED_AT + 1,
		);
		await expect(
			store.claimCommit({ ...(await createAttempt()), leaseMs: 30_000 }),
		).rejects.toMatchObject({ status: 503, code: "MEDIA_PREVIEW_UNAVAILABLE" });
	});
});
