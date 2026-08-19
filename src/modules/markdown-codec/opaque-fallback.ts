import { createMarkdownCodecDiagnostic } from "./diagnostics";
import { readMarkdownSourceSlice } from "./source-range";
import type { MarkdownCodecDiagnostic, MarkdownOpaqueNode, MarkdownSourceRange } from "./types";

export interface MarkdownOpaqueFallback {
	node: MarkdownOpaqueNode;
	diagnostic: MarkdownCodecDiagnostic;
}

/**
 * Unknown input is preserved rather than guessed. The returned node contains no renderer or HTML;
 * an eventual visual adapter may only show an escaped local summary of `sourceSlice`.
 */
export function createMarkdownOpaqueFallback(
	source: string,
	range: MarkdownSourceRange,
	reason: string,
): MarkdownOpaqueFallback {
	const sourceSlice = readMarkdownSourceSlice(source, range);
	return {
		node: {
			category: "opaque",
			kind: "opaque",
			dirty: false,
			range,
			sourceSlice,
			reason,
		},
		diagnostic: createMarkdownCodecDiagnostic(source, {
			code: "opaque-fallback",
			message: reason,
			severity: "warning",
			range,
		}),
	};
}
