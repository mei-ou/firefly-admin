import { createMarkdownCodecDiagnostic } from "./diagnostics";
import { createMarkdownOpaqueFallback } from "./opaque-fallback";
import { readMarkdownSourceSlice, validateMarkdownSourceRange } from "./source-range";
import type {
	MarkdownCodecDiagnostic,
	MarkdownSourcePlaceholderNode,
	MarkdownSourceRange,
} from "./types";

export type MarkdownMathKind = "display" | "inline";
export type MarkdownMathSourceSyntax = "dollar-flow" | "dollar-text";

export interface MarkdownMathNode extends MarkdownSourcePlaceholderNode {
	kind: "math-block" | "math-inline";
	metadata: Readonly<{
		mathKind: MarkdownMathKind;
		syntax: MarkdownMathSourceSyntax;
		tex: string;
	}>;
}

export interface MarkdownMathRecognition {
	node: MarkdownMathNode | ReturnType<typeof createMarkdownOpaqueFallback>["node"];
	diagnostic: MarkdownCodecDiagnostic;
	recognized: boolean;
}

function isEscaped(source: string, index: number): boolean {
	let backslashCount = 0;
	for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) {
		backslashCount += 1;
	}
	return backslashCount % 2 === 1;
}

function readBacktickRun(source: string, index: number, to: number): number {
	let length = 0;
	while (index + length < to && source[index + length] === "`") length += 1;
	return length;
}

function findClosingBacktickRun(
	source: string,
	from: number,
	to: number,
	runLength: number,
): number | null {
	for (let cursor = from; cursor < to; cursor += 1) {
		if (source[cursor] === "\r" || source[cursor] === "\n") return null;
		if (source[cursor] !== "`") continue;
		const candidateLength = readBacktickRun(source, cursor, to);
		if (candidateLength === runLength) return cursor + runLength;
		cursor += candidateLength - 1;
	}
	return null;
}

function findClosingDollarDelimiter(
	source: string,
	from: number,
	to: number,
	delimiterLength: 1 | 2,
): number | null {
	const delimiter = delimiterLength === 1 ? "$" : "$$";
	for (let cursor = from; cursor < to; cursor += 1) {
		if (source[cursor] === "\r" || source[cursor] === "\n") return null;
		if (isEscaped(source, cursor) || !source.startsWith(delimiter, cursor)) continue;
		if (delimiterLength === 1 && source[cursor + 1] === "$") continue;
		return cursor;
	}
	return null;
}

function createRecognizedMath(
	source: string,
	range: MarkdownSourceRange,
	mathKind: MarkdownMathKind,
	syntax: MarkdownMathSourceSyntax,
	tex: string,
): MarkdownMathRecognition {
	const node: MarkdownMathNode = {
		category: "source-placeholder",
		kind: mathKind === "display" ? "math-block" : "math-inline",
		dirty: false,
		range,
		sourceSlice: readMarkdownSourceSlice(source, range),
		metadata: { mathKind, syntax, tex },
	};
	return {
		node,
		diagnostic: createMarkdownCodecDiagnostic(source, {
			code: "recognized-placeholder",
			message: `Firefly ${mathKind} math recognized as an inert source placeholder.`,
			severity: "info",
			range,
		}),
		recognized: true,
	};
}

/**
 * Recognize the first audited dollar-delimited formula in a source range. This function never loads
 * KaTeX or validates TeX semantics. Fenced math, unclosed delimiters, and unsupported spellings stay
 * opaque until a separately evidenced parser policy is approved.
 */
export function recognizeMarkdownMath(
	source: string,
	range: MarkdownSourceRange = { from: 0, to: source.length },
): MarkdownMathRecognition {
	const validation = validateMarkdownSourceRange(source, range);
	if (!validation.valid) {
		throw new TypeError(`Invalid Markdown Math source range: ${validation.reason}.`);
	}

	const sourceSlice = readMarkdownSourceSlice(source, range);
	const displayMatch = /^\$\$\r?\n([\s\S]*?)\r?\n\$\$(?:\r?\n)?$/.exec(sourceSlice);
	if (displayMatch?.[1]) {
		return createRecognizedMath(
			source,
			range,
			"display",
			"dollar-flow",
			displayMatch[1].replaceAll("\r\n", "\n"),
		);
	}

	for (let cursor = range.from; cursor < range.to; cursor += 1) {
		const character = source[cursor];
		if (character === "`") {
			const runLength = readBacktickRun(source, cursor, range.to);
			const afterClosingRun = findClosingBacktickRun(
				source,
				cursor + runLength,
				range.to,
				runLength,
			);
			if (afterClosingRun !== null) {
				cursor = afterClosingRun - 1;
				continue;
			}
		}
		if (character !== "$" || isEscaped(source, cursor)) continue;

		const delimiterLength: 1 | 2 = source[cursor + 1] === "$" ? 2 : 1;
		const closingFrom = cursor + delimiterLength;
		const closing = findClosingDollarDelimiter(source, closingFrom, range.to, delimiterLength);
		if (closing === null || closing === closingFrom) continue;

		const mathRange = { from: cursor, to: closing + delimiterLength };
		return createRecognizedMath(
			source,
			mathRange,
			"inline",
			"dollar-text",
			source.slice(closingFrom, closing),
		);
	}

	const fallback = createMarkdownOpaqueFallback(
		source,
		range,
		"Unsupported, ambiguous, or unclosed Firefly Math syntax remains opaque.",
	);
	return { node: fallback.node, diagnostic: fallback.diagnostic, recognized: false };
}
