import { createMarkdownCodecDiagnostic } from "./diagnostics";
import { sourceSliceMatchesNode, validateMarkdownSourceRange } from "./source-range";
import type { MarkdownCodecDiagnostic, MarkdownCodecDocument, MarkdownCodecNode } from "./types";

export interface CreateMarkdownCodecDocumentResult {
	document: MarkdownCodecDocument;
	valid: boolean;
}

/**
 * A source-backed document must explain every UTF-16 code unit exactly once. Gaps, overlap, or a
 * mismatched slice fail closed before any visual adapter can mount a partial projection.
 */
export function createMarkdownCodecDocument(
	source: string,
	nodes: readonly MarkdownCodecNode[],
	diagnostics: readonly MarkdownCodecDiagnostic[] = [],
): CreateMarkdownCodecDocumentResult {
	const structuralDiagnostics: MarkdownCodecDiagnostic[] = [];
	const validNodes: MarkdownCodecNode[] = [];
	let previousFrom = -1;
	let rangesAreOrdered = true;

	for (const node of nodes) {
		const rangeValidation = validateMarkdownSourceRange(source, node.range);
		if (!rangeValidation.valid) {
			structuralDiagnostics.push(
				createMarkdownCodecDiagnostic(source, {
					code: "invalid-source-range",
					message: `Invalid Markdown node source range: ${rangeValidation.reason}.`,
					severity: "fatal",
					range: node.range,
				}),
			);
			continue;
		}

		validNodes.push(node);
		if (node.range.from < previousFrom) {
			rangesAreOrdered = false;
			structuralDiagnostics.push(
				createMarkdownCodecDiagnostic(source, {
					code: "unsorted-source-range",
					message: "Markdown codec nodes must remain in ascending source order.",
					severity: "fatal",
					range: node.range,
				}),
			);
		}
		previousFrom = node.range.from;

		if (!sourceSliceMatchesNode(source, node)) {
			structuralDiagnostics.push(
				createMarkdownCodecDiagnostic(source, {
					code: "source-slice-mismatch",
					message: "Markdown node source slice does not match its UTF-16 range.",
					severity: "fatal",
					range: node.range,
				}),
			);
		}
	}

	if (validNodes.length === nodes.length && rangesAreOrdered) {
		let expectedFrom = 0;
		for (const node of validNodes) {
			if (node.range.from < expectedFrom) {
				structuralDiagnostics.push(
					createMarkdownCodecDiagnostic(source, {
						code: "overlapping-source-range",
						message: "Markdown codec nodes must not overlap.",
						severity: "fatal",
						range: node.range,
					}),
				);
			} else if (node.range.from > expectedFrom) {
				structuralDiagnostics.push(
					createMarkdownCodecDiagnostic(source, {
						code: "source-gap",
						message: "Markdown codec nodes must cover the source without gaps.",
						severity: "fatal",
						range: { from: expectedFrom, to: node.range.from },
					}),
				);
			}
			expectedFrom = Math.max(expectedFrom, node.range.to);
		}

		if (expectedFrom < source.length) {
			structuralDiagnostics.push(
				createMarkdownCodecDiagnostic(source, {
					code: "source-gap",
					message: "Markdown codec nodes do not cover the source suffix.",
					severity: "fatal",
					range: { from: expectedFrom, to: source.length },
				}),
			);
		}
	}

	const allDiagnostics = [...diagnostics, ...structuralDiagnostics];
	return {
		document: {
			sourceLength: source.length,
			nodes,
			diagnostics: allDiagnostics,
		},
		valid: !allDiagnostics.some((diagnostic) => diagnostic.severity === "fatal"),
	};
}

/**
 * Untouched source-backed nodes serialize by concatenating exact slices, never through HTML.
 * This guard does not replace document validation, but prevents callers from serializing an
 * obviously unordered, overlapping, gapped, or length-mismatched node sequence.
 */
export function serializeUntouchedMarkdownNodes(nodes: readonly MarkdownCodecNode[]): string {
	let expectedFrom = 0;
	for (const node of nodes) {
		if (
			node.dirty !== false ||
			node.range.from !== expectedFrom ||
			!Number.isInteger(node.range.to) ||
			node.range.to <= node.range.from ||
			node.sourceSlice.length !== node.range.to - node.range.from
		) {
			throw new TypeError("Cannot serialize an invalid Markdown source-backed node sequence.");
		}
		expectedFrom = node.range.to;
	}
	return nodes.map((node) => node.sourceSlice).join("");
}
