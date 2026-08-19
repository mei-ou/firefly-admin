import { parseMarkdownDocument } from "../markdown-codec/parser";
import { applyMarkdownCodecEdit } from "../markdown-codec/edit";
import type {
	MarkdownCodecDiagnostic,
	MarkdownCodecDocument,
	MarkdownCodecNode,
	MarkdownSourcePlaceholderKind,
	MarkdownSourceRange,
	MarkdownStructuredNodeKind,
} from "../markdown-codec/types";

export type EditorVisualProjectionNode =
	| {
			category: "structured";
			kind: MarkdownStructuredNodeKind;
			sourceRange: MarkdownSourceRange;
			sourceSlice: string;
			editable: true;
	  }
	| {
			category: "placeholder";
			kind: MarkdownSourcePlaceholderKind;
			sourceRange: MarkdownSourceRange;
			sourceSlice: string;
			label: string;
			editable: false;
	  }
	| {
			category: "opaque";
			sourceRange: MarkdownSourceRange;
			sourceSlice: string;
			reason: string;
			editable: false;
	  };

export interface EditorVisualProjection {
	source: string;
	revision: number;
	nodes: readonly EditorVisualProjectionNode[];
	diagnostics: readonly MarkdownCodecDiagnostic[];
}

const PLACEHOLDER_LABELS: Record<MarkdownSourcePlaceholderKind, string> = {
	callout: "Callout source placeholder",
	details: "Details source placeholder",
	"math-block": "Math source placeholder",
	"math-inline": "Inline math source placeholder",
	mermaid: "Mermaid source placeholder",
	video: "Video source placeholder",
};

function projectNode(node: MarkdownCodecNode): EditorVisualProjectionNode {
	if (node.category === "structured") {
		return {
			category: "structured",
			kind: node.kind,
			sourceRange: { ...node.range },
			sourceSlice: node.sourceSlice,
			editable: true,
		};
	}
	if (node.category === "source-placeholder") {
		return {
			category: "placeholder",
			kind: node.kind,
			sourceRange: { ...node.range },
			sourceSlice: node.sourceSlice,
			label: PLACEHOLDER_LABELS[node.kind],
			editable: false,
		};
	}
	return {
		category: "opaque",
		sourceRange: { ...node.range },
		sourceSlice: node.sourceSlice,
		reason: node.reason,
		editable: false,
	};
}

function sameRange(left: MarkdownSourceRange, right: MarkdownSourceRange): boolean {
	return left.from === right.from && left.to === right.to;
}

function sameNodeIdentity(
	left: EditorVisualProjectionNode,
	right: EditorVisualProjectionNode,
): boolean {
	if (left.category !== right.category) return false;
	if (left.category === "opaque" || right.category === "opaque") return true;
	return left.kind === right.kind;
}

/**
 * Applies a visual projection's edited structured slices back to the original Markdown source.
 * Placeholder and opaque slices are immutable, and projection metadata cannot move nodes around.
 */
export function applyEditorVisualProjectionChanges(
	original: EditorVisualProjection,
	edited: EditorVisualProjection,
	revision = original.revision,
): EditorVisualProjection {
	if (edited.source !== original.source || edited.revision !== original.revision) {
		throw new TypeError("Visual projection is stale or is not backed by the original source.");
	}
	if (edited.nodes.length !== original.nodes.length) {
		throw new TypeError("Visual projection node count changed outside a codec transaction.");
	}

	const parsed = parseMarkdownDocument(original.source);
	if (!parsed.valid) throw new TypeError("Cannot flush a projection with fatal codec diagnostics.");

	const edits: Array<{ from: number; range: MarkdownSourceRange; replacement: string }> = [];
	for (let index = 0; index < original.nodes.length; index += 1) {
		const before = original.nodes[index];
		const after = edited.nodes[index];
		if (!before || !after || !sameNodeIdentity(before, after)) {
			throw new TypeError("Visual projection node identity changed outside a codec transaction.");
		}
		if (!sameRange(before.sourceRange, after.sourceRange)) {
			throw new TypeError("Visual projection source range changed outside a codec transaction.");
		}
		if (before.category !== "structured") {
			if (before.sourceSlice !== after.sourceSlice) {
				throw new TypeError("Placeholder and opaque source slices are read-only in visual mode.");
			}
			continue;
		}
		if (before.sourceSlice !== after.sourceSlice) {
			edits.push({
				from: before.sourceRange.from,
				range: before.sourceRange,
				replacement: after.sourceSlice,
			});
		}
	}

	let source = original.source;
	for (const edit of edits.sort((left, right) => right.from - left.from)) {
		const current = parseMarkdownDocument(source);
		if (!current.valid) throw new TypeError("Visual projection edit produced fatal diagnostics.");
		const result = applyMarkdownCodecEdit(current.document, edit);
		if (!result.ok) throw new TypeError(`Visual projection edit was rejected: ${result.reason}.`);
		source = result.source;
	}
	return createEditorVisualProjection(source, revision);
}

export function createEditorVisualProjection(source: string, revision = 0): EditorVisualProjection {
	const parsed = parseMarkdownDocument(source);
	if (!parsed.valid)
		throw new TypeError("Cannot create a visual projection from fatal diagnostics.");
	return {
		source,
		revision,
		nodes: parsed.document.nodes.map(projectNode),
		diagnostics: [...parsed.document.diagnostics],
	};
}

export function createEditorVisualProjectionFromDocument(
	document: MarkdownCodecDocument,
	revision = 0,
): EditorVisualProjection {
	if (document.diagnostics.some((diagnostic) => diagnostic.severity === "fatal")) {
		throw new TypeError("Cannot create a visual projection from fatal diagnostics.");
	}
	const source = document.nodes.map((node) => node.sourceSlice).join("");
	if (source.length !== document.sourceLength) {
		throw new TypeError("Cannot create a visual projection from uncovered source.");
	}
	return {
		source,
		revision,
		nodes: document.nodes.map(projectNode),
		diagnostics: [...document.diagnostics],
	};
}
