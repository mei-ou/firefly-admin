import { describe, expect, it, vi } from "vitest";
import {
	commitStagedMedia,
	isR2StagingUnavailable,
	MediaStagingApiError,
	parseCommittedMediaPayload,
	parseMediaStagingApiError,
	parseMediaStagingPayload,
	stageMediaAsset,
} from "../../src/components/articles/media-staging";

const asset = {
	id: "123e4567-e89b-12d3-a456-426614174000",
	objectKey: "staging/2026/08/123e4567-e89b-12d3-a456-426614174000.png",
	filename: "cover.png",
	contentType: "image/png",
	size: 8,
	etag: "etag-1",
	uploadedAt: "2026-08-13T10:00:00.000Z",
} as const;

const attachmentAsset = {
	...asset,
	objectKey: "staging/2026/08/123e4567-e89b-12d3-a456-426614174000.pdf",
	filename: "guide.pdf",
	contentType: "application/pdf",
} as const;

describe("浏览器媒体暂存边界", () => {
	it("严格解析合法响应并拒绝未知字段和危险对象键", () => {
		expect(parseMediaStagingPayload({ asset })).toEqual(asset);
		expect(() => parseMediaStagingPayload({ asset: { ...asset, bucket: "secret" } })).toThrow();
		expect(() =>
			parseMediaStagingPayload({ asset: { ...asset, objectKey: "../secret/cover.png" } }),
		).toThrow();
	});

	it("使用统一错误消息并为非 JSON 响应提供稳定降级", () => {
		expect(
			parseMediaStagingApiError(
				{ error: { code: "RATE_LIMITED", message: "请求过于频繁，请稍后再试。" } },
				429,
			),
		).toBe("请求过于频繁，请稍后再试。");
		expect(parseMediaStagingApiError(null, 413)).toBe("图片不能超过 1 MiB，附件不能超过 4 MiB。");
		expect(parseMediaStagingApiError(null, 500)).toBe("媒体资源处理失败，请稍后重试。");
	});

	it("严格接受 PDF、拒绝 ZIP，并保持图片与附件的独立大小上限", () => {
		expect(parseMediaStagingPayload({ asset: attachmentAsset })).toEqual(attachmentAsset);
		const zipAsset = {
			...attachmentAsset,
			objectKey: "staging/2026/08/123e4567-e89b-12d3-a456-426614174000.zip",
			filename: "source.zip",
			contentType: "application/zip",
		} as const;
		expect(() => parseMediaStagingPayload({ asset: zipAsset })).toThrow();
		expect(() =>
			parseMediaStagingPayload({ asset: { ...asset, size: 2 * 1024 * 1024 + 1 } }),
		).toThrow();
		expect(() =>
			parseMediaStagingPayload({ asset: { ...attachmentAsset, size: 4 * 1024 * 1024 + 1 } }),
		).toThrow();
	});

	it("只把服务端明确报告的 R2 不可用错误标记为本地降级候选", async () => {
		const unavailableFetch = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: { code: "UPSTREAM_UNAVAILABLE", message: "媒体暂存服务暂时不可用。" },
				}),
				{ status: 503, headers: { "Content-Type": "application/json" } },
			),
		);
		const file = new File([new Uint8Array([1])], "cover.png", { type: "image/png" });

		const error = await stageMediaAsset(file, { fetch: unavailableFetch }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(MediaStagingApiError);
		expect(isR2StagingUnavailable(error)).toBe(true);
		expect(
			isR2StagingUnavailable(
				new MediaStagingApiError("请求保护服务暂时不可用。", 503, "RATE_LIMIT_UNAVAILABLE"),
			),
		).toBe(false);
		expect(isR2StagingUnavailable(new TypeError("Failed to fetch"))).toBe(false);
	});

	it("严格解析转存响应并拒绝危险的文章相对路径", () => {
		const committed = {
			storageSlug: "hello-world",
			repositoryPath: "src/content/posts/hello-world/cover-123e4567e89b.png",
			relativePath: "./cover-123e4567e89b.png",
			commitSha: "a".repeat(40),
			commitUrl: `https://github.com/example/blog/commit/${"a".repeat(40)}`,
			fileSha: "b".repeat(40),
		};
		expect(parseCommittedMediaPayload({ asset: committed })).toEqual(committed);
		expect(() =>
			parseCommittedMediaPayload({ asset: { ...committed, relativePath: "../secret.png" } }),
		).toThrow();
	});

	it("提交只含 file 的 multipart 请求且不手工设置 Content-Type", async () => {
		const signal = new AbortController().signal;
		const fetchImplementation = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ asset }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const file = new File([new Uint8Array([1])], "cover.png", { type: "image/png" });

		await expect(stageMediaAsset(file, { signal, fetch: fetchImplementation })).resolves.toEqual(
			asset,
		);
		const [url, init] = fetchImplementation.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/media/staging");
		expect(init.method).toBe("POST");
		expect(init.signal).toBe(signal);
		expect(init.headers).toEqual({ Accept: "application/json", "X-Firefly-Admin": "1" });
		expect(init.body).toBeInstanceOf(FormData);
		expect(Array.from((init.body as FormData).keys())).toEqual(["file"]);
	});

	it("附件上传同样只发送单个 file 字段并执行格式和 4 MiB 前置边界", async () => {
		const fetchImplementation = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ asset: attachmentAsset }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const file = new File([new Uint8Array([1])], "guide.pdf", { type: "application/pdf" });

		await expect(stageMediaAsset(file, { fetch: fetchImplementation })).resolves.toEqual(
			attachmentAsset,
		);
		const [, init] = fetchImplementation.mock.calls[0] as [string, RequestInit];
		expect(init.body).toBeInstanceOf(FormData);
		expect((init.body as FormData).get("file")).toBe(file);
		await expect(
			stageMediaAsset(
				new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "archive.zip", {
					type: "application/zip",
				}),
				{ fetch: fetchImplementation },
			),
		).rejects.toThrow("ZIP 附件默认关闭");
		await expect(
			stageMediaAsset(
				new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])], "report.pdf.exe", {
					type: "application/pdf",
				}),
				{ fetch: fetchImplementation },
			),
		).rejects.toThrow("双扩展名");
		expect(fetchImplementation).toHaveBeenCalledTimes(1);
	});

	it("上传前继续拒绝超过 1 MiB 的图片", async () => {
		const fetchImplementation = vi.fn();
		await expect(
			stageMediaAsset(
				new File([new Uint8Array(1 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
				{ fetch: fetchImplementation },
			),
		).rejects.toThrow("图片必须非空且不能超过 1 MiB。");
		expect(fetchImplementation).not.toHaveBeenCalled();
	});

	it("使用 JSON、幂等键和 AbortSignal 请求安全转存", async () => {
		const committed = {
			storageSlug: "hello-world",
			repositoryPath: "src/content/posts/hello-world/cover-123e4567e89b.png",
			relativePath: "./cover-123e4567e89b.png",
			commitSha: "a".repeat(40),
			commitUrl: `https://github.com/example/blog/commit/${"a".repeat(40)}`,
			fileSha: "b".repeat(40),
		};
		const signal = new AbortController().signal;
		const fetchImplementation = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ asset: committed }), {
				status: 201,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(
			commitStagedMedia(
				{ storageSlug: "hello-world", asset },
				{
					signal,
					fetch: fetchImplementation,
					idempotencyKey: "media-commit-key-0001",
				},
			),
		).resolves.toEqual(committed);
		const [url, init] = fetchImplementation.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("/api/media/staging/commit");
		expect(init.method).toBe("POST");
		expect(init.signal).toBe(signal);
		expect(init.headers).toEqual({
			Accept: "application/json",
			"Content-Type": "application/json",
			"Idempotency-Key": "media-commit-key-0001",
			"X-Firefly-Admin": "1",
		});
		expect(JSON.parse(String(init.body))).toEqual({
			storageSlug: "hello-world",
			objectKey: asset.objectKey,
			etag: asset.etag,
		});
	});
});
