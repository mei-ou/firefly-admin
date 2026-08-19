import { z } from "zod";
import { parseControlledArticleResourceReference } from "../../core/security/path-policy";
import { parseSlug } from "../../utils/slug-utils";
import type { ArticleAssetReference, ArticleAssetReferenceSource } from "./article-asset";

const MAX_MARKDOWN_LENGTH = 1_000_000;
const MAX_FRONTMATTER_IMAGE_LENGTH = 2_048;
const MARKDOWN_LINK = /(!?)\[([^\]\r\n]*)\]\(([^)\r\n]*)\)/gu;
const UNSUPPORTED_LOCAL_REFERENCE_DEFINITION = /^ {0,3}\[[^\]\r\n]+\]:\s*(?:\.\/|\.\.\/)/gmu;
const UNSUPPORTED_LOCAL_HTML_ATTRIBUTE = /\b(?:href|src)\s*=\s*["'](?:\.\/|\.\.\/)/giu;

export type ArticleAssetReferenceIssueCode =
	| "invalid-local-reference"
	| "unsupported-local-reference-syntax"
	| "ambiguous-inline-code";

export interface ArticleAssetReferenceIssue {
	code: ArticleAssetReferenceIssueCode;
	line: number | null;
	column: number | null;
}

export interface ArticleAssetReferenceAnalysis {
	complete: boolean;
	references: readonly ArticleAssetReference[];
	issues: readonly ArticleAssetReferenceIssue[];
}

export interface ArticleAssetReferenceTargetRange {
	start: number;
	end: number;
}

export interface RangedArticleAssetReference extends ArticleAssetReference {
	targetInput: string;
	targetRange: ArticleAssetReferenceTargetRange | null;
}

export interface RangedArticleAssetReferenceAnalysis {
	complete: boolean;
	references: readonly RangedArticleAssetReference[];
	issues: readonly ArticleAssetReferenceIssue[];
}

const articleAssetReferenceAnalysisInputSchema = z
	.object({
		storageSlug: z.unknown(),
		frontmatterImage: z.string().max(MAX_FRONTMATTER_IMAGE_LENGTH),
		markdown: z.string().max(MAX_MARKDOWN_LENGTH),
	})
	.strict();

function maskRange(source: string[], start: number, end: number): void {
	for (let index = start; index < end; index += 1) {
		if (source[index] !== "\n" && source[index] !== "\r") source[index] = " ";
	}
}

function maskBlockCode(markdown: string): string[] {
	const masked = markdown.split("");
	let offset = 0;
	let fence: { marker: "`" | "~"; length: number } | null = null;
	for (const line of markdown.matchAll(/.*(?:\r?\n|$)/gu)) {
		const raw = line[0];
		if (raw.length === 0) continue;
		const content = raw.replace(/\r?\n$/u, "");
		const opening = /^ {0,3}(`{3,}|~{3,})/u.exec(content);
		if (fence !== null) {
			maskRange(masked, offset, offset + raw.length);
			const closing = new RegExp(`^ {0,3}${fence.marker}{${fence.length},}\\s*$`, "u");
			if (closing.test(content)) fence = null;
		} else if (opening?.[1]) {
			fence = { marker: opening[1][0] as "`" | "~", length: opening[1].length };
			maskRange(masked, offset, offset + raw.length);
		} else if (/^(?: {4}|\t)/u.test(content)) {
			maskRange(masked, offset, offset + raw.length);
		}
		offset += raw.length;
	}
	return masked;
}

function maskInlineCode(masked: string[]): boolean {
	let complete = true;
	for (let index = 0; index < masked.length; index += 1) {
		if (masked[index] !== "`") continue;
		let runLength = 1;
		while (masked[index + runLength] === "`") runLength += 1;
		let closing = index + runLength;
		while (closing < masked.length) {
			if (masked[closing] !== "`") {
				closing += 1;
				continue;
			}
			let closingLength = 1;
			while (masked[closing + closingLength] === "`") closingLength += 1;
			if (closingLength === runLength) break;
			closing += closingLength;
		}
		if (closing >= masked.length) {
			maskRange(masked, index, masked.length);
			complete = false;
			break;
		}
		maskRange(masked, index, closing + runLength);
		index = closing + runLength - 1;
	}
	return complete;
}

function getLocation(source: string, offset: number): { line: number; column: number } {
	let line = 1;
	let column = 1;
	for (let index = 0; index < offset; index += 1) {
		if (source[index] === "\n") {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	return { line, column };
}

function isEscaped(source: string, offset: number): boolean {
	let backslashes = 0;
	for (let index = offset - 1; index >= 0 && source[index] === "\\"; index -= 1) {
		backslashes += 1;
	}
	return backslashes % 2 === 1;
}

function addMarkdownReference(
	references: RangedArticleAssetReference[],
	issues: ArticleAssetReferenceIssue[],
	storageSlug: string,
	markdown: string,
	match: RegExpExecArray,
): void {
	if (isEscaped(markdown, match.index)) return;
	const rawTarget = match[3] ?? "";
	const targetInput = rawTarget.trim();
	if (!targetInput.startsWith("./") && !targetInput.startsWith("../")) return;
	const location = getLocation(markdown, match.index);
	const rawTargetStart = match.index + match[0].length - rawTarget.length - 1;
	const leadingWhitespaceLength = rawTarget.length - rawTarget.trimStart().length;
	const targetRange = {
		start: rawTargetStart + leadingWhitespaceLength,
		end: rawTargetStart + leadingWhitespaceLength + targetInput.length,
	};
	if (markdown.slice(targetRange.start, targetRange.end) !== targetInput) {
		issues.push({ code: "invalid-local-reference", ...location });
		return;
	}
	let target: ReturnType<typeof parseControlledArticleResourceReference>;
	try {
		target = parseControlledArticleResourceReference(storageSlug, targetInput);
	} catch {
		issues.push({ code: "invalid-local-reference", ...location });
		return;
	}
	const source: ArticleAssetReferenceSource = match[1] === "!" ? "markdown-image" : "markdown-link";
	references.push({
		storageSlug,
		source,
		originalReference: match[0],
		target: target.reference,
		targetStorageSlug: target.storageSlug,
		targetFilename: target.filename,
		targetInput,
		targetRange,
		...location,
	});
}

function addUnsupportedSyntaxIssues(
	issues: ArticleAssetReferenceIssue[],
	markdown: string,
	maskedMarkdown: string,
	pattern: RegExp,
): void {
	pattern.lastIndex = 0;
	for (const match of maskedMarkdown.matchAll(pattern)) {
		issues.push({
			code: "unsupported-local-reference-syntax",
			...getLocation(markdown, match.index),
		});
	}
}

/**
 * 只分析已冻结的本地资源语法，不执行 HTML、MDX 或脚本。代码区域先按 UTF-16
 * 等长空格屏蔽，因此返回的坐标和范围仍对应原始 Markdown；未知本地语法只标记分析不完整。
 */
export function analyzeArticleAssetReferencesWithRanges(
	input: unknown,
): RangedArticleAssetReferenceAnalysis {
	const parsed = articleAssetReferenceAnalysisInputSchema.parse(input);
	const storageSlug = parseSlug(parsed.storageSlug);
	const references: RangedArticleAssetReference[] = [];
	const issues: ArticleAssetReferenceIssue[] = [];

	if (parsed.frontmatterImage.startsWith("./") || parsed.frontmatterImage.startsWith("../")) {
		try {
			const target = parseControlledArticleResourceReference(storageSlug, parsed.frontmatterImage);
			references.push({
				storageSlug,
				source: "frontmatter-image",
				originalReference: parsed.frontmatterImage,
				target: target.reference,
				targetStorageSlug: target.storageSlug,
				targetFilename: target.filename,
				targetInput: parsed.frontmatterImage,
				targetRange: null,
				line: null,
				column: null,
			});
		} catch {
			issues.push({ code: "invalid-local-reference", line: null, column: null });
		}
	}

	const masked = maskBlockCode(parsed.markdown);
	if (!maskInlineCode(masked)) {
		issues.push({ code: "ambiguous-inline-code", line: null, column: null });
	}
	const maskedMarkdown = masked.join("");
	if (maskedMarkdown.length !== parsed.markdown.length) {
		throw new TypeError("Markdown 掩码长度不变量被破坏。");
	}
	MARKDOWN_LINK.lastIndex = 0;
	let match = MARKDOWN_LINK.exec(maskedMarkdown);
	while (match !== null) {
		addMarkdownReference(references, issues, storageSlug, parsed.markdown, match);
		match = MARKDOWN_LINK.exec(maskedMarkdown);
	}
	addUnsupportedSyntaxIssues(
		issues,
		parsed.markdown,
		maskedMarkdown,
		UNSUPPORTED_LOCAL_REFERENCE_DEFINITION,
	);
	addUnsupportedSyntaxIssues(
		issues,
		parsed.markdown,
		maskedMarkdown,
		UNSUPPORTED_LOCAL_HTML_ATTRIBUTE,
	);

	return { complete: issues.length === 0, references, issues };
}

export function analyzeArticleAssetReferences(input: unknown): ArticleAssetReferenceAnalysis {
	const analysis = analyzeArticleAssetReferencesWithRanges(input);
	return {
		complete: analysis.complete,
		references: analysis.references.map(
			({ targetInput: _targetInput, targetRange: _targetRange, ...reference }) => reference,
		),
		issues: analysis.issues,
	};
}
