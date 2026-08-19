export const errorCodes = [
	"AUTH_REQUIRED",
	"AUTH_INVALID",
	"AUTH_FORBIDDEN",
	"CONFIGURATION_ERROR",
	"ORIGIN_FORBIDDEN",
	"INVALID_REQUEST",
	"RATE_LIMITED",
	"RATE_LIMIT_UNAVAILABLE",
	"NOT_FOUND",
	"ARTICLE_INVALID",
	"CONFLICT",
	"IDEMPOTENCY_CONFLICT",
	"IDEMPOTENCY_IN_PROGRESS",
	"IDEMPOTENCY_UNAVAILABLE",
	"MEDIA_PREVIEW_REQUIRED",
	"MEDIA_PREVIEW_UNAVAILABLE",
	"MEDIA_PREVIEW_CONFLICT",
	"MEDIA_PREVIEW_EXPIRED",
	"MEDIA_PREVIEW_IN_PROGRESS",
	"MEDIA_CONFIRMATION_INVALID",
	"MEDIA_TRANSACTION_UNAVAILABLE",
	"MEDIA_REFERENCE_ANALYSIS_INCOMPLETE",
	"MEDIA_REFERENCE_CLOSURE_INCOMPLETE",
	"MEDIA_RESOURCE_BLOCKED",
	"COMMIT_STATUS_UNKNOWN",
	"UPSTREAM_ERROR",
	"UPSTREAM_UNAVAILABLE",
	"INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

/**
 * 可安全返回客户端的预期 API 错误。
 * 未知异常不得直接透传 message 或 stack，而应由 normalizeError 归一化。
 */
export class ApiError extends Error {
	readonly status: number;
	readonly code: ErrorCode;

	constructor(status: number, code: ErrorCode, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

export function normalizeError(error: unknown): ApiError {
	if (error instanceof ApiError) {
		return error;
	}

	return new ApiError(500, "INTERNAL_ERROR", "服务器发生内部错误。");
}
