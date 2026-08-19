import { z } from "zod";
import { articleConfig } from "../../config/articleConfig";
import { parseArticleResourceReference } from "../../core/security/path-policy";
import { parseUncredentialedHttpsUrl } from "../../core/security/url-policy";
import { isArticleAssetImageFilename } from "../media/media-config";

function containsUnsafeControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0);
		return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
	});
}

/**
 * 文本字段统一拒绝控制字符，避免污染 YAML、提交信息和结构化日志。
 * 换行仅对 Markdown 正文有意义，Frontmatter 文本字段不接受不可见控制字符。
 */
function safeText(maxLength: number) {
	return z
		.string()
		.trim()
		.max(maxLength)
		.refine((value) => !containsUnsafeControlCharacter(value), {
			message: "字段包含不允许的控制字符。",
		});
}

const requiredText = (maxLength: number) => safeText(maxLength).min(1);
const optionalDate = z.coerce.date().optional();

function isSafeHttpsUrl(value: string): boolean {
	try {
		parseUncredentialedHttpsUrl(value, "URL");
		return true;
	} catch {
		return false;
	}
}

function safeHttpsUrl(maxLength: number) {
	return safeText(maxLength).refine((value) => value === "" || isSafeHttpsUrl(value), {
		message: "URL 必须使用不含凭据的 HTTPS 地址。",
	});
}

function safeCoverReference(maxLength: number) {
	return safeText(maxLength).refine(
		(value) => {
			if (value === "" || isSafeHttpsUrl(value)) return true;
			try {
				const reference = parseArticleResourceReference(value);
				return isArticleAssetImageFilename(reference.slice(2));
			} catch {
				return false;
			}
		},
		{ message: "封面必须是安全的 HTTPS 地址或当前文章目录中的资源。" },
	);
}

/**
 * 与 Firefly Content Collection 对齐的可写 Frontmatter Schema。
 * strict() 会拒绝 prevTitle/prevSlug/nextTitle/nextSlug 以及其他未知字段，避免静默丢弃
 * 客户端试图写入的构建内部数据。
 */
export const articleFrontmatterSchema = z
	.object({
		title: requiredText(200),
		published: z.coerce.date(),
		updated: optionalDate,
		draft: z.boolean().default(articleConfig.defaultDraft),
		description: safeText(500).default(""),
		image: safeCoverReference(2_048).default(""),
		tags: z.array(requiredText(50)).max(30).default([]),
		category: requiredText(100).nullable().default(null),
		lang: requiredText(20).default(articleConfig.defaultLanguage),
		pinned: z.boolean().default(false),
		author: safeText(100).default(""),
		sourceLink: safeHttpsUrl(2_048).default(""),
		licenseName: safeText(100).default(""),
		licenseUrl: safeHttpsUrl(2_048).default(""),
		comment: z.boolean().default(articleConfig.defaultComment),
		password: safeText(200).default(""),
		passwordHint: safeText(200).default(""),
	})
	.strict();

/**
 * P1 编辑输入只接受 Markdown。format 是字面量而非任意扩展名，防止客户端借此
 * 写入 MDX 或其他可影响构建执行面的文件类型。
 */
export const articleEditorInputSchema = z
	.object({
		frontmatter: articleFrontmatterSchema,
		slug: safeText(100).optional(),
		format: z.literal("md").default("md"),
		markdown: z.string().max(1_000_000),
	})
	.strict();

export type ValidatedArticleFrontmatter = z.infer<typeof articleFrontmatterSchema>;
export type ValidatedArticleEditorInput = z.infer<typeof articleEditorInputSchema>;

/** 在所有默认值与边界校验通过后，才允许文章数据进入路径和 Provider 层。 */
export function parseArticleEditorInput(input: unknown): ValidatedArticleEditorInput {
	return articleEditorInputSchema.parse(input);
}
