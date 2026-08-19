import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import { enforceWriteRequestPolicy, isWriteMethod } from "../../src/core/security/origin-policy";

const origin = "https://admin.example.com";

function createWriteRequest(overrides: Record<string, string> = {}): Request {
	return new Request(`${origin}/api/articles`, {
		method: "POST",
		headers: {
			Origin: origin,
			"Sec-Fetch-Site": "same-origin",
			"Content-Type": "application/json; charset=utf-8",
			"X-Firefly-Admin": "1",
			...overrides,
		},
		body: "{}",
	});
}

describe("写请求来源策略", () => {
	it("识别所有有副作用的方法", () => {
		expect(["POST", "put", "Patch", "DELETE"].every(isWriteMethod)).toBe(true);
		expect(isWriteMethod("GET")).toBe(false);
	});

	it("放行合法同源 JSON 写请求", () => {
		expect(() => enforceWriteRequestPolicy(createWriteRequest(), origin)).not.toThrow();
	});

	it("读取请求不要求写请求头", () => {
		const request = new Request(`${origin}/api/articles`);
		expect(() => enforceWriteRequestPolicy(request, origin)).not.toThrow();
	});

	it("拒绝第三方 Origin", () => {
		expect(() =>
			enforceWriteRequestPolicy(createWriteRequest({ Origin: "https://evil.example" }), origin),
		).toThrow(ApiError);
	});

	it("拒绝跨站 Fetch Metadata", () => {
		expect(() =>
			enforceWriteRequestPolicy(createWriteRequest({ "Sec-Fetch-Site": "cross-site" }), origin),
		).toThrow(ApiError);
	});

	it("拒绝缺失管理端标识", () => {
		expect(() =>
			enforceWriteRequestPolicy(createWriteRequest({ "X-Firefly-Admin": "0" }), origin),
		).toThrow(ApiError);
	});

	it("拒绝错误 Content-Type", () => {
		expect(() =>
			enforceWriteRequestPolicy(createWriteRequest({ "Content-Type": "text/plain" }), origin),
		).toThrow(ApiError);
	});

	it("按路由策略放行 multipart 上传", () => {
		const request = createWriteRequest({
			"Content-Type": "multipart/form-data; boundary=firefly",
		});
		expect(() =>
			enforceWriteRequestPolicy(request, origin, { contentTypes: ["multipart/form-data"] }),
		).not.toThrow();
	});
});
