import { describe, expect, it } from "vitest";
import {
	applyMediaTransactionCommitError,
	beginMediaTransactionCommit,
	createMediaTransactionCommitRequest,
	createMediaTransactionCommitState,
	createMediaTransactionUnknownRecovery,
	isMediaTransactionCommitEligible,
	isMediaTransactionCommitLocked,
	isMediaTransactionConfirmationExact,
	type MediaTransactionCommitEligibilityInput,
	type MediaTransactionCommitResult,
	type MediaTransactionPreviewData,
	mapMediaTransactionCommitError,
	markMediaTransactionCommitConsumed,
	markMediaTransactionCommitRefreshed,
	markMediaTransactionCommitRefreshFailed,
	markMediaTransactionCommitUnknown,
	parseMediaTransactionCommitPayload,
	parseMediaTransactionPreviewPayload,
	parseMediaTransactionUnknownRecovery,
	prepareMediaTransactionCommitAttempt,
} from "../../src/components/articles/media-transaction-preview-state";

const preview: MediaTransactionPreviewData = {
	version: 1,
	previewId: "preview_1234567890abcdef",
	operation: "rename",
	storageSlug: "hello-world",
	createdAt: "2026-08-17T01:00:00.000Z",
	expiresAt: "2026-08-17T01:10:00.000Z",
	baseCommitSha: "a".repeat(40),
	expectedArticleSha: "b".repeat(40),
	expectedBlobSha: "c".repeat(40),
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
	effects: [],
	references: [],
	referenceAnalysis: { complete: true, issues: [] },
	policyLevel: "L0",
	riskLevel: "low",
	riskReasons: [],
	confirmation: { kind: "button" },
};

const phrasePreview: MediaTransactionPreviewData = {
	...preview,
	policyLevel: "L1",
	riskLevel: "high",
	riskReasons: ["cover-reference"],
	confirmation: { kind: "phrase", phrase: "重命名 old-guide.pdf" },
};

const result: MediaTransactionCommitResult = {
	version: 1,
	operation: "rename",
	previewId: preview.previewId,
	commitSha: "d".repeat(40),
	url: "https://github.com/example/firefly/commit/123",
	article: { updated: true, fileSha: "e".repeat(40) },
	source: { deleted: true },
	destination: { blobSha: preview.expectedBlobSha },
	completedAt: "2026-08-17T01:05:00.000Z",
};

function eligibility(
	overrides: Partial<MediaTransactionCommitEligibilityInput> = {},
): MediaTransactionCommitEligibilityInput {
	return {
		mode: "edit",
		preview,
		now: Date.parse("2026-08-17T01:05:00.000Z"),
		expectedHeadSha: preview.baseCommitSha,
		expectedArticleSha: preview.expectedArticleSha,
		dirty: false,
		stagedAssetCount: 0,
		resourceChangeCount: 0,
		saving: false,
		status: "preview-ready",
		...overrides,
	};
}

describe("媒体事务 Preview 浏览器状态", () => {
	it("严格解析完整响应", () => {
		expect(parseMediaTransactionPreviewPayload({ preview })).toEqual(preview);
	});

	it("拒绝未知字段和不完整引用分析", () => {
		for (const payload of [
			{ preview: { ...preview, subject: "subject-1" } },
			{
				preview: {
					...preview,
					referenceAnalysis: {
						complete: false,
						issues: [{ code: "ambiguous-inline-code", line: null, column: null }],
					},
				},
			},
		]) {
			expect(() => parseMediaTransactionPreviewPayload(payload)).toThrow();
		}
	});
});

describe("媒体事务 Commit 浏览器状态", () => {
	it("严格解析 Commit payload 并拒绝内外层额外字段", () => {
		expect(parseMediaTransactionCommitPayload({ transaction: result })).toEqual(result);
		expect(() =>
			parseMediaTransactionCommitPayload({ transaction: result, replayed: true }),
		).toThrow();
		expect(() =>
			parseMediaTransactionCommitPayload({
				transaction: { ...result, destinationPath: preview.destination.repositoryPath },
			}),
		).toThrow();
	});

	it("要求高风险短语逐字符精确匹配且不 trim", () => {
		expect(isMediaTransactionConfirmationExact(phrasePreview, "重命名 old-guide.pdf")).toBe(true);
		expect(isMediaTransactionConfirmationExact(phrasePreview, " 重命名 old-guide.pdf")).toBe(false);
		expect(isMediaTransactionConfirmationExact(phrasePreview, "重命名 old-guide.pdf ")).toBe(false);
		expect(createMediaTransactionCommitRequest(phrasePreview, " 重命名 old-guide.pdf")).toEqual({
			previewId: phrasePreview.previewId,
			confirmation: { kind: "phrase", phrase: " 重命名 old-guide.pdf" },
		});
	});

	it("只允许干净且版本锁匹配的编辑页提交", () => {
		expect(isMediaTransactionCommitEligible(eligibility())).toBe(true);
		for (const override of [
			{ mode: "create" as const },
			{ preview: null },
			{ expectedHeadSha: "f".repeat(40) },
			{ expectedArticleSha: "f".repeat(40) },
			{ dirty: true },
			{ stagedAssetCount: 1 },
			{ resourceChangeCount: 1 },
			{ saving: true },
			{ status: "idle" as const },
			{ status: "committing" as const },
			{ status: "consumed" as const },
		]) {
			expect(isMediaTransactionCommitEligible(eligibility(override))).toBe(false);
		}
	});

	it("普通 Preview 到期或页面版本漂移后拒绝提交，但 unknown 仍允许使用原尝试恢复", () => {
		const afterExpiry = Date.parse(preview.expiresAt) + 1;
		expect(isMediaTransactionCommitEligible(eligibility({ now: afterExpiry }))).toBe(false);
		expect(
			isMediaTransactionCommitEligible(
				eligibility({
					now: afterExpiry,
					status: "unknown",
					expectedHeadSha: "f".repeat(40),
					expectedArticleSha: "e".repeat(40),
				}),
			),
		).toBe(true);
	});

	it("相同 signature 稳定复用 key，未发送前变更请求才可换 key", () => {
		const request = createMediaTransactionCommitRequest(preview, "");
		const first = prepareMediaTransactionCommitAttempt(null, request, () => "media-key-1234567890");
		expect(prepareMediaTransactionCommitAttempt(first, request, () => "media-key-never-used")).toBe(
			first,
		);
		const changed = prepareMediaTransactionCommitAttempt(
			first,
			{ ...request, previewId: "preview_0987654321fedcba" },
			() => "media-key-0987654321",
		);
		expect(changed.key).toBe("media-key-0987654321");
	});

	it("请求发出后禁止切换 signature 或生成新 key", () => {
		const request = createMediaTransactionCommitRequest(preview, "");
		const committing = beginMediaTransactionCommit(
			createMediaTransactionCommitState(preview),
			request,
			() => "media-key-1234567890",
		);
		expect(() =>
			prepareMediaTransactionCommitAttempt(
				committing.attempt,
				{ ...request, previewId: "preview_0987654321fedcba" },
				() => "media-key-must-not-change",
			),
		).toThrow("原请求和原幂等键");
	});

	it("unknown 重试保留原请求签名和原 key 并持续锁定编辑", () => {
		const request = createMediaTransactionCommitRequest(preview, "");
		const committing = beginMediaTransactionCommit(
			createMediaTransactionCommitState(preview),
			request,
			() => "media-key-1234567890",
		);
		const unknown = markMediaTransactionCommitUnknown(committing);
		const retrying = beginMediaTransactionCommit(
			unknown,
			request,
			() => "media-key-must-not-change",
		);
		expect(unknown.attempt?.key).toBe("media-key-1234567890");
		expect(retrying.attempt).toEqual(unknown.attempt);
		expect(isMediaTransactionCommitLocked(unknown.status)).toBe(true);
		expect(isMediaTransactionCommitLocked(retrying.status)).toBe(true);
	});

	it("unknown 恢复快照严格绑定当前文章、Preview、原请求和原 key", () => {
		const request = createMediaTransactionCommitRequest(preview, "");
		const committing = beginMediaTransactionCommit(
			createMediaTransactionCommitState(preview),
			request,
			() => "media-key-1234567890",
		);
		const unknown = markMediaTransactionCommitUnknown(committing);
		const recovery = createMediaTransactionUnknownRecovery(preview.storageSlug, preview, unknown);

		expect(parseMediaTransactionUnknownRecovery(recovery, preview.storageSlug)).toEqual(recovery);
		expect(() => parseMediaTransactionUnknownRecovery(recovery, "different-article")).toThrow(
			"不属于当前文章",
		);
		expect(() =>
			parseMediaTransactionUnknownRecovery(
				{
					...recovery,
					state: {
						...recovery.state,
						attempt: { ...recovery.state.attempt, key: "media-key-tampered-123" },
					},
				},
				preview.storageSlug,
			),
		).not.toThrow();
		expect(() =>
			parseMediaTransactionUnknownRecovery(
				{
					...recovery,
					state: {
						...recovery.state,
						attempt: {
							...recovery.state.attempt,
							signature: JSON.stringify({ ...request, previewId: "preview_0987654321fedcba" }),
						},
					},
				},
				preview.storageSlug,
			),
		).toThrow("不匹配");
	});

	it("已发送后的 generic 或 retryable Commit 错误必须进入 unknown", () => {
		const request = createMediaTransactionCommitRequest(preview, "");
		for (const kind of ["unknown", "in-progress", "retryable"] as const) {
			const committing = beginMediaTransactionCommit(
				createMediaTransactionCommitState(preview),
				request,
				() => "media-key-1234567890",
			);
			expect(applyMediaTransactionCommitError(committing, kind)).toMatchObject({
				status: "unknown",
				attempt: committing.attempt,
			});
		}
	});

	it("只有可证明的前置拒绝允许离开已发送后的 unknown 路径", () => {
		const request = createMediaTransactionCommitRequest(preview, "");
		for (const [kind, status] of [
			["confirmation", "preview-ready"],
			["expired", "idle"],
			["conflict", "idle"],
		] as const) {
			const committing = beginMediaTransactionCommit(
				createMediaTransactionCommitState(preview),
				request,
				() => "media-key-1234567890",
			);
			expect(applyMediaTransactionCommitError(committing, kind).status).toBe(status);
		}
	});

	it("刷新失败持续锁定，恢复后只清除冻结 attempt 并保留结果", () => {
		const request = createMediaTransactionCommitRequest(preview, "");
		const committing = beginMediaTransactionCommit(
			createMediaTransactionCommitState(preview),
			request,
			() => "media-key-1234567890",
		);
		const consumed = markMediaTransactionCommitConsumed(committing, result);
		const refreshFailed = markMediaTransactionCommitRefreshFailed(consumed);
		const refreshed = markMediaTransactionCommitRefreshed(refreshFailed);
		expect(consumed).toMatchObject({ status: "consumed", result });
		expect(refreshFailed).toMatchObject({
			status: "refresh-failed",
			attempt: committing.attempt,
			result,
		});
		expect(isMediaTransactionCommitLocked(refreshFailed.status)).toBe(true);
		expect(refreshed).toEqual({ status: "consumed", attempt: null, result });
		expect(isMediaTransactionCommitLocked(refreshed.status)).toBe(false);
	});

	it("将服务端错误稳定映射为前端安全状态", () => {
		expect(
			mapMediaTransactionCommitError(
				{ error: { code: "COMMIT_STATUS_UNKNOWN", message: "unknown" } },
				503,
			),
		).toMatchObject({ kind: "unknown" });
		expect(
			mapMediaTransactionCommitError(
				{ error: { code: "MEDIA_PREVIEW_IN_PROGRESS", message: "busy" } },
				409,
			),
		).toMatchObject({ kind: "in-progress" });
		expect(
			mapMediaTransactionCommitError(
				{ error: { code: "MEDIA_TRANSACTION_UNAVAILABLE", message: "down" } },
				503,
			),
		).toMatchObject({ kind: "retryable" });
		expect(mapMediaTransactionCommitError(null, 409)).toMatchObject({ kind: "conflict" });
	});
});
