/**
 * 返回可安全写入日志和响应头的请求 ID。
 *
 * 只接受格式受限的上游 ID，避免攻击者借请求头向日志注入换行符或超长内容；
 * 不可信或缺失的值统一替换为服务端生成的随机 ID。
 */
export function createRequestId(
	request: Request,
	// Web Crypto 方法在 Workers 兼容运行时中要求正确的 this；用闭包调用而不是传递裸方法。
	randomId: () => string = () => crypto.randomUUID(),
): string {
	const candidate = request.headers.get("X-Request-Id");

	if (candidate && /^[A-Za-z0-9_-]{8,64}$/.test(candidate)) {
		return candidate;
	}

	return `req_${randomId().replaceAll("-", "")}`;
}
