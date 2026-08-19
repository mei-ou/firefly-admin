import { ApiError } from "../http/errors";

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface WriteRequestPolicy {
	contentTypes: readonly ("application/json" | "multipart/form-data")[];
}

export function isWriteMethod(method: string): boolean {
	return WRITE_METHODS.has(method.toUpperCase());
}

/**
 * 对所有有副作用的方法执行同源与请求形态校验。
 *
 * Cloudflare Access Cookie 可能由浏览器自动携带，因此仅有身份验证仍不足以防 CSRF；
 * Origin、Fetch Metadata 和自定义头共同构成 P0 的写请求来源边界。
 */
export function enforceWriteRequestPolicy(
	request: Request,
	adminOrigin: string,
	policy: WriteRequestPolicy = { contentTypes: ["application/json"] },
): void {
	if (!isWriteMethod(request.method)) {
		return;
	}

	if (request.headers.get("Origin") !== adminOrigin) {
		throw new ApiError(403, "ORIGIN_FORBIDDEN", "请求来源不受信任。");
	}

	if (request.headers.get("Sec-Fetch-Site") !== "same-origin") {
		throw new ApiError(403, "ORIGIN_FORBIDDEN", "请求来源不受信任。");
	}

	if (request.headers.get("X-Firefly-Admin") !== "1") {
		throw new ApiError(400, "INVALID_REQUEST", "请求缺少管理端标识。");
	}

	const contentType = request.headers.get("Content-Type")?.toLowerCase() ?? "";
	const accepted = policy.contentTypes.some(
		(expected) => contentType === expected || contentType.startsWith(`${expected};`),
	);

	if (!accepted) {
		throw new ApiError(415, "INVALID_REQUEST", "请求内容类型不受支持。");
	}
}
