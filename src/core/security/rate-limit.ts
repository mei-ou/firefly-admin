import type { RateLimitBinding } from "../../types/env";
import { ApiError } from "../http/errors";

export type RateLimitOperation =
	| "articles-read"
	| "article-assets-read"
	| "article-draft"
	| "article-publish"
	| "article-delete"
	| "media-transaction-preview"
	| "media-transaction-targets"
	| "media-transaction-commit"
	| "image-upload"
	| "image-commit"
	| "deployment-read";

export function createRateLimitKey(subject: string, operation: RateLimitOperation): string {
	return `${subject}:${operation}`;
}

/**
 * 使用“已验证主体 + 操作”作为限流键执行 Workers Rate Limiting。
 *
 * Workers 限流用于防滥用而非权限判断，也不承诺全球强一致计数；但敏感操作在
 * Binding 缺失或调用失败时仍必须失败关闭，不能绕过保护继续访问上游。
 */
export async function enforceRateLimit(
	binding: RateLimitBinding | undefined,
	subject: string,
	operation: RateLimitOperation,
): Promise<void> {
	if (!binding) {
		// 限流不是强一致权限系统，但 binding 缺失时敏感请求仍必须失败关闭。
		throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "请求保护服务暂时不可用。");
	}

	let result: { success: boolean };
	try {
		result = await binding.limit({ key: createRateLimitKey(subject, operation) });
	} catch {
		throw new ApiError(503, "RATE_LIMIT_UNAVAILABLE", "请求保护服务暂时不可用。");
	}

	if (!result.success) {
		throw new ApiError(429, "RATE_LIMITED", "请求过于频繁，请稍后再试。");
	}
}
