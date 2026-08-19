import { z } from "zod";
import type { ArticlePathConfig } from "../../core/security/path-policy";
import { buildArticleResourcePath } from "../../core/security/path-policy";
import type { ArticleAssetRiskLevel } from "./article-asset";

export type ArticleAssetPolicyLevel = "L0" | "L1" | "L2";

export type ArticleAssetRiskReason =
	| "invalid-classification-input"
	| "unverified-source"
	| "non-file-entry"
	| "invalid-resource-path"
	| "repository-path-mismatch"
	| "disallowed-resource-type"
	| "incomplete-reference-analysis"
	| "cover-reference"
	| "resource-reference"
	| "cross-article-change"
	| "article-content-change"
	| "resource-type-change";

export interface ArticleAssetRiskClassification {
	policyLevel: ArticleAssetPolicyLevel;
	riskLevel: ArticleAssetRiskLevel;
	mutable: boolean;
	requiresImpactPreview: boolean;
	reasons: readonly ArticleAssetRiskReason[];
}

const articleAssetRiskInputSchema = z
	.object({
		storageSlug: z.string(),
		filename: z.string(),
		repositoryPath: z.string(),
		source: z.enum(["trusted-repository-snapshot", "unknown"]),
		entryType: z.enum(["file", "directory", "unknown"]),
		allowedType: z.boolean(),
		referenceAnalysisComplete: z.boolean(),
		role: z.enum(["inline", "cover", "attachment"]).nullable(),
		referenceCount: z.number().int().nonnegative().max(10_000),
		crossArticleChange: z.boolean(),
		articleContentWillChange: z.boolean(),
		resourceTypeWillChange: z.boolean(),
	})
	.strict();

export type ArticleAssetRiskInput = z.infer<typeof articleAssetRiskInputSchema>;

const L2_CLASSIFICATION: ArticleAssetRiskClassification = {
	policyLevel: "L2",
	riskLevel: "high",
	mutable: false,
	requiresImpactPreview: false,
	reasons: ["invalid-classification-input"],
};

function classifyL2(reasons: ArticleAssetRiskReason[]): ArticleAssetRiskClassification {
	return {
		policyLevel: "L2",
		riskLevel: "high",
		mutable: false,
		requiresImpactPreview: false,
		reasons,
	};
}

/**
 * 资源分类只信任同一不可变仓库快照中的直接子文件。L2 是永久禁止级别，调用方不得
 * 因管理员身份、确认词或 UI 状态覆盖；L1 仍需后续 Preview/Commit 协议才能执行。
 */
export function classifyArticleAssetRisk(
	input: unknown,
	pathConfig?: ArticlePathConfig,
): ArticleAssetRiskClassification {
	const parsed = articleAssetRiskInputSchema.safeParse(input);
	if (!parsed.success) return L2_CLASSIFICATION;

	const value = parsed.data;
	const blockingReasons: ArticleAssetRiskReason[] = [];
	if (value.source !== "trusted-repository-snapshot") blockingReasons.push("unverified-source");
	if (value.entryType !== "file") blockingReasons.push("non-file-entry");

	let expectedPath: string | null = null;
	try {
		expectedPath = buildArticleResourcePath(value.storageSlug, value.filename, pathConfig);
	} catch {
		blockingReasons.push("invalid-resource-path");
	}
	if (expectedPath !== null && value.repositoryPath !== expectedPath) {
		blockingReasons.push("repository-path-mismatch");
	}
	if (!value.allowedType) blockingReasons.push("disallowed-resource-type");
	if (!value.referenceAnalysisComplete) {
		blockingReasons.push("incomplete-reference-analysis");
	}
	if (blockingReasons.length > 0) return classifyL2(blockingReasons);

	const impactReasons: ArticleAssetRiskReason[] = [];
	if (value.role === "cover") impactReasons.push("cover-reference");
	if (value.referenceCount > 0) impactReasons.push("resource-reference");
	if (value.crossArticleChange) impactReasons.push("cross-article-change");
	if (value.articleContentWillChange) impactReasons.push("article-content-change");
	if (value.resourceTypeWillChange) impactReasons.push("resource-type-change");
	if (impactReasons.length > 0) {
		const highRisk =
			value.role === "cover" || value.crossArticleChange || value.resourceTypeWillChange;
		return {
			policyLevel: "L1",
			riskLevel: highRisk ? "high" : "medium",
			mutable: true,
			requiresImpactPreview: true,
			reasons: impactReasons,
		};
	}

	return {
		policyLevel: "L0",
		riskLevel: "low",
		mutable: true,
		requiresImpactPreview: false,
		reasons: [],
	};
}
