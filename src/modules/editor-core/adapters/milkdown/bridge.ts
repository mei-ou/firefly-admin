import { applyEditorVisualProjectionChanges, createEditorVisualProjection } from "../../projection";
import type { EditorVisualProjection } from "../../projection";

export interface BridgeProjection {
	/** Original Markdown source; this remains the only value eligible for persistence. */
	readonly source: string;
	/** Original Markdown passed to Milkdown; special syntax is replaced in the remark AST. */
	readonly markdown: string;
	/** Source-aware projection used for protected visual transactions. */
	readonly visualProjection: EditorVisualProjection;
	/** Every codec node as `category:kind`, in source order, for test assertions. */
	readonly nodeKinds: readonly string[];
	readonly nodeCount: number;
	readonly structuralCount: number;
	readonly placeholderCount: number;
	readonly opaqueCount: number;
}

export interface BridgeSourceNodeMetadata {
	readonly sourceRangeFrom: number;
	readonly sourceRangeTo: number;
	readonly sourceSlice: string;
	readonly category: "placeholder" | "opaque";
	readonly kind: string;
	readonly editable: false;
}

/**
 * Consume the real source-aware codec projection and prepare the original Markdown for Milkdown.
 *
 * Special source ranges are converted to `firefly_source` atom nodes by the Milkdown
 * remark/parser adapter. No synthetic Markdown, HTML, ProseMirror JSON, or executable preview is
 * produced here.
 *
 * The adapter exposes only source-aware Markdown and is safe to use from the production editor.
 */
function renderProjection(visualProjection: EditorVisualProjection): BridgeProjection {
	const nodeKinds: string[] = [];
	let structuralCount = 0;
	let placeholderCount = 0;
	let opaqueCount = 0;

	for (const node of visualProjection.nodes) {
		nodeKinds.push(node.category === "opaque" ? "opaque:opaque" : `${node.category}:${node.kind}`);
		if (node.category === "structured") {
			structuralCount += 1;
			continue;
		}
		if (node.category === "opaque") opaqueCount += 1;
		else placeholderCount += 1;
	}

	return {
		source: visualProjection.source,
		markdown: visualProjection.source,
		visualProjection,
		nodeKinds,
		nodeCount: visualProjection.nodes.length,
		structuralCount,
		placeholderCount,
		opaqueCount,
	};
}

export function projectCodecToMilkdownMarkdown(source: string): BridgeProjection {
	return renderProjection(createEditorVisualProjection(source));
}

/** Flushes only source-aware projection edits; Milkdown state is never persisted. */
export function flushBridgeProjection(
	original: BridgeProjection,
	edited: BridgeProjection,
): BridgeProjection {
	return renderProjection(
		applyEditorVisualProjectionChanges(original.visualProjection, edited.visualProjection),
	);
}

function protectedSignatures(projection: EditorVisualProjection): string[] {
	return projection.nodes
		.filter((node) => node.category === "placeholder" || node.category === "opaque")
		.map((node) =>
			JSON.stringify({
				category: node.category,
				kind: node.category === "opaque" ? "opaque" : node.kind,
				sourceSlice: node.sourceSlice,
			}),
		);
}

/**
 * Flushes Markdown serialized from a real Milkdown document.
 *
 * The serializer output is treated as a candidate source transaction, never as a persisted editor
 * format. Re-parsing it through the codec allows ordinary structured Markdown to change while
 * requiring every protected source slice to remain byte-for-byte and kind-for-kind identical.
 */
export function flushMilkdownMarkdown(
	original: BridgeProjection,
	serializedMarkdown: string,
): BridgeProjection {
	const edited = projectCodecToMilkdownMarkdown(serializedMarkdown);
	const expected = protectedSignatures(original.visualProjection);
	const actual = protectedSignatures(edited.visualProjection);
	if (
		expected.length !== actual.length ||
		expected.some((signature, index) => signature !== actual[index])
	) {
		throw new TypeError("Milkdown serializer changed a protected source slice.");
	}
	return edited;
}

/**
 * Validates source metadata collected from actual Milkdown NodeViews before a source transaction.
 * The returned projection still comes from the original Markdown; NodeView DOM/attrs are never a
 * persistence format.
 */
export function flushBridgeNodeViewMetadata(
	original: BridgeProjection,
	metadata: readonly BridgeSourceNodeMetadata[],
): BridgeProjection {
	const protectedNodes = original.visualProjection.nodes.filter(
		(node) => node.category === "placeholder" || node.category === "opaque",
	);
	if (metadata.length !== protectedNodes.length) {
		throw new TypeError(
			"Milkdown source NodeView metadata count changed outside a codec transaction.",
		);
	}
	for (let index = 0; index < protectedNodes.length; index += 1) {
		const expected = protectedNodes[index];
		const actual = metadata[index];
		if (!expected || !actual)
			throw new TypeError("Milkdown source NodeView metadata is incomplete.");
		const expectedKind = expected.category === "opaque" ? "opaque" : expected.kind;
		if (
			actual.sourceRangeFrom !== expected.sourceRange.from ||
			actual.sourceRangeTo !== expected.sourceRange.to ||
			actual.sourceSlice !== expected.sourceSlice ||
			actual.category !== expected.category ||
			actual.kind !== expectedKind ||
			actual.editable !== false
		) {
			throw new TypeError("Milkdown source NodeView metadata is stale or was edited.");
		}
	}
	return renderProjection(original.visualProjection);
}
