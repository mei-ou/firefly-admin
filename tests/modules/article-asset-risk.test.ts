import { describe, expect, it } from "vitest";
import { classifyArticleAssetRisk } from "../../src/modules/media/article-asset-risk";

function createInput() {
	return {
		storageSlug: "hello-world",
		filename: "guide.pdf",
		repositoryPath: "src/content/posts/hello-world/guide.pdf",
		source: "trusted-repository-snapshot" as const,
		entryType: "file" as const,
		allowedType: true,
		referenceAnalysisComplete: true,
		role: null,
		referenceCount: 0,
		crossArticleChange: false,
		articleContentWillChange: false,
		resourceTypeWillChange: false,
	};
}

describe("文章资源路径风险分级", () => {
	it("将未引用的允许类型直接子文件分类为 L0", () => {
		expect(classifyArticleAssetRisk(createInput())).toEqual({
			policyLevel: "L0",
			riskLevel: "low",
			mutable: true,
			requiresImpactPreview: false,
			reasons: [],
		});
	});

	it("将普通引用或文章内容变化分类为中风险 L1", () => {
		for (const input of [
			{ ...createInput(), role: "inline" as const, referenceCount: 1 },
			{ ...createInput(), articleContentWillChange: true },
		]) {
			expect(classifyArticleAssetRisk(input)).toMatchObject({
				policyLevel: "L1",
				riskLevel: "medium",
				mutable: true,
				requiresImpactPreview: true,
			});
		}
	});

	it("将封面、跨文章变化或类型变化分类为高风险 L1", () => {
		for (const input of [
			{ ...createInput(), role: "cover" as const, referenceCount: 1 },
			{ ...createInput(), crossArticleChange: true },
			{ ...createInput(), resourceTypeWillChange: true },
		]) {
			expect(classifyArticleAssetRisk(input)).toMatchObject({
				policyLevel: "L1",
				riskLevel: "high",
				mutable: true,
				requiresImpactPreview: true,
			});
		}
	});

	it("将入口文件、子目录、隐藏文件和内容根外路径永久分类为 L2", () => {
		for (const input of [
			{
				...createInput(),
				filename: "index.md",
				repositoryPath: "src/content/posts/hello-world/index.md",
			},
			{
				...createInput(),
				filename: "images/guide.pdf",
				repositoryPath: "src/content/posts/hello-world/images/guide.pdf",
			},
			{
				...createInput(),
				filename: ".secret.pdf",
				repositoryPath: "src/content/posts/hello-world/.secret.pdf",
			},
			{ ...createInput(), repositoryPath: "README.md" },
		]) {
			expect(classifyArticleAssetRisk(input)).toMatchObject({
				policyLevel: "L2",
				riskLevel: "high",
				mutable: false,
				requiresImpactPreview: false,
			});
		}
	});

	it("将目录、来源不明和禁止类型分类为 L2", () => {
		for (const input of [
			{ ...createInput(), entryType: "directory" as const },
			{ ...createInput(), source: "unknown" as const },
			{ ...createInput(), allowedType: false },
			{ ...createInput(), referenceAnalysisComplete: false },
		]) {
			expect(classifyArticleAssetRisk(input)).toMatchObject({
				policyLevel: "L2",
				mutable: false,
			});
		}
	});

	it("对畸形或包含额外字段的输入失败关闭为 L2", () => {
		for (const input of [
			null,
			{ ...createInput(), referenceCount: -1 },
			{ ...createInput(), confirmedByAdmin: true },
		]) {
			expect(classifyArticleAssetRisk(input)).toEqual({
				policyLevel: "L2",
				riskLevel: "high",
				mutable: false,
				requiresImpactPreview: false,
				reasons: ["invalid-classification-input"],
			});
		}
	});

	it("支持受信任的自定义内容根且仍核对精确路径", () => {
		const config = {
			contentRoot: "content/blog",
			usePageBundle: true,
			entryFilename: "post.md",
		};
		expect(
			classifyArticleAssetRisk(
				{ ...createInput(), repositoryPath: "content/blog/hello-world/guide.pdf" },
				config,
			),
		).toMatchObject({ policyLevel: "L0" });
		expect(classifyArticleAssetRisk(createInput(), config)).toMatchObject({
			policyLevel: "L2",
			reasons: ["repository-path-mismatch"],
		});
	});
});
