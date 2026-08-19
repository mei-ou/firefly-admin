import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import { createRateLimitKey, enforceRateLimit } from "../../src/core/security/rate-limit";

describe("Workers 限流边界", () => {
	it("使用验证主体与操作生成隔离键", () => {
		expect(createRateLimitKey("user-1", "article-publish")).toBe("user-1:article-publish");
	});

	it("Binding 缺失时敏感操作失败关闭", async () => {
		await expect(enforceRateLimit(undefined, "user-1", "article-publish")).rejects.toMatchObject({
			status: 503,
			code: "RATE_LIMIT_UNAVAILABLE",
		});
	});

	it("Binding 拒绝时返回 429", async () => {
		const binding = { limit: vi.fn().mockResolvedValue({ success: false }) };
		await expect(enforceRateLimit(binding, "user-1", "image-upload")).rejects.toMatchObject({
			status: 429,
			code: "RATE_LIMITED",
		});
	});

	it("Binding 异常不会绕过保护", async () => {
		const binding = { limit: vi.fn().mockRejectedValue(new Error("upstream failure")) };
		await expect(enforceRateLimit(binding, "user-1", "article-draft")).rejects.toBeInstanceOf(
			ApiError,
		);
	});

	it("成功时将完整隔离键传给 Binding", async () => {
		const limit = vi.fn().mockResolvedValue({ success: true });
		await enforceRateLimit({ limit }, "subject-2", "deployment-read");
		expect(limit).toHaveBeenCalledWith({ key: "subject-2:deployment-read" });
	});
});
