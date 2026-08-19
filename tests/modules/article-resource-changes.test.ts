import { describe, expect, it } from "vitest";
import { parseArticleResourceChangeManifest } from "../../src/modules/articles/article-resource-changes";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

describe("文章已有资源变更清单", () => {
	it("严格解析删除操作并按文件名稳定排序", () => {
		expect(
			parseArticleResourceChangeManifest({
				version: 1,
				changes: [
					{ operation: "delete", filename: "z.zip", expectedSha: SHA_B },
					{ operation: "delete", filename: "a.pdf", expectedSha: SHA_A },
				],
			}),
		).toEqual({
			version: 1,
			changes: [
				{ operation: "delete", filename: "a.pdf", expectedSha: SHA_A },
				{ operation: "delete", filename: "z.zip", expectedSha: SHA_B },
			],
		});
	});

	it("解析替换操作并拒绝重复引用同一暂存对象", () => {
		const assetId = "123e4567-e89b-12d3-a456-426614174000";
		expect(
			parseArticleResourceChangeManifest({
				version: 1,
				changes: [
					{
						operation: "replace",
						filename: "cover.png",
						expectedSha: SHA_A,
						assetId: assetId.toUpperCase(),
					},
				],
			}),
		).toEqual({
			version: 1,
			changes: [{ operation: "replace", filename: "cover.png", expectedSha: SHA_A, assetId }],
		});
		expect(() =>
			parseArticleResourceChangeManifest({
				version: 1,
				changes: [
					{ operation: "replace", filename: "a.png", expectedSha: SHA_A, assetId },
					{ operation: "replace", filename: "b.png", expectedSha: SHA_B, assetId },
				],
			}),
		).toThrow("重复引用暂存对象");
	});

	it("解析同 Bundle 移动并拒绝原地、重复目标、路径链和循环", () => {
		expect(
			parseArticleResourceChangeManifest({
				version: 1,
				changes: [
					{
						operation: "move",
						filename: "old.pdf",
						destinationFilename: "new.pdf",
						expectedSha: SHA_A,
					},
				],
			}),
		).toEqual({
			version: 1,
			changes: [
				{
					operation: "move",
					filename: "old.pdf",
					destinationFilename: "new.pdf",
					expectedSha: SHA_A,
				},
			],
		});
		for (const changes of [
			[
				{
					operation: "move",
					filename: "a.pdf",
					destinationFilename: "a.pdf",
					expectedSha: SHA_A,
				},
			],
			[
				{
					operation: "move",
					filename: "a.pdf",
					destinationFilename: "c.pdf",
					expectedSha: SHA_A,
				},
				{
					operation: "move",
					filename: "b.pdf",
					destinationFilename: "c.pdf",
					expectedSha: SHA_B,
				},
			],
			[
				{
					operation: "move",
					filename: "a.pdf",
					destinationFilename: "b.pdf",
					expectedSha: SHA_A,
				},
				{
					operation: "move",
					filename: "b.pdf",
					destinationFilename: "c.pdf",
					expectedSha: SHA_B,
				},
			],
		]) {
			expect(() => parseArticleResourceChangeManifest({ version: 1, changes })).toThrow();
		}
	});

	it("拒绝完整路径、重复文件名和未知字段", () => {
		for (const changes of [
			[{ operation: "delete", filename: "../secret.pdf", expectedSha: SHA_A }],
			[
				{ operation: "delete", filename: "guide.pdf", expectedSha: SHA_A },
				{ operation: "delete", filename: "guide.pdf", expectedSha: SHA_B },
			],
			[
				{
					operation: "move",
					filename: "guide.pdf",
					destinationFilename: "../secret.pdf",
					expectedSha: SHA_A,
				},
			],
			[{ operation: "delete", filename: "guide.pdf", expectedSha: SHA_A, path: "README.md" }],
		]) {
			expect(() => parseArticleResourceChangeManifest({ version: 1, changes })).toThrow();
		}
	});

	it("拒绝无效 SHA 和超过十个操作", () => {
		expect(() =>
			parseArticleResourceChangeManifest({
				version: 1,
				changes: [{ operation: "delete", filename: "guide.pdf", expectedSha: "bad" }],
			}),
		).toThrow();
		expect(() =>
			parseArticleResourceChangeManifest({
				version: 1,
				changes: Array.from({ length: 11 }, (_, index) => ({
					operation: "delete",
					filename: `asset-${index}.pdf`,
					expectedSha: SHA_A,
				})),
			}),
		).toThrow();
	});
});
