import { describe, expect, it, vi } from "vitest";
import {
	commitMediaTransaction,
	previewMediaTransaction,
} from "../../src/components/articles/media-transaction-client";

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

describe("媒体事务客户端", () => {
	it("Preview 固定安全请求头并返回响应与 unknown JSON", async () => {
		const payload = { version: 1, operation: "rename" };
		const response = jsonResponse({ preview: { previewId: "preview_1234567890abcdef" } });
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

		const result = await previewMediaTransaction(payload, fetchMock);

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(fetchMock).toHaveBeenCalledWith("/api/media/transactions/preview", {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"X-Firefly-Admin": "1",
			},
			body: JSON.stringify(payload),
		});
		expect(result).toEqual({
			response,
			body: { preview: { previewId: "preview_1234567890abcdef" } },
		});
	});

	it("Commit 固定安全请求头并携带经校验的 Idempotency-Key", async () => {
		const payload = {
			previewId: "preview_1234567890abcdef",
			confirmation: { kind: "button" },
		};
		const key = "media-key-1234567890";
		const response = jsonResponse({ transaction: { previewId: payload.previewId } });
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

		const result = await commitMediaTransaction(payload, key, fetchMock);

		expect(fetchMock).toHaveBeenCalledWith("/api/media/transactions/commit", {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"X-Firefly-Admin": "1",
				"Idempotency-Key": key,
			},
			body: JSON.stringify(payload),
		});
		expect(result.response).toBe(response);
		expect(result.body).toEqual({ transaction: { previewId: payload.previewId } });
	});

	it("Commit 在调用 fetch 前拒绝空白、控制字符和长度不足的 key", () => {
		for (const key of ["", "                ", "short-key", "media-key-123456\n7890"]) {
			const fetchMock = vi.fn<typeof fetch>();
			expect(() => commitMediaTransaction({}, key, fetchMock)).toThrow("媒体事务幂等键格式无效");
			expect(fetchMock).not.toHaveBeenCalled();
		}
	});

	it("JSON 解析失败时返回 null 且保留原 Response", async () => {
		const response = new Response("not-json", { status: 502 });
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);

		await expect(previewMediaTransaction({}, fetchMock)).resolves.toEqual({
			response,
			body: null,
		});
	});
});
