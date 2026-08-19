import { parseDocument, stringify } from "yaml";
import {
	articleFrontmatterSchema,
	type ValidatedArticleFrontmatter,
} from "../modules/articles/article-schema";
import { parseSlug } from "./slug-utils";

const FRONTMATTER_DELIMITER = "---";
const FRONTMATTER_MAX_LENGTH = 64 * 1024;
const DOCUMENT_MAX_LENGTH = 1_000_000;

export interface ParsedFrontmatter {
	frontmatter: ValidatedArticleFrontmatter;
	slug?: string;
}

export interface ParsedEditableFrontmatter extends ParsedFrontmatter {
	unknownFrontmatter: Readonly<Record<string, unknown>>;
}

export interface ParsedMarkdownDocument extends ParsedFrontmatter {
	markdown: string;
}

export interface ParsedEditableMarkdownDocument extends ParsedEditableFrontmatter {
	markdown: string;
}

const ARTICLE_FRONTMATTER_KEYS = new Set([
	"title",
	"published",
	"updated",
	"draft",
	"description",
	"image",
	"tags",
	"category",
	"lang",
	"pinned",
	"author",
	"sourceLink",
	"licenseName",
	"licenseUrl",
	"comment",
	"password",
	"passwordHint",
]);

const RESERVED_EDITABLE_FRONTMATTER_KEYS = new Set([...ARTICLE_FRONTMATTER_KEYS, "slug"]);

const YAML_SERIALIZE_OPTIONS = {
	schema: "core" as const,
	customTags: [],
	merge: false,
	lineWidth: 0,
	simpleKeys: true,
};

function createSerializableFrontmatter(
	frontmatter: ValidatedArticleFrontmatter,
	slug?: string,
): Record<string, unknown> {
	return {
		title: frontmatter.title,
		...(slug ? { slug } : {}),
		published: frontmatter.published.toISOString(),
		...(frontmatter.updated ? { updated: frontmatter.updated.toISOString() } : {}),
		draft: frontmatter.draft,
		description: frontmatter.description,
		image: frontmatter.image,
		tags: frontmatter.tags,
		category: frontmatter.category,
		lang: frontmatter.lang,
		pinned: frontmatter.pinned,
		author: frontmatter.author,
		sourceLink: frontmatter.sourceLink,
		licenseName: frontmatter.licenseName,
		licenseUrl: frontmatter.licenseUrl,
		comment: frontmatter.comment,
		password: frontmatter.password,
		passwordHint: frontmatter.passwordHint,
	};
}

/**
 * 将已验证数据序列化为稳定字段顺序的 YAML。
 *
 * 所有值均交给 YAML 库完成引用和转义，禁止模板字符串拼接用户字段；日期先转 ISO
 * 字符串，以确保 Worker、GitHub 与 Firefly 构建环境得到一致结果。
 */
export function serializeFrontmatter(frontmatterInput: unknown, slugInput?: unknown): string {
	const frontmatter = articleFrontmatterSchema.parse(frontmatterInput);
	const slug = slugInput === undefined ? undefined : parseSlug(slugInput);

	return stringify(createSerializableFrontmatter(frontmatter, slug), YAML_SERIALIZE_OPTIONS);
}

function parseYamlRecord(source: string): Record<string, unknown> {
	const document = parseDocument(source, {
		schema: "core",
		customTags: [],
		merge: false,
		uniqueKeys: true,
		stringKeys: true,
		strict: true,
	});
	if (document.errors.length > 0 || document.warnings.length > 0) {
		throw new TypeError("Frontmatter YAML 无效。");
	}

	const value = document.toJS({ maxAliasCount: 0 });
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Frontmatter 必须是对象。");
	}
	return { ...(value as Record<string, unknown>) };
}

/**
 * 使用 YAML 1.2 Core Schema 解析不可信 Frontmatter。
 *
 * 禁用 merge、自定义标签和 alias，要求唯一字符串键；解析完成后仍必须通过 strict
 * 文章 Schema。YAML 解析成功并不代表数据可以进入业务层。
 */
export function parseFrontmatter(source: unknown): ParsedFrontmatter {
	if (typeof source !== "string" || source.length === 0 || source.length > FRONTMATTER_MAX_LENGTH) {
		throw new TypeError("Frontmatter 内容无效。");
	}

	const record = parseYamlRecord(source);
	const rawSlug = record.slug;
	delete record.slug;

	return {
		frontmatter: articleFrontmatterSchema.parse(record),
		...(rawSlug === undefined ? {} : { slug: parseSlug(rawSlug) }),
	};
}

/**
 * 编辑器源码模式允许未知 Front-matter 字段存在，但始终把它们与已验证字段分开保存。
 * 业务读取路径仍使用上面的严格解析，避免把编辑器的保真边界扩散到业务层。
 */
export function parseEditableFrontmatter(source: unknown): ParsedEditableFrontmatter {
	if (typeof source !== "string" || source.length === 0 || source.length > FRONTMATTER_MAX_LENGTH) {
		throw new TypeError("Frontmatter 内容无效。");
	}

	const record = parseYamlRecord(source);
	const rawSlug = record.slug;
	delete record.slug;
	const known: Record<string, unknown> = {};
	const unknownFrontmatter: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		if (ARTICLE_FRONTMATTER_KEYS.has(key)) known[key] = value;
		else unknownFrontmatter[key] = value;
	}

	return {
		frontmatter: articleFrontmatterSchema.parse(known),
		unknownFrontmatter,
		...(rawSlug === undefined ? {} : { slug: parseSlug(rawSlug) }),
	};
}

/** Serializes the editor's split known/unknown representation without allowing key collisions. */
export function serializeEditableFrontmatter(
	frontmatterInput: unknown,
	unknownFrontmatterInput: unknown,
	slugInput?: unknown,
): string {
	const frontmatter = articleFrontmatterSchema.parse(frontmatterInput);
	if (
		typeof unknownFrontmatterInput !== "object" ||
		unknownFrontmatterInput === null ||
		Array.isArray(unknownFrontmatterInput)
	) {
		throw new TypeError("未知 Frontmatter 必须是对象。");
	}

	const unknownFrontmatter = unknownFrontmatterInput as Record<string, unknown>;
	for (const key of Object.keys(unknownFrontmatter)) {
		if (RESERVED_EDITABLE_FRONTMATTER_KEYS.has(key)) {
			throw new TypeError(`未知 Frontmatter 字段与受保护字段冲突：${key}。`);
		}
	}

	const slug = slugInput === undefined ? undefined : parseSlug(slugInput);
	return stringify(
		{ ...createSerializableFrontmatter(frontmatter, slug), ...unknownFrontmatter },
		YAML_SERIALIZE_OPTIONS,
	);
}

/** 将 Frontmatter 与 Markdown 正文组合为可提交到 GitHub 的完整 `.md` 文档。 */
export function buildMarkdownDocument(
	frontmatterInput: unknown,
	markdownInput: unknown,
	slugInput?: unknown,
): string {
	if (typeof markdownInput !== "string" || markdownInput.length > DOCUMENT_MAX_LENGTH) {
		throw new TypeError("Markdown 正文无效。");
	}

	const yaml = serializeFrontmatter(frontmatterInput, slugInput).trimEnd();
	return `${FRONTMATTER_DELIMITER}\n${yaml}\n${FRONTMATTER_DELIMITER}\n${markdownInput}`;
}

/** Builds the complete editor source while retaining fields unknown to the article schema. */
export function buildEditableMarkdownDocument(
	frontmatterInput: unknown,
	unknownFrontmatterInput: unknown,
	markdownInput: unknown,
	slugInput?: unknown,
): string {
	if (typeof markdownInput !== "string" || markdownInput.length > DOCUMENT_MAX_LENGTH) {
		throw new TypeError("Markdown 正文无效。");
	}

	const yaml = serializeEditableFrontmatter(
		frontmatterInput,
		unknownFrontmatterInput,
		slugInput,
	).trimEnd();
	return `${FRONTMATTER_DELIMITER}\n${yaml}\n${FRONTMATTER_DELIMITER}\n${markdownInput}`;
}

/**
 * 拆分导入或从 GitHub 读取的 Markdown 文档。
 * 仅把文档开头第一组独立 `---` 行视为 Frontmatter，正文内的分隔线不会被误切分。
 */
export function parseMarkdownDocument(source: unknown): ParsedMarkdownDocument {
	if (
		typeof source !== "string" ||
		source.length === 0 ||
		source.length > DOCUMENT_MAX_LENGTH + FRONTMATTER_MAX_LENGTH
	) {
		throw new TypeError("Markdown 文档无效。");
	}

	const normalized = source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
	if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
		throw new TypeError("Markdown 文档缺少 Frontmatter。");
	}

	const closingDelimiter = `\n${FRONTMATTER_DELIMITER}\n`;
	const closingIndex = normalized.indexOf(closingDelimiter, FRONTMATTER_DELIMITER.length + 1);
	if (closingIndex < 0) {
		throw new TypeError("Markdown Frontmatter 未闭合。");
	}

	const yamlStart = FRONTMATTER_DELIMITER.length + 1;
	const yaml = normalized.slice(yamlStart, closingIndex);
	const markdown = normalized.slice(closingIndex + closingDelimiter.length);
	return { ...parseFrontmatter(yaml), markdown };
}

/** Splits a complete editor source document atomically, including unknown Front-matter fields. */
export function parseEditableMarkdownDocument(source: unknown): ParsedEditableMarkdownDocument {
	if (
		typeof source !== "string" ||
		source.length === 0 ||
		source.length > DOCUMENT_MAX_LENGTH + FRONTMATTER_MAX_LENGTH
	) {
		throw new TypeError("Markdown 文档无效。");
	}

	const normalized = source.replace(/^\uFEFF/, "").replaceAll("\r\n", "\n");
	if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
		throw new TypeError("Markdown 文档缺少 Frontmatter。");
	}

	const closingDelimiter = `\n${FRONTMATTER_DELIMITER}\n`;
	const closingIndex = normalized.indexOf(closingDelimiter, FRONTMATTER_DELIMITER.length + 1);
	if (closingIndex < 0) {
		throw new TypeError("Markdown Frontmatter 未闭合。");
	}

	const yamlStart = FRONTMATTER_DELIMITER.length + 1;
	const yaml = normalized.slice(yamlStart, closingIndex);
	const markdown = normalized.slice(closingIndex + closingDelimiter.length);
	return { ...parseEditableFrontmatter(yaml), markdown };
}

/**
 * 把任意可接受的 Markdown 文档转换为稳定提交形式。Frontmatter 重新按固定字段顺序
 * 序列化，正文只做 UTF-8 BOM 与 CRLF 归一化，不修剪空格或补写结尾换行。
 */
export function canonicalizeMarkdownDocument(source: unknown): string {
	const parsed = parseMarkdownDocument(source);
	return buildMarkdownDocument(parsed.frontmatter, parsed.markdown, parsed.slug);
}

export function canonicalizeEditableMarkdownDocument(source: unknown): string {
	const parsed = parseEditableMarkdownDocument(source);
	return buildEditableMarkdownDocument(
		parsed.frontmatter,
		parsed.unknownFrontmatter,
		parsed.markdown,
		parsed.slug,
	);
}
