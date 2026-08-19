import { describe, expect, it } from "vitest";
import { parseStagedArticleAssetManifest } from "../../src/modules/media/article-asset-manifest";

function createAsset(
	overrides: Partial<{
		version: 1;
		assetId: string;
		objectKey: string;
		etag: string;
		originalFilename: string;
		contentType: "application/pdf" | "image/png";
		size: number;
		role: "attachment" | "cover" | "inline";
	}> = {},
) {
	const assetId = overrides.assetId ?? "123e4567-e89b-12d3-a456-426614174000";
	const contentType = overrides.contentType ?? "image/png";
	const extension = contentType === "application/pdf" ? "pdf" : "png";
	return {
		version: 1 as const,
		assetId,
		objectKey: overrides.objectKey ?? `staging/2026/08/${assetId}.${extension}`,
		etag: "etag-1",
		originalFilename: contentType === "application/pdf" ? "guide.pdf" : "cover.png",
		contentType,
		size: 1024,
		role: contentType === "application/pdf" ? ("attachment" as const) : ("inline" as const),
		...overrides,
	};
}

describe("版本化文章资源清单", () => {
	it("严格解析并按 objectKey 规范排序", () => {
		const second = createAsset({
			assetId: "223e4567-e89b-12d3-a456-426614174000",
			objectKey: "staging/2026/08/223e4567-e89b-12d3-a456-426614174000.png",
		});
		const first = createAsset();
		const result = parseStagedArticleAssetManifest({ version: 1, assets: [second, first] });
		expect(result.assets.map((asset) => asset.objectKey)).toEqual([
			first.objectKey,
			second.objectKey,
		]);
	});

	it("拒绝未知字段、版本漂移和客户端最终路径字段", () => {
		expect(() => parseStagedArticleAssetManifest({ version: 2, assets: [] })).toThrow(
			"资源清单无效",
		);
		expect(() =>
			parseStagedArticleAssetManifest({
				version: 1,
				assets: [{ ...createAsset(), relativePath: "./attacker.png" }],
			}),
		).toThrow("资源清单无效");
	});

	it("拒绝重复对象、超量资源和不兼容用途", () => {
		const asset = createAsset();
		expect(() => parseStagedArticleAssetManifest({ version: 1, assets: [asset, asset] })).toThrow(
			"重复对象",
		);
		expect(() =>
			parseStagedArticleAssetManifest({
				version: 1,
				assets: Array.from({ length: 6 }, (_, index) => {
					const id = `${index.toString(16).padStart(16, "0")}abcdef12`;
					return createAsset({ assetId: id, objectKey: `staging/2026/08/${id}.png` });
				}),
			}),
		).toThrow("资源清单无效");
		expect(() =>
			parseStagedArticleAssetManifest({
				version: 1,
				assets: [createAsset({ contentType: "application/pdf", role: "cover" })],
			}),
		).toThrow("附件不能作为文章图片");
		const secondCover = createAsset({
			assetId: "223e4567-e89b-12d3-a456-426614174000",
			objectKey: "staging/2026/08/223e4567-e89b-12d3-a456-426614174000.png",
			role: "cover",
		});
		expect(() =>
			parseStagedArticleAssetManifest({
				version: 1,
				assets: [createAsset({ role: "cover" }), secondCover],
			}),
		).toThrow("最多只能有一个封面");
	});

	it("执行图片 1 MiB、附件 4 MiB 和总量 5 MiB 上限", () => {
		expect(() =>
			parseStagedArticleAssetManifest({
				version: 1,
				assets: [createAsset({ size: 1 * 1024 * 1024 + 1 })],
			}),
		).toThrow("单张图片不能超过 1 MiB");
		expect(() =>
			parseStagedArticleAssetManifest({
				version: 1,
				assets: [
					createAsset({
						contentType: "application/pdf",
						size: 4 * 1024 * 1024 + 1,
						role: "attachment",
					}),
				],
			}),
		).toThrow("资源清单无效");

		const assets = Array.from({ length: 2 }, (_, index) => {
			const id = `${index.toString(16).padStart(16, "0")}abcdef12`;
			return createAsset({
				assetId: id,
				objectKey: `staging/2026/08/${id}.pdf`,
				contentType: "application/pdf",
				size: 3 * 1024 * 1024,
				role: "attachment",
			});
		});
		expect(() => parseStagedArticleAssetManifest({ version: 1, assets })).toThrow(
			"总量不能超过 5 MiB",
		);
	});
});
