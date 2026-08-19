import { describe, expect, it, vi } from "vitest";
import { handleStageMediaAsset } from "../../src/modules/media/api/stage-media-asset";
import type { R2BucketBinding, RuntimeEnv } from "../../src/types/env";

const principal = { sub: "subject-1", email: "admin@example.com" };
const now = new Date("2026-08-13T09:00:00.000Z");
const id = "123e4567-e89b-12d3-a456-426614174000";
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const webpBytes = new Uint8Array([
	0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);
const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);
const zipBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function createBucket(): { bucket: R2BucketBinding; put: ReturnType<typeof vi.fn> } {
	const put = vi.fn().mockResolvedValue({
		key: `staging/2026/08/${id}.png`,
		size: 4,
		etag: "etag-1",
		version: "version-1",
	});
	return {
		bucket: {
			put,
			get: vi.fn().mockResolvedValue(null),
			list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		put,
	};
}

function createRequest(file: File, extraFields: Record<string, string> = {}): Request {
	const body = new FormData();
	body.set("file", file);
	for (const [key, value] of Object.entries(extraFields)) body.set(key, value);
	return new Request("https://admin.example.com/api/media/staging", { method: "POST", body });
}

function createEnv(
	bucket: R2BucketBinding | undefined,
	limiter = vi.fn().mockResolvedValue({ success: true }),
): RuntimeEnv {
	return {
		...(bucket === undefined ? {} : { MEDIA_STAGING_BUCKET: bucket }),
		RATE_LIMITER: { limit: limiter },
	};
}

describe("R2 媒体暂存 API", () => {
	it("使用服务端对象键暂存安全图片并返回受限元数据", async () => {
		const { bucket, put } = createBucket();
		const limiter = vi.fn().mockResolvedValue({ success: true });
		const auditWriter = vi.fn();
		const response = await handleStageMediaAsset(
			{
				request: createRequest(new File([pngBytes], "封面/图.png", { type: "image/png" })),
				requestId: "req-upload",
				principal,
				env: createEnv(bucket, limiter),
			},
			{ createId: () => id, now: () => now, auditWriter },
		);

		expect(response.status).toBe(201);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(limiter).toHaveBeenCalledWith({ key: "subject-1:image-upload" });
		expect(put).toHaveBeenCalledTimes(1);
		const [objectKey, body, options] = put.mock.calls[0] as [
			string,
			ReadableStream,
			Record<string, unknown>,
		];
		expect(objectKey).toBe(`staging/2026/08/${id}.png`);
		expect(body).toBeInstanceOf(ReadableStream);
		expect(options).toEqual({
			httpMetadata: { contentType: "image/png" },
			customMetadata: { originalFilename: "封面_图.png", uploaderSubject: "subject-1" },
		});
		await expect(response.json()).resolves.toEqual({
			asset: {
				id,
				objectKey,
				filename: "封面_图.png",
				contentType: "image/png",
				size: 4,
				etag: "etag-1",
				uploadedAt: now.toISOString(),
			},
		});
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({ action: "media.stage-upload", target: objectKey }),
		);
	});

	it("在读取正文前拒绝未认证和缺失绑定，并阻止无效文件写入 R2", async () => {
		const { bucket, put } = createBucket();
		const limiter = vi.fn().mockResolvedValue({ success: true });
		const png = new File([pngBytes], "image.png", { type: "image/png" });
		const cases = [
			{
				principal: undefined,
				env: createEnv(bucket, limiter),
				request: createRequest(png),
				status: 401,
			},
			{
				principal,
				env: createEnv(undefined, limiter),
				request: createRequest(png),
				status: 503,
			},
			{
				principal,
				env: createEnv(bucket, limiter),
				request: createRequest(new File(["<svg/>"], "unsafe.svg", { type: "image/svg+xml" })),
				status: 415,
			},
			{
				principal,
				env: createEnv(bucket, limiter),
				request: createRequest(new File(["not-a-png"], "fake.png", { type: "image/png" })),
				status: 415,
			},
			{
				principal,
				env: createEnv(bucket, limiter),
				request: createRequest(png, { unexpected: "field" }),
				status: 400,
			},
		];

		for (const item of cases) {
			await expect(
				handleStageMediaAsset(
					{
						request: item.request,
						requestId: "req-rejected",
						principal: item.principal,
						env: item.env,
					},
					{ createId: () => id, now: () => now },
				),
			).rejects.toMatchObject({ status: item.status });
		}
		expect(limiter).toHaveBeenCalledTimes(3);
		expect(put).not.toHaveBeenCalled();
	});

	it("严格匹配附件扩展名、MIME 和 magic bytes，并默认拒绝 ZIP", async () => {
		const { bucket, put } = createBucket();
		const rejectedFiles = [
			new File([pdfBytes], "report.pdf.exe", { type: "application/pdf" }),
			new File([pdfBytes], "report.png", { type: "application/pdf" }),
			new File([pdfBytes], "report", { type: "application/pdf" }),
			new File([zipBytes], "archive.zip", { type: "application/zip" }),
			new File([zipBytes], "archive.pdf", { type: "application/pdf" }),
		];
		for (const file of rejectedFiles) {
			await expect(
				handleStageMediaAsset(
					{
						request: createRequest(file),
						requestId: "req-attachment-rejected",
						principal,
						env: createEnv(bucket),
					},
					{ createId: () => id, now: () => now },
				),
			).rejects.toMatchObject({ status: 415 });
		}
		expect(put).not.toHaveBeenCalled();
	});

	it("接受扩展名、MIME 和签名一致的 PDF 附件", async () => {
		const { bucket, put } = createBucket();
		put.mockResolvedValue({
			key: `staging/2026/08/${id}.pdf`,
			size: pdfBytes.byteLength,
			etag: "etag-pdf",
			version: "version-pdf",
		});
		const response = await handleStageMediaAsset(
			{
				request: createRequest(new File([pdfBytes], "guide.pdf", { type: "application/pdf" })),
				requestId: "req-pdf",
				principal,
				env: createEnv(bucket),
			},
			{ createId: () => id, now: () => now },
		);
		expect(response.status).toBe(201);
		expect(put).toHaveBeenCalledWith(
			`staging/2026/08/${id}.pdf`,
			expect.any(ReadableStream),
			expect.objectContaining({ httpMetadata: { contentType: "application/pdf" } }),
		);
	});

	it("限流失败或 R2 写入失败时不返回暂存成功", async () => {
		const file = new File([webpBytes], "image.webp", { type: "image/webp" });
		const rateLimitedBucket = createBucket();
		await expect(
			handleStageMediaAsset({
				request: createRequest(file),
				requestId: "req-rate-limited",
				principal,
				env: createEnv(rateLimitedBucket.bucket, vi.fn().mockResolvedValue({ success: false })),
			}),
		).rejects.toMatchObject({ status: 429, code: "RATE_LIMITED" });
		expect(rateLimitedBucket.put).not.toHaveBeenCalled();

		const failingPut = vi.fn().mockRejectedValue(new Error("internal bucket detail"));
		await expect(
			handleStageMediaAsset(
				{
					request: createRequest(file),
					requestId: "req-upstream-failed",
					principal,
					env: createEnv({
						put: failingPut,
						get: vi.fn().mockResolvedValue(null),
						list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
						delete: vi.fn().mockResolvedValue(undefined),
					}),
				},
				{ createId: () => id, now: () => now },
			),
		).rejects.toMatchObject({
			status: 503,
			code: "UPSTREAM_UNAVAILABLE",
			message: "媒体暂存服务暂时不可用。",
		});
	});
});

describe("staging size boundary", () => {
	it("rejects images larger than the atomic image limit", async () => {
		const { bucket } = createBucket();
		const oversizedPng = new File(
			[new Uint8Array([...pngBytes, ...new Uint8Array(2 * 1024 * 1024)])],
			"large.png",
			{ type: "image/png" },
		);
		await expect(
			handleStageMediaAsset({
				request: createRequest(oversizedPng),
				requestId: "req-too-large",
				principal,
				env: createEnv(bucket),
			}),
		).rejects.toMatchObject({ status: 413 });
		expect(bucket.put).not.toHaveBeenCalled();
	});
});
