import { describe, expect, it } from "vitest";
import { createIdempotencyScope, parseIdempotencyKey } from "../../src/core/security/idempotency";

describe("幂等键契约", () => {
	it("接受长度足够且字符安全的键", () => {
		const request = new Request("https://admin.example.com/api/articles", {
			headers: { "Idempotency-Key": "publish_01JABCDEF0123456789" },
		});
		expect(parseIdempotencyKey(request)).toBe("publish_01JABCDEF0123456789");
	});

	it("拒绝缺失的幂等键", () => {
		const request = new Request("https://admin.example.com/api/articles");
		expect(() => parseIdempotencyKey(request)).toThrow();
	});

	it("拒绝过短或含白名单外字符的键", () => {
		// Fetch API 会先拒绝换行等控制字符；斜杠可进入应用层，但仍必须被键白名单拒绝。
		for (const key of ["short", "valid-prefix/forged-entry"]) {
			const request = new Request("https://admin.example.com/api/articles", {
				headers: { "Idempotency-Key": key },
			});
			expect(() => parseIdempotencyKey(request)).toThrow();
		}
	});

	it("按主体和操作隔离同一个客户端键", () => {
		const key = "publish_01JABCDEF0123456789";
		expect(createIdempotencyScope("user-1", "publish", key)).not.toBe(
			createIdempotencyScope("user-2", "publish", key),
		);
	});
});
