import { z } from "zod";
import type { ParsedMarkdownDocument } from "../../utils/frontmatter-utils";
import { createSlugFromTitle } from "../../utils/slug-utils";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const SAFE_RESOURCE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const frontmatterSchema = z
	.object({
		title: z.string().min(1).max(200),
		published: z.iso.datetime({ offset: true }),
		updated: z.iso.datetime({ offset: true }).optional(),
		draft: z.boolean(),
		description: z.string().max(500),
		image: z.string().max(2_048),
		tags: z.array(z.string().min(1).max(50)).max(30),
		category: z.string().min(1).max(100).nullable(),
		lang: z.string().min(1).max(20),
		pinned: z.boolean(),
		author: z.string().max(100),
		sourceLink: z.string().max(2_048),
		licenseName: z.string().max(100),
		licenseUrl: z.string().max(2_048),
		comment: z.boolean(),
		password: z.string().max(200),
		passwordHint: z.string().max(200),
	})
	.strict();

const articleAssetReferenceSchema = z
	.object({
		storageSlug: z.string().regex(SLUG_PATTERN).max(100),
		source: z.enum(["frontmatter-image", "markdown-image", "markdown-link"]),
		originalReference: z.string().min(1).max(512),
		target: z.string().min(1).max(512),
		targetStorageSlug: z.string().regex(SLUG_PATTERN).max(100),
		targetFilename: z.string().min(1).max(120).regex(SAFE_RESOURCE_FILENAME),
		line: z.number().int().positive().nullable(),
		column: z.number().int().positive().nullable(),
	})
	.strict();

const articleAssetSchema = z
	.object({
		assetId: z.string().min(16).max(180),
		storageSlug: z.string().regex(SLUG_PATTERN).max(100),
		filename: z.string().min(1).max(120).regex(SAFE_RESOURCE_FILENAME),
		relativePath: z.string().regex(/^\.\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
		repositoryPath: z.string().min(1).max(512),
		blobSha: z.string().regex(GIT_OBJECT_SHA),
		size: z.number().int().nonnegative().nullable(),
		contentType: z.string().min(1).max(100).nullable(),
		role: z.enum(["inline", "cover", "attachment"]).nullable(),
		kind: z.enum(["image", "document", "archive", "other-allowed"]),
		references: z.array(articleAssetReferenceSchema).max(10_000),
		policyLevel: z.enum(["L0", "L1", "L2"]),
		riskLevel: z.enum(["low", "medium", "high"]),
		mutable: z.boolean(),
		requiresImpactPreview: z.boolean(),
		riskReasons: z
			.array(
				z.enum([
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
				]),
			)
			.max(12),
	})
	.strict();

const referenceIssueSchema = z
	.object({
		code: z.enum([
			"invalid-local-reference",
			"unsupported-local-reference-syntax",
			"ambiguous-inline-code",
		]),
		line: z.number().int().positive().nullable(),
		column: z.number().int().positive().nullable(),
	})
	.strict();

const remoteArticleSchema = z
	.object({
		storageSlug: z.string().regex(SLUG_PATTERN).max(100),
		pathAlias: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\/index\.md$/),
		sha: z.string().regex(GIT_OBJECT_SHA),
		headSha: z.string().regex(GIT_OBJECT_SHA),
		resources: z.array(articleAssetSchema).max(199).optional(),
		resourceReferenceAnalysis: z
			.object({
				complete: z.boolean(),
				issues: z.array(referenceIssueSchema).max(10_000),
			})
			.strict()
			.optional(),
		frontmatter: frontmatterSchema,
		slug: z.string().regex(SLUG_PATTERN).max(100).optional(),
		format: z.literal("md"),
		markdown: z.string().max(1_000_000),
	})
	.strict();

const articleDetailPayloadSchema = z.object({ article: remoteArticleSchema }).strict();
const articleCommitPayloadSchema = z
	.object({
		article: z
			.object({
				storageSlug: z.string().regex(SLUG_PATTERN),
				pathAlias: z.string(),
				commitSha: z.string().regex(GIT_OBJECT_SHA),
				commitUrl: z.url().refine((value) => new URL(value).origin === "https://github.com"),
				fileSha: z.string().regex(GIT_OBJECT_SHA),
				expectedArticleUrl: z
					.url()
					.refine((value) => new URL(value).protocol === "https:")
					.optional(),
			})
			.strict(),
	})
	.strict();
const articleDeletePayloadSchema = z
	.object({
		deletion: z
			.object({
				storageSlug: z.string().regex(SLUG_PATTERN),
				pathAlias: z.string(),
				commitSha: z.string().regex(GIT_OBJECT_SHA),
				commitUrl: z.url().refine((value) => new URL(value).origin === "https://github.com"),
				deletedFiles: z.array(z.string().min(1).max(240)).min(1).max(6),
			})
			.strict(),
	})
	.strict();
const apiErrorPayloadSchema = z.looseObject({
	error: z.looseObject({ code: z.string(), message: z.string() }),
});

export type ArticleSlugAvailability = "available" | "checking" | "invalid" | "occupied" | "unknown";

export type RemoteArticleData = z.infer<typeof remoteArticleSchema>;
export type ArticleCommitData = z.infer<typeof articleCommitPayloadSchema>["article"];
export type ArticleDeleteData = z.infer<typeof articleDeletePayloadSchema>["deletion"];

export interface ArticleEditorForm {
	storageSlug: string;
	publicSlug: string;
	title: string;
	published: string;
	updated: string;
	draft: boolean;
	description: string;
	image: string;
	tags: string;
	category: string;
	lang: string;
	pinned: boolean;
	author: string;
	sourceLink: string;
	licenseName: string;
	licenseUrl: string;
	comment: boolean;
	password: string;
	passwordHint: string;
	markdown: string;
}

function toDatetimeLocal(value: string | undefined): string {
	if (value === undefined) return "";
	const date = new Date(value);
	const offset = date.getTimezoneOffset() * 60_000;
	return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function toIsoDate(value: string, label: string): string {
	const date = new Date(value);
	if (value.length === 0 || Number.isNaN(date.getTime())) {
		throw new TypeError(`${label}无效。`);
	}
	return date.toISOString();
}

export function createEmptyArticleForm(now = new Date()): ArticleEditorForm {
	return {
		storageSlug: "",
		publicSlug: "",
		title: "",
		published: toDatetimeLocal(now.toISOString()),
		updated: "",
		draft: true,
		description: "",
		image: "",
		tags: "",
		category: "",
		lang: "zh_CN",
		pinned: false,
		author: "",
		sourceLink: "",
		licenseName: "",
		licenseUrl: "",
		comment: true,
		password: "",
		passwordHint: "",
		markdown: "",
	};
}

export function parseArticleDetailPayload(input: unknown): RemoteArticleData {
	return articleDetailPayloadSchema.parse(input).article;
}

export function parseArticleCommitPayload(input: unknown): ArticleCommitData {
	return articleCommitPayloadSchema.parse(input).article;
}

export function parseArticleDeletePayload(input: unknown): ArticleDeleteData {
	return articleDeletePayloadSchema.parse(input).deletion;
}

export function formFromRemoteArticle(article: RemoteArticleData): ArticleEditorForm {
	return {
		storageSlug: article.storageSlug,
		publicSlug: article.slug ?? "",
		title: article.frontmatter.title,
		published: toDatetimeLocal(article.frontmatter.published),
		updated: toDatetimeLocal(article.frontmatter.updated),
		draft: article.frontmatter.draft,
		description: article.frontmatter.description,
		image: article.frontmatter.image,
		tags: article.frontmatter.tags.join(", "),
		category: article.frontmatter.category ?? "",
		lang: article.frontmatter.lang,
		pinned: article.frontmatter.pinned,
		author: article.frontmatter.author,
		sourceLink: article.frontmatter.sourceLink,
		licenseName: article.frontmatter.licenseName,
		licenseUrl: article.frontmatter.licenseUrl,
		comment: article.frontmatter.comment,
		password: article.frontmatter.password,
		passwordHint: article.frontmatter.passwordHint,
		markdown: article.markdown,
	};
}

/**
 * 将通过服务端同款安全边界解析的 Markdown 文档映射到编辑表单。storage slug 属于仓库
 * 路径身份而非 Frontmatter，导入时必须保留当前值，防止本地文件改变写入目标。
 */
export function formFromImportedMarkdown(
	currentForm: ArticleEditorForm,
	document: ParsedMarkdownDocument,
): ArticleEditorForm {
	return {
		storageSlug: currentForm.storageSlug,
		publicSlug: document.slug ?? "",
		title: document.frontmatter.title,
		published: toDatetimeLocal(document.frontmatter.published.toISOString()),
		updated: document.frontmatter.updated
			? toDatetimeLocal(document.frontmatter.updated.toISOString())
			: "",
		draft: document.frontmatter.draft,
		description: document.frontmatter.description,
		image: document.frontmatter.image,
		tags: document.frontmatter.tags.join(", "),
		category: document.frontmatter.category ?? "",
		lang: document.frontmatter.lang,
		pinned: document.frontmatter.pinned,
		author: document.frontmatter.author,
		sourceLink: document.frontmatter.sourceLink,
		licenseName: document.frontmatter.licenseName,
		licenseUrl: document.frontmatter.licenseUrl,
		comment: document.frontmatter.comment,
		password: document.frontmatter.password,
		passwordHint: document.frontmatter.passwordHint,
		markdown: document.markdown,
	};
}

export function buildArticleWriteRequest(form: ArticleEditorForm): {
	storageSlug: string;
	article: Record<string, unknown>;
} {
	const storageSlug = form.storageSlug.trim();
	const publicSlug = form.publicSlug.trim();
	if (!SLUG_PATTERN.test(storageSlug) || storageSlug.length > 100) {
		throw new TypeError("存储 slug 必须是小写字母、数字和单连字符。");
	}
	if (publicSlug && (!SLUG_PATTERN.test(publicSlug) || publicSlug.length > 100)) {
		throw new TypeError("公开 slug 必须是小写字母、数字和单连字符。");
	}
	if (!form.title.trim()) {
		throw new TypeError("标题不能为空。");
	}
	const tags = form.tags
		.split(",")
		.map((tag) => tag.trim())
		.filter(Boolean);
	if (tags.length > 30) {
		throw new TypeError("标签不能超过 30 个。");
	}

	return {
		storageSlug,
		article: {
			frontmatter: {
				title: form.title.trim(),
				published: toIsoDate(form.published, "发布时间"),
				...(form.updated ? { updated: toIsoDate(form.updated, "更新时间") } : {}),
				draft: form.draft,
				description: form.description.trim(),
				image: form.image.trim(),
				tags,
				category: form.category.trim() || null,
				lang: form.lang.trim(),
				pinned: form.pinned,
				author: form.author.trim(),
				sourceLink: form.sourceLink.trim(),
				licenseName: form.licenseName.trim(),
				licenseUrl: form.licenseUrl.trim(),
				comment: form.comment,
				password: form.password,
				passwordHint: form.passwordHint.trim(),
			},
			...(publicSlug ? { slug: publicSlug } : {}),
			format: "md",
			markdown: form.markdown,
		},
	};
}

export function createIdempotencyKey(): string {
	return `article-${crypto.randomUUID()}`;
}

export function isValidStorageSlug(value: string): boolean {
	return value.length <= 100 && SLUG_PATTERN.test(value);
}

/**
 * 标题转换只提供产品便利，不绕过最终 slug 安全边界。超长标题按完整分词结果截断到
 * 100 字符，再移除尾部不完整的连字符。
 */
export function suggestStorageSlug(title: string): string {
	return createSlugFromTitle(title).slice(0, 100).replace(/-+$/g, "");
}

/** HEAD 200 表示文件存在，404 表示未找到；其他状态不能被乐观地解释为可用。 */
export function parseSlugAvailabilityStatus(
	status: number,
): Exclude<ArticleSlugAvailability, "checking"> {
	if (status === 200) return "occupied";
	if (status === 404) return "available";
	return "unknown";
}

/**
 * HEAD 预检响应头属于不可信网络输入。只有完整 Git 对象 SHA 才能成为后续原子提交的
 * 分支基线；缺失或格式漂移时必须失败关闭，不能退回到无条件写入。
 */
export function parseRepositoryHeadSha(value: string | null): string {
	if (value === null || !GIT_OBJECT_SHA.test(value)) {
		throw new TypeError("仓库 HEAD 响应无效，请重新检查。");
	}
	return value;
}

export function parseEditorApiError(input: unknown, status: number): string {
	const result = apiErrorPayloadSchema.safeParse(input);
	if (result.success) return result.data.error.message;
	if (status === 409) return "文章已被其他操作修改，请重新加载后再编辑。";
	return "保存文章失败，请稍后重试。";
}
