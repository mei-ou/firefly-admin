import type { MarkdownCodecNode, MarkdownSourceLocation, MarkdownSourceRange } from "./types";

export interface MarkdownSourceRangeValidation {
	valid: boolean;
	reason: "crlf-split" | "empty-or-reversed" | "non-integer" | "out-of-bounds" | null;
}

/** A source-backed node may not divide a CRLF pair into separate slices. */
export function isMarkdownCrlfInteriorOffset(source: string, offset: number): boolean {
	return (
		offset > 0 && offset < source.length && source[offset - 1] === "\r" && source[offset] === "\n"
	);
}

/**
 * Codec offsets deliberately follow JavaScript string slicing, so astral Unicode characters count
 * as two UTF-16 code units. Mixing code-point or byte offsets would corrupt later source splicing.
 * CRLF is one logical newline and node boundaries may only occur before `\r` or after `\n`.
 */
export function validateMarkdownSourceRange(
	source: string,
	range: MarkdownSourceRange,
): MarkdownSourceRangeValidation {
	if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) {
		return { valid: false, reason: "non-integer" };
	}
	if (range.from < 0 || range.to < 0 || range.from > source.length || range.to > source.length) {
		return { valid: false, reason: "out-of-bounds" };
	}
	if (range.from >= range.to) {
		return { valid: false, reason: "empty-or-reversed" };
	}
	if (
		isMarkdownCrlfInteriorOffset(source, range.from) ||
		isMarkdownCrlfInteriorOffset(source, range.to)
	) {
		return { valid: false, reason: "crlf-split" };
	}
	return { valid: true, reason: null };
}

export function readMarkdownSourceSlice(source: string, range: MarkdownSourceRange): string {
	const validation = validateMarkdownSourceRange(source, range);
	if (!validation.valid) {
		throw new TypeError(`Invalid Markdown source range: ${validation.reason}.`);
	}
	return source.slice(range.from, range.to);
}

export function getMarkdownSourceLocation(
	source: string,
	offset: number,
): MarkdownSourceLocation | null {
	if (!Number.isInteger(offset) || offset < 0 || offset > source.length) return null;

	let line = 1;
	let column = 1;
	for (let index = 0; index < offset; index += 1) {
		const character = source[index];
		if (character === "\r") {
			if (source[index + 1] === "\n") index += 1;
			line += 1;
			column = 1;
		} else if (character === "\n") {
			line += 1;
			column = 1;
		} else {
			column += 1;
		}
	}
	return { line, column };
}

export function sourceSliceMatchesNode(source: string, node: MarkdownCodecNode): boolean {
	const validation = validateMarkdownSourceRange(source, node.range);
	return validation.valid && source.slice(node.range.from, node.range.to) === node.sourceSlice;
}
