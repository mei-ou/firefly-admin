import { isMap, isScalar, parseDocument, Scalar } from "yaml";
import { articleConfig } from "../../config/articleConfig";
import {
	type ArticlePathConfig,
	parseControlledArticleResourceReference,
} from "../../core/security/path-policy";
import { parseMarkdownDocument } from "../../utils/frontmatter-utils";
import {
	analyzeArticleAssetReferencesWithRanges,
	type RangedArticleAssetReference,
} from "./article-asset-references";
import type { MediaTransactionReferenceImpact } from "./media-transaction-preview";

export interface MediaTransactionReferenceReplacement {
	source: "frontmatter-image" | "markdown-image" | "markdown-link";
	start: number;
	end: number;
	before: string;
	after: string;
}

export interface RewriteMediaTransactionReferencesInput {
	source: string;
	storageSlug: string;
	currentTarget: string;
	proposedTarget: string;
	expectedReferences: readonly MediaTransactionReferenceImpact[];
	pathConfig?: ArticlePathConfig;
}

export interface RewriteMediaTransactionReferencesResult {
	content: string;
	replacements: readonly MediaTransactionReferenceReplacement[];
}

export type RewriteRenameMediaReferencesInput = RewriteMediaTransactionReferencesInput;
export type RewriteRenameMediaReferencesResult = RewriteMediaTransactionReferencesResult;

interface RawMarkdownDocumentParts {
	yaml: string;
	yamlStart: number;
	markdown: string;
	markdownStart: number;
}

function fail(message: string): never {
	throw new TypeError(message);
}

function readLine(source: string, start: number): { contentEnd: number; nextStart: number } | null {
	const lf = source.indexOf("\n", start);
	if (lf < 0) return null;
	return {
		contentEnd: lf > start && source[lf - 1] === "\r" ? lf - 1 : lf,
		nextStart: lf + 1,
	};
}

function locateRawMarkdownDocument(source: string): RawMarkdownDocumentParts {
	const bomLength = source.startsWith("\uFEFF") ? 1 : 0;
	const openingLine = readLine(source, bomLength);
	if (openingLine === null || source.slice(bomLength, openingLine.contentEnd) !== "---") {
		return fail("Markdown 文档缺少独立 Frontmatter 起始分隔行。");
	}

	const yamlStart = openingLine.nextStart;
	let lineStart = yamlStart;
	while (lineStart < source.length) {
		const line = readLine(source, lineStart);
		if (line === null) break;
		if (source.slice(lineStart, line.contentEnd) === "---") {
			return {
				yaml: source.slice(yamlStart, lineStart),
				yamlStart,
				markdown: source.slice(line.nextStart),
				markdownStart: line.nextStart,
			};
		}
		lineStart = line.nextStart;
	}
	return fail("Markdown Frontmatter 缺少独立闭合分隔行。");
}

function parseStrictDocument(
	source: string,
	parts: RawMarkdownDocumentParts,
	storageSlug: string,
	pathConfig: ArticlePathConfig,
): ReturnType<typeof parseMarkdownDocument> {
	try {
		return parseMarkdownDocument(source);
	} catch {
		const document = parseDocument(parts.yaml, {
			schema: "core",
			customTags: [],
			merge: false,
			uniqueKeys: true,
			stringKeys: true,
			strict: true,
		});
		if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
			return fail("Markdown 文档严格解析失败。");
		}
		const imagePairs = document.contents.items.filter(
			(pair) => isScalar(pair.key) && pair.key.value === "image",
		);
		const scalar = imagePairs[0]?.value;
		if (
			imagePairs.length !== 1 ||
			!isScalar(scalar) ||
			typeof scalar.value !== "string" ||
			!Array.isArray(scalar.range) ||
			scalar.range.length !== 3
		) {
			return fail("Markdown 文档严格解析失败。");
		}
		try {
			parseControlledArticleResourceReference(storageSlug, scalar.value, pathConfig);
		} catch {
			return fail("Markdown 文档严格解析失败。");
		}
		const sanitized = `${source.slice(0, parts.yamlStart + scalar.range[0])}""${source.slice(
			parts.yamlStart + scalar.range[1],
		)}`;
		try {
			const parsed = parseMarkdownDocument(sanitized);
			return { ...parsed, frontmatter: { ...parsed.frontmatter, image: scalar.value } };
		} catch {
			return fail("Markdown 文档严格解析失败。");
		}
	}
}

function locateFrontmatterImageReplacement(
	parts: RawMarkdownDocumentParts,
	currentTarget: string,
	proposedTarget: string,
): MediaTransactionReferenceReplacement | null {
	const document = parseDocument(parts.yaml, {
		schema: "core",
		customTags: [],
		merge: false,
		uniqueKeys: true,
		stringKeys: true,
		strict: true,
	});
	if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents)) {
		return fail("Frontmatter YAML AST 无效。");
	}

	const imagePairs = document.contents.items.filter(
		(pair) => isScalar(pair.key) && pair.key.value === "image",
	);
	if (imagePairs.length > 1) return fail("Frontmatter image 键不唯一。");
	const imagePair = imagePairs[0];
	if (imagePair === undefined) return null;
	const scalar = imagePair.value;
	if (
		!isScalar(scalar) ||
		typeof scalar.value !== "string" ||
		scalar.tag !== undefined ||
		scalar.anchor !== undefined ||
		!Array.isArray(scalar.range) ||
		scalar.range.length !== 3 ||
		![Scalar.PLAIN, Scalar.QUOTE_SINGLE, Scalar.QUOTE_DOUBLE].includes(
			scalar.type as "PLAIN" | "QUOTE_SINGLE" | "QUOTE_DOUBLE",
		)
	) {
		return fail("Frontmatter image 不是可无损改写的字符串 Scalar。");
	}
	if (scalar.value !== currentTarget) return null;

	const tokenStart = scalar.range[0];
	const tokenEnd = scalar.range[1];
	if (
		!Number.isInteger(tokenStart) ||
		!Number.isInteger(tokenEnd) ||
		tokenStart < 0 ||
		tokenEnd <= tokenStart ||
		tokenEnd > parts.yaml.length
	) {
		return fail("Frontmatter image Scalar 范围无效。");
	}
	const token = parts.yaml.slice(tokenStart, tokenEnd);
	let literalStart = tokenStart;
	let literalEnd = tokenEnd;
	if (scalar.type === Scalar.QUOTE_SINGLE) {
		if (token !== `'${currentTarget}'`) return fail("Frontmatter image 单引号字面量不明确。");
		literalStart += 1;
		literalEnd -= 1;
	} else if (scalar.type === Scalar.QUOTE_DOUBLE) {
		if (token !== `"${currentTarget}"`) return fail("Frontmatter image 双引号字面量不明确。");
		literalStart += 1;
		literalEnd -= 1;
	} else if (token !== currentTarget || scalar.source !== currentTarget) {
		return fail("Frontmatter image plain 字面量不明确。");
	}

	return {
		source: "frontmatter-image",
		start: parts.yamlStart + literalStart,
		end: parts.yamlStart + literalEnd,
		before: currentTarget,
		after: proposedTarget,
	};
}

function toImpact(
	reference: RangedArticleAssetReference,
	proposedTarget: string,
): MediaTransactionReferenceImpact {
	return {
		source: reference.source,
		originalReference: reference.originalReference,
		currentTarget: reference.target,
		proposedTarget,
		line: reference.line,
		column: reference.column,
	};
}

function impactKey(reference: MediaTransactionReferenceImpact): string {
	return JSON.stringify([
		reference.source,
		reference.originalReference,
		reference.currentTarget,
		reference.proposedTarget,
		reference.line,
		reference.column,
	]);
}

function assertExpectedReferences(
	actual: readonly MediaTransactionReferenceImpact[],
	expected: readonly MediaTransactionReferenceImpact[],
): void {
	if (!Array.isArray(expected)) fail("expectedReferences 必须是数组。");
	const counts = new Map<string, number>();
	for (const reference of expected) {
		const key = impactKey(reference);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	for (const reference of actual) {
		const key = impactKey(reference);
		const count = counts.get(key) ?? 0;
		if (count === 0) fail("expectedReferences 与当前文章引用不一致。");
		if (count === 1) counts.delete(key);
		else counts.set(key, count - 1);
	}
	if (counts.size > 0) fail("expectedReferences 与当前文章引用不一致。");
}

function createMarkdownReplacements(
	parts: RawMarkdownDocumentParts,
	references: readonly RangedArticleAssetReference[],
	currentTarget: string,
	proposedTarget: string,
): MediaTransactionReferenceReplacement[] {
	return references.map((reference) => {
		const range = reference.targetRange;
		if (range === null) return fail("Markdown 引用缺少目标范围。");
		return {
			source: reference.source,
			start: parts.markdownStart + range.start,
			end: parts.markdownStart + range.end,
			before: currentTarget,
			after: proposedTarget,
		};
	});
}

function assertReplacementRanges(
	source: string,
	replacements: readonly MediaTransactionReferenceReplacement[],
): void {
	let previousEnd = 0;
	for (const replacement of [...replacements].sort((left, right) => left.start - right.start)) {
		if (
			!Number.isInteger(replacement.start) ||
			!Number.isInteger(replacement.end) ||
			replacement.start < previousEnd ||
			replacement.start < 0 ||
			replacement.end <= replacement.start ||
			replacement.end > source.length ||
			source.slice(replacement.start, replacement.end) !== replacement.before
		) {
			fail("引用替换范围无效、重叠或已经漂移。");
		}
		previousEnd = replacement.end;
	}
}

function applyReplacements(
	source: string,
	replacements: readonly MediaTransactionReferenceReplacement[],
): string {
	let content = source;
	for (const replacement of replacements) {
		content = `${content.slice(0, replacement.start)}${replacement.after}${content.slice(replacement.end)}`;
	}
	return content;
}

function assertUnchangedSegments(
	source: string,
	content: string,
	replacements: readonly MediaTransactionReferenceReplacement[],
): void {
	let sourceOffset = 0;
	let contentOffset = 0;
	for (const replacement of [...replacements].sort((left, right) => left.start - right.start)) {
		const unchanged = source.slice(sourceOffset, replacement.start);
		if (content.slice(contentOffset, contentOffset + unchanged.length) !== unchanged) {
			fail("引用改写改变了非替换区间。");
		}
		contentOffset += unchanged.length;
		if (
			content.slice(contentOffset, contentOffset + replacement.after.length) !== replacement.after
		) {
			fail("引用改写结果与替换计划不一致。");
		}
		contentOffset += replacement.after.length;
		sourceOffset = replacement.end;
	}
	if (content.slice(contentOffset) !== source.slice(sourceOffset)) {
		fail("引用改写改变了尾部非替换区间。");
	}
}

function rewriteMarkdownOriginalReference(
	reference: RangedArticleAssetReference,
	currentTarget: string,
	proposedTarget: string,
): string {
	const targetOffset = reference.originalReference.lastIndexOf(currentTarget);
	if (targetOffset < 0) return fail("Markdown 原始引用与目标范围不一致。");
	return `${reference.originalReference.slice(0, targetOffset)}${proposedTarget}${reference.originalReference.slice(
		targetOffset + currentTarget.length,
	)}`;
}

function sameTargetIdentity(
	reference: RangedArticleAssetReference,
	target: { storageSlug: string; filename: string },
): boolean {
	return (
		reference.targetStorageSlug === target.storageSlug &&
		reference.targetFilename === target.filename
	);
}

function assertPostRewriteReferences(
	before: readonly RangedArticleAssetReference[],
	after: readonly RangedArticleAssetReference[],
	currentTarget: { reference: string; storageSlug: string; filename: string },
	proposedTarget: { reference: string; storageSlug: string; filename: string },
): void {
	if (before.length !== after.length) fail("改写后的引用数量发生意外变化。");
	for (let index = 0; index < before.length; index += 1) {
		const original = before[index];
		const rewritten = after[index];
		if (original === undefined || rewritten === undefined || original.source !== rewritten.source) {
			fail("改写后的引用顺序或类型发生意外变化。");
		}
		const selected = sameTargetIdentity(original, currentTarget);
		const expectedTarget = selected ? proposedTarget.reference : original.target;
		const expectedStorageSlug = selected ? proposedTarget.storageSlug : original.targetStorageSlug;
		const expectedFilename = selected ? proposedTarget.filename : original.targetFilename;
		const expectedOriginalReference = selected
			? original.source === "frontmatter-image"
				? proposedTarget.reference
				: rewriteMarkdownOriginalReference(
						original,
						currentTarget.reference,
						proposedTarget.reference,
					)
			: original.originalReference;
		if (
			rewritten.storageSlug !== original.storageSlug ||
			rewritten.target !== expectedTarget ||
			rewritten.targetInput !== expectedTarget ||
			rewritten.targetStorageSlug !== expectedStorageSlug ||
			rewritten.targetFilename !== expectedFilename ||
			rewritten.originalReference !== expectedOriginalReference ||
			rewritten.source === "frontmatter-image"
				? rewritten.line !== null || rewritten.column !== null || rewritten.targetRange !== null
				: rewritten.line !== original.line
		) {
			fail("改写后的引用分析与替换计划不一致。");
		}
	}
	if (after.some((reference) => sameTargetIdentity(reference, currentTarget))) {
		fail("改写后仍残留可操作的旧目标引用。");
	}
}

/**
 * 在原始 Git 文本上精确改写媒体事务引用。选择条件绑定服务端解析后的目标 Bundle 与
 * 文件名身份，而不是可伪造的相对字符串；只 splice 已证明的 YAML Scalar 或 Markdown range。
 */
export function rewriteMediaTransactionReferences({
	source,
	storageSlug,
	currentTarget,
	proposedTarget,
	expectedReferences,
	pathConfig = articleConfig,
}: RewriteMediaTransactionReferencesInput): RewriteMediaTransactionReferencesResult {
	if (typeof source !== "string") return fail("Markdown 原始内容无效。");
	const parsedCurrentTarget = parseControlledArticleResourceReference(
		storageSlug,
		currentTarget,
		pathConfig,
	);
	const parsedProposedTarget = parseControlledArticleResourceReference(
		storageSlug,
		proposedTarget,
		pathConfig,
	);
	if (
		parsedCurrentTarget.storageSlug === parsedProposedTarget.storageSlug &&
		parsedCurrentTarget.filename === parsedProposedTarget.filename
	) {
		return fail("媒体事务资源目标没有变化。");
	}

	const parts = locateRawMarkdownDocument(source);
	const parsed = parseStrictDocument(source, parts, storageSlug, pathConfig);
	const analysis = analyzeArticleAssetReferencesWithRanges({
		storageSlug,
		frontmatterImage: parsed.frontmatter.image,
		markdown: parts.markdown,
	});
	if (!analysis.complete || analysis.issues.length > 0) {
		return fail("原文章引用分析不完整。");
	}
	const selectedReferences = analysis.references.filter((reference) =>
		sameTargetIdentity(reference, parsedCurrentTarget),
	);
	assertExpectedReferences(
		selectedReferences.map((reference) => toImpact(reference, parsedProposedTarget.reference)),
		expectedReferences,
	);

	const replacements = createMarkdownReplacements(
		parts,
		selectedReferences.filter((reference) => reference.source !== "frontmatter-image"),
		parsedCurrentTarget.reference,
		parsedProposedTarget.reference,
	);
	const frontmatterReplacement = locateFrontmatterImageReplacement(
		parts,
		parsedCurrentTarget.reference,
		parsedProposedTarget.reference,
	);
	if (frontmatterReplacement !== null) replacements.push(frontmatterReplacement);
	if (
		selectedReferences.some((reference) => reference.source === "frontmatter-image") !==
		(frontmatterReplacement !== null)
	) {
		return fail("Frontmatter image 引用与 YAML AST 不一致。");
	}

	const descendingReplacements = replacements.sort((left, right) => right.start - left.start);
	assertReplacementRanges(source, descendingReplacements);
	if (descendingReplacements.length === 0) return { content: source, replacements: [] };
	const content = applyReplacements(source, descendingReplacements);
	assertUnchangedSegments(source, content, descendingReplacements);

	const rewrittenParts = locateRawMarkdownDocument(content);
	const rewrittenParsed = parseStrictDocument(content, rewrittenParts, storageSlug, pathConfig);
	const rewrittenAnalysis = analyzeArticleAssetReferencesWithRanges({
		storageSlug,
		frontmatterImage: rewrittenParsed.frontmatter.image,
		markdown: rewrittenParts.markdown,
	});
	if (!rewrittenAnalysis.complete || rewrittenAnalysis.issues.length > 0) {
		return fail("改写后的文章引用分析不完整。");
	}
	assertPostRewriteReferences(
		analysis.references,
		rewrittenAnalysis.references,
		parsedCurrentTarget,
		parsedProposedTarget,
	);
	return { content, replacements: descendingReplacements };
}

/** 保留 E1 rename 调用方和类型导出，行为委托给受控引用通用实现。 */
export function rewriteRenameMediaReferences(
	input: RewriteRenameMediaReferencesInput,
): RewriteRenameMediaReferencesResult {
	return rewriteMediaTransactionReferences(input);
}
