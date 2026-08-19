import { describe, expect, it } from "vitest";
import {
	type ArticleAssetReference,
	createArticleAssetSummary,
} from "../../src/modules/media/article-asset";

const BLOB_SHA = "a".repeat(40);

function createInput() {
	return {
		assetId: "asset_1234567890abcdef",
		storageSlug: "hello-world",
		filename: "cover.webp",
		blobSha: BLOB_SHA,
		size: 1024,
		contentType: "image/webp",
		role: "cover" as const,
		kind: "image" as const,
		policyLevel: "L1" as const,
		mutable: true,
		requiresImpactPreview: true,
		riskReasons: ["cover-reference"] as const,
		references: [
			{
				storageSlug: "hello-world",
				source: "frontmatter-image" as const,
				originalReference: "./cover.webp",
				target: "./cover.webp",
				targetStorageSlug: "hello-world",
				targetFilename: "cover.webp",
				line: null,
				column: null,
			},
		],
		riskLevel: "high" as const,
	};
}

describe("文章资源模型", () => {
	it("只根据已验证的文章和文件名生成只读路径", () => {
		expect(createArticleAssetSummary(createInput())).toEqual({
			...createInput(),
			relativePath: "./cover.webp",
			repositoryPath: "src/content/posts/hello-world/cover.webp",
		});
	});

	it("保留上游暂不可得的大小、类型和用途空值", () => {
		const summary = createArticleAssetSummary({
			...createInput(),
			size: null,
			contentType: null,
			role: null,
		});

		expect(summary).toMatchObject({ size: null, contentType: null, role: null });
	});

	it("拒绝路径、入口文件和无效 Blob SHA", () => {
		for (const input of [
			{ ...createInput(), filename: "../cover.webp" },
			{ ...createInput(), filename: "index.md" },
			{ ...createInput(), blobSha: "not-a-sha" },
		]) {
			expect(() => createArticleAssetSummary(input)).toThrow();
		}
	});

	it("拒绝运行时传入模型枚举以外的值", () => {
		for (const input of [
			{ ...createInput(), role: "thumbnail" },
			{ ...createInput(), kind: "executable" },
			{ ...createInput(), riskLevel: "critical" },
			{ ...createInput(), riskReasons: ["admin-confirmed"] },
		]) {
			expect(() =>
				createArticleAssetSummary(input as Parameters<typeof createArticleAssetSummary>[0]),
			).toThrow();
		}
	});

	it("严格校验引用位置且不接受额外字段", () => {
		for (const reference of [
			{ ...createInput().references[0], line: 0 },
			{ ...createInput().references[0], repositoryPath: "README.md" },
		]) {
			expect(() =>
				createArticleAssetSummary({
					...createInput(),
					references: [reference] as ArticleAssetReference[],
				}),
			).toThrow();
		}
	});
});
