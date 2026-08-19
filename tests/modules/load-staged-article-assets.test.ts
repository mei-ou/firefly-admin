import { describe, expect, it, vi } from "vitest";
import { parseStagedArticleAssetManifest } from "../../src/modules/media/article-asset-manifest";
import { deriveStagedArticleAssetPath } from "../../src/modules/media/media-config";
import { loadStagedArticleAssets } from "../../src/modules/media/services/load-staged-article-assets";
import type { R2ObjectBodyBinding } from "../../src/types/env";

const id = "123e4567-e89b-12d3-a456-426614174000";
const objectKey = `staging/2026/08/${id}.png`;
const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pathConfig = {
	contentRoot: "src/content/posts",
	usePageBundle: true,
	entryFilename: "index.md",
};

function createObject(overrides: Partial<R2ObjectBodyBinding> = {}): R2ObjectBodyBinding {
	return {
		key: objectKey,
		size: pngBytes.byteLength,
		etag: "etag-1",
		uploaded: new Date("2026-08-14T00:00:00.000Z"),
		httpMetadata: { contentType: "image/png" },
		customMetadata: { originalFilename: "My Cover (最终).png", uploaderSubject: "subject-1" },
		arrayBuffer: async () => pngBytes.slice().buffer,
		...overrides,
	};
}

function createManifest() {
	return parseStagedArticleAssetManifest({
		version: 1,
		assets: [
			{
				version: 1,
				assetId: id,
				objectKey,
				etag: "etag-1",
				originalFilename: "client-name.png",
				contentType: "image/png",
				size: pngBytes.byteLength,
				role: "inline",
			},
		],
	});
}

describe("文章资源最终路径契约", () => {
	it("浏览器与服务端可从服务端身份稳定推导安全相对路径", () => {
		expect(
			deriveStagedArticleAssetPath({
				assetId: id,
				objectKey,
				originalFilename: "My Cover (最终).png",
			}),
		).toEqual({
			finalFilename: "my-cover-123e4567e89b.png",
			relativePath: "./my-cover-123e4567e89b.png",
		});
		expect(
			deriveStagedArticleAssetPath({ assetId: id, objectKey, originalFilename: "最终.png" }),
		).toEqual({
			finalFilename: "asset-123e4567e89b.png",
			relativePath: "./asset-123e4567e89b.png",
		});
		expect(() =>
			deriveStagedArticleAssetPath({
				assetId: "abcdefab-cdef-abcd-efab-cdefabcdefab",
				objectKey,
				originalFilename: "cover.png",
			}),
		).toThrow("标识无效");
	});
});

describe("文章资源 R2 最终复核", () => {
	it("从 R2 可信元数据重算文件名、路径与实际字节", async () => {
		const get = vi.fn().mockResolvedValue(createObject());
		const result = await loadStagedArticleAssets(
			{ storageSlug: "hello-world", subject: "subject-1", manifest: createManifest() },
			{ bucket: { get }, pathConfig },
		);

		expect(get).toHaveBeenCalledWith(objectKey);
		expect(result).toEqual([
			{
				assetId: id,
				objectKey,
				finalFilename: "my-cover-123e4567e89b.png",
				relativePath: "./my-cover-123e4567e89b.png",
				repositoryPath: "src/content/posts/hello-world/my-cover-123e4567e89b.png",
				contentType: "image/png",
				size: pngBytes.byteLength,
				role: "inline",
				content: pngBytes,
			},
		]);
	});

	it("拒绝旧 ETag、异主体、MIME 欺骗、大小变化和损坏内容", async () => {
		const cases: Array<{ object: R2ObjectBodyBinding | null; status: number }> = [
			{ object: createObject({ etag: "changed" }), status: 409 },
			{ object: createObject({ customMetadata: { uploaderSubject: "subject-2" } }), status: 404 },
			{ object: createObject({ httpMetadata: { contentType: "image/jpeg" } }), status: 415 },
			{ object: createObject({ size: pngBytes.byteLength + 1 }), status: 413 },
			{
				object: createObject({ arrayBuffer: async () => new TextEncoder().encode("fake").buffer }),
				status: 415,
			},
			{ object: null, status: 404 },
		];

		for (const item of cases) {
			await expect(
				loadStagedArticleAssets(
					{ storageSlug: "hello-world", subject: "subject-1", manifest: createManifest() },
					{ bucket: { get: vi.fn().mockResolvedValue(item.object) }, pathConfig },
				),
			).rejects.toMatchObject({ status: item.status });
		}
	});

	it("最终 Commit 前再次拒绝 R2 文件名与 MIME 不一致或双扩展伪装", async () => {
		for (const originalFilename of ["cover.jpg", "cover.png.exe", "cover"]) {
			await expect(
				loadStagedArticleAssets(
					{ storageSlug: "hello-world", subject: "subject-1", manifest: createManifest() },
					{
						bucket: {
							get: vi.fn().mockResolvedValue(
								createObject({
									customMetadata: { originalFilename, uploaderSubject: "subject-1" },
								}),
							),
						},
						pathConfig,
					},
				),
			).rejects.toMatchObject({ status: 415 });
		}
	});

	it("R2 读取异常失败关闭且不返回部分清单", async () => {
		await expect(
			loadStagedArticleAssets(
				{ storageSlug: "hello-world", subject: "subject-1", manifest: createManifest() },
				{ bucket: { get: vi.fn().mockRejectedValue(new Error("bucket detail")) }, pathConfig },
			),
		).rejects.toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE" });
	});
});
