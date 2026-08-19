import { describe, expect, it, vi } from "vitest";
import { sanitizeAuditValue, writeAuditEvent } from "../../src/core/audit/audit-log";

describe("结构化审计日志", () => {
	it("递归脱敏认证和正文类字段", () => {
		const sanitized = sanitizeAuditValue({
			token: "secret-token",
			metadata: {
				password: "secret-password",
				content: "private article",
				safe: "kept",
			},
		});

		expect(sanitized).toEqual({
			token: "[REDACTED]",
			metadata: {
				password: "[REDACTED]",
				content: "[REDACTED]",
				safe: "kept",
			},
		});
	});

	it("保留审计所需的非敏感追踪字段", () => {
		const writer = vi.fn();
		writeAuditEvent(
			{
				requestId: "req_example123",
				subject: "subject-1",
				action: "POST /api/articles",
				outcome: "failure",
				errorCode: "RATE_LIMITED",
				timestamp: "2026-08-12T00:00:00.000Z",
				rateLimited: true,
			},
			writer,
		);

		expect(writer).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "req_example123",
				subject: "subject-1",
				rateLimited: true,
			}),
		);
	});
});
