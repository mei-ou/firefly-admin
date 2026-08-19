import { z } from "zod";
import {
	type ArticlePathConfig,
	buildArticleResourcePath,
	parseArticleResourceFilename,
} from "../../core/security/path-policy";
import { parseSlug } from "../../utils/slug-utils";
import type { ArticleAssetPolicyLevel, ArticleAssetRiskReason } from "./article-asset-risk";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const ASSET_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,179}$/;
const CONTENT_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MAX_REFERENCE_TEXT_LENGTH = 512;
const ARTICLE_ASSET_ROLES = new Set<ArticleAssetRole>(["inline", "cover", "attachment"]);
const ARTICLE_ASSET_KINDS = new Set<ArticleAssetKind>([
	"image",
	"document",
	"archive",
	"other-allowed",
]);
const ARTICLE_ASSET_RISK_LEVELS = new Set<ArticleAssetRiskLevel>(["low", "medium", "high"]);
const ARTICLE_ASSET_POLICY_LEVELS = new Set<ArticleAssetPolicyLevel>(["L0", "L1", "L2"]);
const ARTICLE_ASSET_RISK_REASONS = new Set<ArticleAssetRiskReason>([
	"invalid-classification-input",
	"unverified-source",
	"non-file-entry",
	"invalid-resource-path",
	"repository-path-mismatch",
	"disallowed-resource-type",
	"incomplete-reference-analysis",
	"cover-reference",
	"resource-reference",
	"cross-article-change",
	"article-content-change",
	"resource-type-change",
]);

export type ArticleAssetRole = "inline" | "cover" | "attachment";
export type ArticleAssetKind = "image" | "document" | "archive" | "other-allowed";
export type ArticleAssetRiskLevel = "low" | "medium" | "high";
export type ArticleAssetReferenceSource = "frontmatter-image" | "markdown-image" | "markdown-link";

export interface ArticleAssetReference {
	/** 引用所在文章的 storage slug。 */
	storageSlug: string;
	source: ArticleAssetReferenceSource;
	originalReference: string;
	target: string;
	/** 服务端解析后的目标资源身份，避免用相对字符串推断资源归属。 */
	targetStorageSlug: string;
	targetFilename: string;
	/** 正文引用使用一基行列；Frontmatter 字段没有稳定正文坐标，因此省略。 */
	line: number | null;
	column: number | null;
}

export interface ArticleAssetSummary {
	assetId: string;
	storageSlug: string;
	filename: string;
	relativePath: string;
	repositoryPath: string;
	blobSha: string;
	size: number | null;
	contentType: string | null;
	role: ArticleAssetRole | null;
	kind: ArticleAssetKind;
	references: readonly ArticleAssetReference[];
	policyLevel: ArticleAssetPolicyLevel;
	riskLevel: ArticleAssetRiskLevel;
	mutable: boolean;
	requiresImpactPreview: boolean;
	riskReasons: readonly ArticleAssetRiskReason[];
}

const articleAssetReferenceSchema = z
	.object({
		storageSlug: z.unknown(),
		source: z.enum(["frontmatter-image", "markdown-image", "markdown-link"]),
		originalReference: z.string().min(1).max(MAX_REFERENCE_TEXT_LENGTH),
		target: z.string().min(1).max(MAX_REFERENCE_TEXT_LENGTH),
		targetStorageSlug: z.unknown(),
		targetFilename: z.unknown(),
		line: z.number().int().positive().nullable(),
		column: z.number().int().positive().nullable(),
	})
	.strict();

export interface CreateArticleAssetSummaryInput {
	assetId: string;
	storageSlug: unknown;
	pathConfig?: ArticlePathConfig;
	filename: unknown;
	blobSha: string;
	size: number | null;
	contentType: string | null;
	role: ArticleAssetRole | null;
	kind: ArticleAssetKind;
	references: readonly ArticleAssetReference[];
	policyLevel: ArticleAssetPolicyLevel;
	riskLevel: ArticleAssetRiskLevel;
	mutable: boolean;
	requiresImpactPreview: boolean;
	riskReasons: readonly ArticleAssetRiskReason[];
}

/**
 * 构造只读资源摘要。调用方不能提供相对路径或完整仓库路径；这两个值始终由服务端
 * 根据已验证的文章 slug 和直接子文件名生成，避免读取模型日后被误用为写入指令。
 */
export function createArticleAssetSummary(
	input: CreateArticleAssetSummaryInput,
): ArticleAssetSummary {
	if (!ASSET_ID.test(input.assetId)) throw new TypeError("文章资源标识无效。");
	const storageSlug = parseSlug(input.storageSlug);
	const filename = parseArticleResourceFilename(input.filename);
	if (!GIT_OBJECT_SHA.test(input.blobSha)) throw new TypeError("文章资源 Blob SHA 无效。");
	if (input.size !== null && (!Number.isSafeInteger(input.size) || input.size < 0)) {
		throw new TypeError("文章资源大小无效。");
	}
	if (
		input.contentType !== null &&
		(input.contentType.length === 0 ||
			input.contentType.length > 100 ||
			input.contentType !== input.contentType.toLowerCase() ||
			!CONTENT_TYPE.test(input.contentType))
	) {
		throw new TypeError("文章资源内容类型无效。");
	}
	if (input.role !== null && !ARTICLE_ASSET_ROLES.has(input.role)) {
		throw new TypeError("文章资源用途无效。");
	}
	if (!ARTICLE_ASSET_KINDS.has(input.kind)) throw new TypeError("文章资源种类无效。");
	if (!ARTICLE_ASSET_POLICY_LEVELS.has(input.policyLevel)) {
		throw new TypeError("文章资源策略等级无效。");
	}
	if (!ARTICLE_ASSET_RISK_LEVELS.has(input.riskLevel)) {
		throw new TypeError("文章资源风险等级无效。");
	}
	if (
		!Array.isArray(input.riskReasons) ||
		!input.riskReasons.every((reason) => ARTICLE_ASSET_RISK_REASONS.has(reason))
	) {
		throw new TypeError("文章资源风险原因无效。");
	}

	const references = input.references.map((reference) => {
		const parsed = articleAssetReferenceSchema.parse(reference);
		return {
			...parsed,
			storageSlug: parseSlug(parsed.storageSlug),
			targetStorageSlug: parseSlug(parsed.targetStorageSlug),
			targetFilename: parseArticleResourceFilename(parsed.targetFilename),
		};
	});

	return {
		assetId: input.assetId,
		storageSlug,
		filename,
		relativePath: `./${filename}`,
		repositoryPath: buildArticleResourcePath(storageSlug, filename, input.pathConfig),
		blobSha: input.blobSha,
		size: input.size,
		contentType: input.contentType,
		role: input.role,
		kind: input.kind,
		references,
		policyLevel: input.policyLevel,
		riskLevel: input.riskLevel,
		mutable: input.mutable,
		requiresImpactPreview: input.requiresImpactPreview,
		riskReasons: [...input.riskReasons],
	};
}
