import { normalizeError } from "./errors";
import { applySecurityHeaders } from "./security-headers";

export function jsonResponse(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

/**
 * 生成稳定、无内部堆栈的统一错误响应，并始终带上请求追踪 ID 和安全响应头。
 */
export function errorResponse(error: unknown, requestId: string): Response {
	const normalized = normalizeError(error);
	const response = jsonResponse(
		{
			error: {
				code: normalized.code,
				message: normalized.message,
				requestId,
			},
		},
		normalized.status,
	);
	response.headers.set("X-Request-Id", requestId);
	return applySecurityHeaders(response);
}
