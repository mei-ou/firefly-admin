import { describe, expect, it } from "vitest";
import { ApiError, normalizeError } from "../../src/core/http/errors";
import { errorResponse, jsonResponse } from "../../src/core/http/response";
import {
	applyDocumentSecurityHeaders,
	applySecurityHeaders,
	securityHeaders,
} from "../../src/core/http/security-headers";

describe("统一 HTTP 响应", () => {
	it("JSON 响应禁止缓存", async () => {
		const response = jsonResponse({ ok: true });
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ ok: true });
	});

	it("错误响应只暴露稳定字段", async () => {
		const response = errorResponse(
			new ApiError(403, "AUTH_FORBIDDEN", "当前身份无权访问。"),
			"req_example123",
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: {
				code: "AUTH_FORBIDDEN",
				message: "当前身份无权访问。",
				requestId: "req_example123",
			},
		});
	});

	it("未知异常归一化且不泄露堆栈", async () => {
		const normalized = normalizeError(new Error("GITHUB_TOKEN=secret"));
		expect(normalized.code).toBe("INTERNAL_ERROR");
		expect(normalized.message).not.toContain("secret");
	});

	it("应用完整安全响应头", () => {
		const response = applySecurityHeaders(new Response("ok"));
		for (const [name, value] of Object.entries(securityHeaders)) {
			expect(response.headers.get(name)).toBe(value);
		}
	});

	it("CSP 不允许通配脚本或 unsafe-eval", () => {
		const csp = securityHeaders["Content-Security-Policy"];
		expect(csp).not.toContain("script-src *");
		expect(csp).not.toContain("unsafe-eval");
		expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
		expect(csp).toContain("frame-ancestors 'none'");
	});

	it("HTML 响应仅按内容 Hash 放行 Astro 内联启动脚本", async () => {
		const source = "window.Astro = { load: true };";
		const response = await applyDocumentSecurityHeaders(
			new Response(`<html><head><script>${source}</script></head></html>`, {
				headers: { "Content-Type": "text/html; charset=utf-8" },
			}),
		);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
		const expectedHash = Buffer.from(digest).toString("base64");
		const csp = response.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain(`script-src 'self' 'sha256-${expectedHash}'`);
		expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
		expect(await response.text()).toContain(source);
	});

	it("外部脚本不生成多余 Hash", async () => {
		const response = await applyDocumentSecurityHeaders(
			new Response('<script type="module" src="/_astro/client.js"></script>', {
				headers: { "Content-Type": "text/html" },
			}),
		);
		expect(response.headers.get("Content-Security-Policy")).toBe(
			securityHeaders["Content-Security-Policy"],
		);
	});
});
