import { parseMarkdownDocument } from "./parser";
import { serializeUntouchedMarkdownNodes } from "./document";
import { isMarkdownCrlfInteriorOffset } from "./source-range";
import type { MarkdownCodecDocument, MarkdownCodecNode, MarkdownSourceRange } from "./types";

export type MarkdownCodecEditFailureReason =
	| "invalid-range"
	| "protected-node"
	| "invalid-result"
	| "protected-source-changed";

export interface MarkdownCodecEdit {
	range: MarkdownSourceRange;
	replacement: string;
}

export type MarkdownCodecEditResult =
	| {
			ok: true;
			source: string;
			document: MarkdownCodecDocument;
	  }
	| {
			ok: false;
			reason: MarkdownCodecEditFailureReason;
	  };

function isValidEditRange(source: string, range: MarkdownSourceRange): boolean {
	return (
		Number.isInteger(range.from) &&
		Number.isInteger(range.to) &&
		range.from >= 0 &&
		range.to >= range.from &&
		range.to <= source.length &&
		!isMarkdownCrlfInteriorOffset(source, range.from) &&
		!isMarkdownCrlfInteriorOffset(source, range.to)
	);
}

function editTouchesNode(range: MarkdownSourceRange, node: MarkdownCodecNode): boolean {
	if (range.from === range.to) {
		return range.from > node.range.from && range.from < node.range.to;
	}
	return range.from < node.range.to && range.to > node.range.from;
}

function protectedSource(nodes: readonly MarkdownCodecNode[]): string[] {
	return nodes.filter((node) => node.category !== "structured").map((node) => node.sourceSlice);
}

/**
 * Applies a visual-editor edit only to structured source regions. Any edit touching a placeholder
 * or opaque slice is rejected, then the complete result is reparsed before it is returned.
 */
export function applyMarkdownCodecEdit(
	document: MarkdownCodecDocument,
	edit: MarkdownCodecEdit,
): MarkdownCodecEditResult {
	let source: string;
	try {
		source = serializeUntouchedMarkdownNodes(document.nodes);
	} catch {
		return { ok: false, reason: "invalid-result" };
	}
	if (!isValidEditRange(source, edit.range)) return { ok: false, reason: "invalid-range" };
	if (
		document.nodes.some(
			(node) => editTouchesNode(edit.range, node) && node.category !== "structured",
		)
	) {
		return { ok: false, reason: "protected-node" };
	}

	const nextSource = `${source.slice(0, edit.range.from)}${edit.replacement}${source.slice(edit.range.to)}`;
	const next = parseMarkdownDocument(nextSource);
	if (!next.valid) return { ok: false, reason: "invalid-result" };
	if (
		protectedSource(document.nodes).join("\u0000") !==
		protectedSource(next.document.nodes).join("\u0000")
	) {
		return { ok: false, reason: "protected-source-changed" };
	}
	return { ok: true, source: nextSource, document: next.document };
}
