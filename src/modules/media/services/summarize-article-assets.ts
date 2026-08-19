import { ApiError } from "../../../core/http/errors";
import {
	type ArticlePathConfig,
	buildArticleResourcePath,
	parseArticleResourceFilename,
} from "../../../core/security/path-policy";
import type { GitDirectoryEntry } from "../../../providers/git/types";
import type {
	ArticleAssetKind,
	ArticleAssetReference,
	ArticleAssetRole,
	ArticleAssetSummary,
} from "../article-asset";
import { createArticleAssetSummary } from "../article-asset";
import {
	type ArticleAssetReferenceIssue,
	analyzeArticleAssetReferences,
} from "../article-asset-references";
import { classifyArticleAssetRisk } from "../article-asset-risk";

export interface ArticleAssetReferenceAnalysisSummary {
	complete: boolean;
	issues: readonly ArticleAssetReferenceIssue[];
}

export interface SummarizeArticleAssetsInput {
	storageSlug: string;
	frontmatterImage: string;
	markdown: string;
	entries: readonly GitDirectoryEntry[];
	pathConfig: ArticlePathConfig;
}

export interface SummarizeArticleAssetsResult {
	resources: ArticleAssetSummary[];
	referenceAnalysis: ArticleAssetReferenceAnalysisSummary;
}

interface AssetTypeMetadata {
	allowed: boolean;
	contentType: string | null;
	kind: ArticleAssetKind;
}

function getAssetTypeMetadata(filename: string): AssetTypeMetadata {
	const extension = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
	if (extension === "gif") return { allowed: false, contentType: null, kind: "other-allowed" };
	if (extension === "jpg" || extension === "jpeg") {
		return { allowed: true, contentType: "image/jpeg", kind: "image" };
	}
	if (extension === "png") return { allowed: true, contentType: "image/png", kind: "image" };
	if (extension === "webp") return { allowed: true, contentType: "image/webp", kind: "image" };
	if (extension === "pdf") {
		return { allowed: true, contentType: "application/pdf", kind: "document" };
	}
	return { allowed: false, contentType: null, kind: "other-allowed" };
}

function getAssetRole(
	type: AssetTypeMetadata,
	references: readonly ArticleAssetReference[],
): ArticleAssetRole | null {
	if (references.some((reference) => reference.source === "frontmatter-image")) return "cover";
	if (references.length === 0) return null;
	return type.kind === "image" ? "inline" : "attachment";
}

/**
 * 将同一不可变 Commit 的目录项和文章内容汇总为只读资源详情。未知扩展名和不完整引用
 * 分析都保留可观察信息，但会被风险分类永久关闭，不能被 UI 解释为“安全且未引用”。
 */
export function summarizeArticleAssets(
	input: SummarizeArticleAssetsInput,
): SummarizeArticleAssetsResult {
	const analysis = analyzeArticleAssetReferences({
		storageSlug: input.storageSlug,
		frontmatterImage: input.frontmatterImage,
		markdown: input.markdown,
	});
	const resources = input.entries.map((entry) => {
		if (entry.type !== "file") {
			throw new ApiError(422, "ARTICLE_INVALID", "文章资源目录包含不支持的子目录。");
		}
		let filename: string;
		try {
			filename = parseArticleResourceFilename(entry.name);
		} catch {
			throw new ApiError(422, "ARTICLE_INVALID", "文章资源文件名无效。");
		}
		const repositoryPath = buildArticleResourcePath(input.storageSlug, filename, input.pathConfig);
		if (entry.path !== repositoryPath) {
			throw new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效文章资源路径。");
		}

		const references = analysis.references.filter(
			(reference) =>
				reference.targetStorageSlug === input.storageSlug && reference.targetFilename === filename,
		);
		const type = getAssetTypeMetadata(filename);
		const role = getAssetRole(type, references);
		const classification = classifyArticleAssetRisk(
			{
				storageSlug: input.storageSlug,
				filename,
				repositoryPath,
				source: "trusted-repository-snapshot",
				entryType: entry.type,
				allowedType: type.allowed,
				referenceAnalysisComplete: analysis.complete,
				role,
				referenceCount: references.length,
				crossArticleChange: false,
				articleContentWillChange: false,
				resourceTypeWillChange: false,
			},
			input.pathConfig,
		);
		return createArticleAssetSummary({
			assetId: `repository_${entry.sha}`,
			storageSlug: input.storageSlug,
			pathConfig: input.pathConfig,
			filename,
			blobSha: entry.sha,
			size: entry.size,
			contentType: type.contentType,
			role,
			kind: type.kind,
			references,
			policyLevel: classification.policyLevel,
			riskLevel: classification.riskLevel,
			mutable: classification.mutable,
			requiresImpactPreview: classification.requiresImpactPreview,
			riskReasons: classification.reasons,
		});
	});

	return {
		resources: resources.sort((left, right) => left.filename.localeCompare(right.filename, "en")),
		referenceAnalysis: { complete: analysis.complete, issues: analysis.issues },
	};
}
