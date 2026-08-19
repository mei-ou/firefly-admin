import { describe, expect, it } from "vitest";
import {
	createArticleResourceChangesPayload,
	findArticleResourceReferenceRisk,
	removeArticleResourceChange,
	upsertArticleResourceChange,
} from "../../src/components/articles/article-resource-state";

const resources = [
	{ filename: "cover.webp", blobSha: "a".repeat(40) },
	{ filename: "guide.pdf", blobSha: "b".repeat(40) },
];

describe("文章已有资源浏览器状态", () => {
	it("构造稳定排序的 strict v1 变更清单", () => {
		let changes = upsertArticleResourceChange(resources, [], {
			operation: "move",
			filename: "guide.pdf",
			destinationFilename: "manual.pdf",
			expectedSha: "b".repeat(40),
		});
		changes = upsertArticleResourceChange(resources, changes, {
			operation: "delete",
			filename: "cover.webp",
			expectedSha: "a".repeat(40),
		});

		expect(createArticleResourceChangesPayload(changes)).toEqual({
			version: 1,
			changes: [
				{ operation: "delete", filename: "cover.webp", expectedSha: "a".repeat(40) },
				{
					operation: "move",
					filename: "guide.pdf",
					destinationFilename: "manual.pdf",
					expectedSha: "b".repeat(40),
				},
			],
		});
	});

	it("同一源资源的新操作覆盖旧操作且可撤销", () => {
		const deleted = upsertArticleResourceChange(resources, [], {
			operation: "delete",
			filename: "cover.webp",
			expectedSha: "a".repeat(40),
		});
		const replaced = upsertArticleResourceChange(resources, deleted, {
			operation: "replace",
			filename: "cover.webp",
			expectedSha: "a".repeat(40),
			assetId: "123e4567-e89b-12d3-a456-426614174000",
		});
		expect(replaced).toHaveLength(1);
		expect(replaced[0]?.operation).toBe("replace");
		expect(removeArticleResourceChange(replaced, "cover.webp")).toEqual([]);
	});

	it("拒绝旧 SHA、已存在目标、原地移动和重复移动目标", () => {
		expect(() =>
			upsertArticleResourceChange(resources, [], {
				operation: "delete",
				filename: "cover.webp",
				expectedSha: "c".repeat(40),
			}),
		).toThrow("版本无效");
		expect(() =>
			upsertArticleResourceChange(resources, [], {
				operation: "move",
				filename: "cover.webp",
				destinationFilename: "guide.pdf",
				expectedSha: "a".repeat(40),
			}),
		).toThrow("已存在");
		expect(() =>
			upsertArticleResourceChange(resources, [], {
				operation: "move",
				filename: "cover.webp",
				destinationFilename: "cover.webp",
				expectedSha: "a".repeat(40),
			}),
		).toThrow("不能与原文件名相同");
	});

	it("检测 Markdown 与 Frontmatter 的精确相对引用风险", () => {
		expect(
			findArticleResourceReferenceRisk(
				"cover.webp",
				"![封面](./cover.webp)\n[下载](./guide.pdf)",
				"./cover.webp",
			),
		).toEqual({ markdown: true, frontmatterImage: true });
		expect(
			findArticleResourceReferenceRisk("other.png", "正文", "https://example.com/a.png"),
		).toEqual({
			markdown: false,
			frontmatterImage: false,
		});
	});
});
