import { ApiError } from "../http/errors";

export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

/**
 * 校验写请求的幂等键，但不在 P0 中伪造持久化语义。
 * P1 接入真实发布操作时，作用域会与执行结果一起存入具备 TTL 的服务端存储。
 */
export function parseIdempotencyKey(request: Request): string {
	const key = request.headers.get("Idempotency-Key")?.trim() ?? "";

	// 长随机键可避免跨用户碰撞；字符白名单防止键污染日志或后续存储命名空间。
	if (!IDEMPOTENCY_KEY_PATTERN.test(key)) {
		throw new ApiError(400, "INVALID_REQUEST", "Idempotency-Key 格式无效。");
	}

	return key;
}

export function createIdempotencyScope(subject: string, operation: string, key: string): string {
	return `${subject}:${operation}:${key}`;
}
