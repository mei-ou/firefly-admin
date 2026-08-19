import { z } from "zod";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const PREVIEW_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,179}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,200}$/;
const SAFE_RESOURCE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.[a-zA-Z0-9]+$/;

const confirmationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("button") }).strict(),
	z.object({ kind: z.literal("phrase"), phrase: z.string().min(1).max(120) }).strict(),
]);

const previewSchema = z
	.object({
		version: z.literal(1),
		previewId: z.string().regex(PREVIEW_ID),
		operation: z.literal("rename"),
		storageSlug: z
			.string()
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
			.max(100),
		createdAt: z.iso.datetime({ offset: true }),
		expiresAt: z.iso.datetime({ offset: true }),
		baseCommitSha: z.string().regex(GIT_OBJECT_SHA),
		expectedArticleSha: z.string().regex(GIT_OBJECT_SHA),
		expectedBlobSha: z.string().regex(GIT_OBJECT_SHA),
		source: z
			.object({
				filename: z.string().regex(SAFE_RESOURCE_FILENAME).max(120),
				relativePath: z.string().min(1).max(512),
				repositoryPath: z.string().min(1).max(512),
			})
			.strict(),
		destination: z
			.object({
				filename: z.string().regex(SAFE_RESOURCE_FILENAME).max(120),
				relativePath: z.string().min(1).max(512),
				repositoryPath: z.string().min(1).max(512),
			})
			.strict(),
		effects: z
			.array(
				z
					.object({
						type: z.enum(["resource-reuse", "resource-delete", "reference-update"]),
						repositoryPath: z.string().min(1).max(512),
						from: z.string().min(1).max(512).nullable(),
						to: z.string().min(1).max(512).nullable(),
					})
					.strict(),
			)
			.max(20_000),
		references: z
			.array(
				z
					.object({
						source: z.enum(["frontmatter-image", "markdown-image", "markdown-link"]),
						originalReference: z.string().min(1).max(512),
						currentTarget: z.string().min(1).max(512),
						proposedTarget: z.string().min(1).max(512),
						line: z.number().int().positive().nullable(),
						column: z.number().int().positive().nullable(),
					})
					.strict(),
			)
			.max(10_000),
		referenceAnalysis: z
			.object({
				complete: z.literal(true),
				issues: z.array(z.never()).length(0),
			})
			.strict(),
		policyLevel: z.enum(["L0", "L1"]),
		riskLevel: z.enum(["low", "medium", "high"]),
		riskReasons: z.array(z.enum(["resource-reference", "cover-reference"])).max(2),
		confirmation: confirmationSchema,
	})
	.strict();

const commitRequestSchema = z
	.object({
		previewId: z.string().regex(PREVIEW_ID),
		confirmation: confirmationSchema,
	})
	.strict();

const commitResultSchema = z
	.object({
		version: z.literal(1),
		operation: z.literal("rename"),
		previewId: z.string().regex(PREVIEW_ID),
		commitSha: z.string().regex(GIT_OBJECT_SHA),
		url: z.url().refine((value) => new URL(value).protocol === "https:"),
		article: z
			.object({
				updated: z.boolean(),
				fileSha: z.string().regex(GIT_OBJECT_SHA),
			})
			.strict(),
		source: z.object({ deleted: z.literal(true) }).strict(),
		destination: z.object({ blobSha: z.string().regex(GIT_OBJECT_SHA) }).strict(),
		completedAt: z.iso.datetime({ offset: true }),
	})
	.strict();

const previewPayloadSchema = z.object({ preview: previewSchema }).strict();
const commitPayloadSchema = z.object({ transaction: commitResultSchema }).strict();
const unknownRecoverySchema = z
	.object({
		version: z.literal(1),
		storageSlug: z
			.string()
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
			.max(100),
		preview: previewSchema,
		state: z
			.object({
				status: z.literal("unknown"),
				attempt: z
					.object({
						signature: z.string().min(1).max(2_000),
						key: z.string().regex(IDEMPOTENCY_KEY),
						sent: z.literal(true),
					})
					.strict(),
				result: z.null(),
			})
			.strict(),
	})
	.strict();
const apiErrorSchema = z.looseObject({
	error: z.looseObject({ code: z.string(), message: z.string() }),
});

export type MediaTransactionPreviewData = z.infer<typeof previewSchema>;
export type MediaTransactionCommitConfirmation = z.infer<typeof confirmationSchema>;
export type MediaTransactionCommitRequest = z.infer<typeof commitRequestSchema>;
export type MediaTransactionCommitResult = z.infer<typeof commitResultSchema>;
export type MediaTransactionCommitStatus =
	| "idle"
	| "preview-ready"
	| "committing"
	| "unknown"
	| "consumed"
	| "refresh-failed";

export interface MediaTransactionCommitAttempt {
	signature: string;
	key: string;
	sent: boolean;
}

export interface MediaTransactionCommitState {
	status: MediaTransactionCommitStatus;
	attempt: MediaTransactionCommitAttempt | null;
	result: MediaTransactionCommitResult | null;
}

export interface MediaTransactionUnknownRecovery {
	version: 1;
	storageSlug: string;
	preview: MediaTransactionPreviewData;
	state: MediaTransactionCommitState & {
		status: "unknown";
		attempt: MediaTransactionCommitAttempt;
		result: null;
	};
}

export interface MediaTransactionCommitEligibilityInput {
	mode: "create" | "edit";
	preview: MediaTransactionPreviewData | null;
	now: number;
	expectedHeadSha: string;
	expectedArticleSha: string;
	dirty: boolean;
	stagedAssetCount: number;
	resourceChangeCount: number;
	saving: boolean;
	status: MediaTransactionCommitStatus;
}

export type MediaTransactionCommitErrorKind =
	| "expired"
	| "in-progress"
	| "confirmation"
	| "conflict"
	| "unknown"
	| "retryable";

/** 浏览器不信任同源 API 响应，Preview 展示前仍以 strict Schema 拒绝字段漂移。 */
export function parseMediaTransactionPreviewPayload(input: unknown): MediaTransactionPreviewData {
	return previewPayloadSchema.parse(input).preview;
}

/** Commit body 只允许 previewId 和原始 confirmation；短语不得 trim 或 normalize。 */
export function parseMediaTransactionCommitRequest(input: unknown): MediaTransactionCommitRequest {
	return commitRequestSchema.parse(input);
}

export function parseMediaTransactionCommitResult(input: unknown): MediaTransactionCommitResult {
	return commitResultSchema.parse(input);
}

export function parseMediaTransactionCommitPayload(input: unknown): MediaTransactionCommitResult {
	return commitPayloadSchema.parse(input).transaction;
}

export function createMediaTransactionCommitRequest(
	preview: MediaTransactionPreviewData,
	phrase: string,
): MediaTransactionCommitRequest {
	const confirmation: MediaTransactionCommitConfirmation =
		preview.confirmation.kind === "button" ? { kind: "button" } : { kind: "phrase", phrase };
	return parseMediaTransactionCommitRequest({ previewId: preview.previewId, confirmation });
}

export function isMediaTransactionConfirmationExact(
	preview: MediaTransactionPreviewData,
	phrase: string,
): boolean {
	return preview.confirmation.kind === "button" || phrase === preview.confirmation.phrase;
}

export function isMediaTransactionCommitEligible(
	input: MediaTransactionCommitEligibilityInput,
): boolean {
	const { preview } = input;
	return (
		input.mode === "edit" &&
		preview !== null &&
		(input.status === "preview-ready" || input.status === "unknown") &&
		(input.status === "unknown" ||
			(Date.parse(preview.expiresAt) > input.now &&
				preview.baseCommitSha === input.expectedHeadSha &&
				preview.expectedArticleSha === input.expectedArticleSha)) &&
		!input.dirty &&
		input.stagedAssetCount === 0 &&
		input.resourceChangeCount === 0 &&
		!input.saving
	);
}

export function createMediaTransactionCommitSignature(
	request: MediaTransactionCommitRequest,
): string {
	const parsed = parseMediaTransactionCommitRequest(request);
	return JSON.stringify(parsed);
}

/**
 * 只持久化 unknown 恢复所需的最小闭包。会话存储仍是不可信输入，读取时必须重新验证
 * Preview、原请求签名和已发送幂等键之间的绑定关系。
 */
export function createMediaTransactionUnknownRecovery(
	storageSlug: string,
	preview: MediaTransactionPreviewData,
	state: MediaTransactionCommitState,
): MediaTransactionUnknownRecovery {
	if (state.status !== "unknown" || !state.attempt?.sent || state.result !== null) {
		throw new TypeError("只有待确认的已发送媒体事务可以持久化恢复状态。");
	}
	const request = parseMediaTransactionCommitRequest(JSON.parse(state.attempt.signature));
	if (
		request.previewId !== preview.previewId ||
		createMediaTransactionCommitSignature(request) !== state.attempt.signature
	) {
		throw new TypeError("媒体事务恢复状态与 Preview 不匹配。");
	}
	return unknownRecoverySchema.parse({ version: 1, storageSlug, preview, state });
}

export function parseMediaTransactionUnknownRecovery(
	input: unknown,
	expectedStorageSlug: string,
): MediaTransactionUnknownRecovery {
	const recovery = unknownRecoverySchema.parse(input);
	if (
		recovery.storageSlug !== expectedStorageSlug ||
		recovery.preview.storageSlug !== expectedStorageSlug
	) {
		throw new TypeError("媒体事务恢复状态不属于当前文章。");
	}
	return createMediaTransactionUnknownRecovery(
		recovery.storageSlug,
		recovery.preview,
		recovery.state,
	);
}

/** 请求一旦发出，signature 与 key 即冻结；unknown 只能用完全相同的请求和原 key 恢复。 */
export function prepareMediaTransactionCommitAttempt(
	current: MediaTransactionCommitAttempt | null,
	request: MediaTransactionCommitRequest,
	createKey: () => string = () => `media-transaction-${crypto.randomUUID()}`,
): MediaTransactionCommitAttempt {
	const signature = createMediaTransactionCommitSignature(request);
	if (current?.signature === signature) return current;
	if (current?.sent) throw new TypeError("已发送的媒体事务只能使用原请求和原幂等键重试。");
	const key = createKey();
	if (!IDEMPOTENCY_KEY.test(key)) throw new TypeError("媒体事务幂等键格式无效。");
	return { signature, key, sent: false };
}

export function markMediaTransactionCommitAttemptSent(
	attempt: MediaTransactionCommitAttempt,
): MediaTransactionCommitAttempt {
	return { ...attempt, sent: true };
}

export function createMediaTransactionCommitState(
	preview: MediaTransactionPreviewData | null = null,
): MediaTransactionCommitState {
	return { status: preview ? "preview-ready" : "idle", attempt: null, result: null };
}

export function beginMediaTransactionCommit(
	state: MediaTransactionCommitState,
	request: MediaTransactionCommitRequest,
	createKey?: () => string,
): MediaTransactionCommitState {
	if (state.status !== "preview-ready" && state.status !== "unknown") {
		throw new TypeError("当前媒体事务状态不能提交。");
	}
	const attempt = prepareMediaTransactionCommitAttempt(state.attempt, request, createKey);
	return {
		status: "committing",
		attempt: markMediaTransactionCommitAttemptSent(attempt),
		result: null,
	};
}

export function markMediaTransactionCommitUnknown(
	state: MediaTransactionCommitState,
): MediaTransactionCommitState {
	if (state.status !== "committing" || !state.attempt?.sent) {
		throw new TypeError("只有已发送的媒体事务可进入待确认状态。");
	}
	return { ...state, status: "unknown" };
}

export function applyMediaTransactionCommitError(
	state: MediaTransactionCommitState,
	kind: MediaTransactionCommitErrorKind,
): MediaTransactionCommitState {
	if (state.status !== "committing" || !state.attempt?.sent) {
		throw new TypeError("当前媒体事务没有已发送的提交请求。");
	}
	if (kind === "unknown" || kind === "in-progress" || kind === "retryable") {
		return markMediaTransactionCommitUnknown(state);
	}
	return {
		...state,
		status: kind === "confirmation" ? "preview-ready" : "idle",
	};
}

export function markMediaTransactionCommitConsumed(
	state: MediaTransactionCommitState,
	resultInput: unknown,
): MediaTransactionCommitState {
	if (state.status !== "committing") throw new TypeError("当前媒体事务没有提交中的请求。");
	return { ...state, status: "consumed", result: parseMediaTransactionCommitResult(resultInput) };
}

export function markMediaTransactionCommitRefreshFailed(
	state: MediaTransactionCommitState,
): MediaTransactionCommitState {
	if (state.status !== "consumed" || !state.result) {
		throw new TypeError("只有已成功提交的媒体事务可进入刷新失败状态。");
	}
	return { ...state, status: "refresh-failed" };
}

export function markMediaTransactionCommitRefreshed(
	state: MediaTransactionCommitState,
): MediaTransactionCommitState {
	if (state.status !== "refresh-failed" || !state.result) {
		throw new TypeError("只有刷新失败的已提交媒体事务可完成恢复。");
	}
	return { status: "consumed", attempt: null, result: state.result };
}

export function isMediaTransactionCommitLocked(status: MediaTransactionCommitStatus): boolean {
	return status === "committing" || status === "unknown" || status === "refresh-failed";
}

export function mapMediaTransactionCommitError(
	input: unknown,
	status: number,
): { kind: MediaTransactionCommitErrorKind; message: string } {
	const parsed = apiErrorSchema.safeParse(input);
	const code = parsed.success ? parsed.data.error.code : "";
	if (code === "MEDIA_PREVIEW_EXPIRED") {
		return { kind: "expired", message: "影响预览已过期，请重新生成 Preview。" };
	}
	if (code === "MEDIA_PREVIEW_IN_PROGRESS") {
		return { kind: "in-progress", message: "提交仍在处理中，只能使用原幂等键重试确认结果。" };
	}
	if (code === "MEDIA_CONFIRMATION_INVALID") {
		return { kind: "confirmation", message: "确认内容不精确，请按 Preview 要求重新确认。" };
	}
	if (code === "CONFLICT" || code === "IDEMPOTENCY_CONFLICT" || status === 409) {
		return { kind: "conflict", message: "Preview 或仓库版本已冲突，请重新加载后生成 Preview。" };
	}
	if (code === "COMMIT_STATUS_UNKNOWN") {
		return { kind: "unknown", message: "提交结果待确认，只能使用原幂等键重试，禁止重新提交。" };
	}
	return {
		kind: "retryable",
		message:
			code === "MEDIA_TRANSACTION_UNAVAILABLE"
				? "媒体事务服务暂时不可用，请使用原幂等键重试。"
				: "媒体事务提交失败，请使用原幂等键重试。",
	};
}
