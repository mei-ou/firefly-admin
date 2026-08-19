import { createMarkdownCodecDiagnostic } from "./diagnostics";
import { createMarkdownOpaqueFallback } from "./opaque-fallback";
import { readMarkdownSourceSlice, validateMarkdownSourceRange } from "./source-range";
import type {
	MarkdownCalloutType,
	MarkdownCodecDiagnostic,
	MarkdownSourcePlaceholderNode,
	MarkdownSourceRange,
} from "./types";

const CALLOUT_TYPE_BY_MARKER: Readonly<Record<string, MarkdownCalloutType>> = Object.freeze({
	CAUTION: "caution",
	IMPORTANT: "important",
	NOTE: "note",
	TIP: "tip",
	WARNING: "warning",
});

export interface MarkdownCalloutNode extends MarkdownSourcePlaceholderNode {
	kind: "callout";
	metadata: Readonly<{
		type: MarkdownCalloutType;
		title?: string;
	}>;
}

export interface MarkdownCalloutRecognition {
	node: MarkdownCalloutNode | ReturnType<typeof createMarkdownOpaqueFallback>["node"];
	diagnostic: MarkdownCodecDiagnostic;
	recognized: boolean;
}

/**
 * Recognize only the pinned Firefly GitHub callout form. This parser intentionally accepts no raw
 * HTML, directives, custom types, or alternate admonition syntaxes; unsupported input remains an
 * exact opaque source slice so a future adapter cannot accidentally invent a serializer contract.
 */
export function recognizeMarkdownCallout(
	source: string,
	range: MarkdownSourceRange = { from: 0, to: source.length },
): MarkdownCalloutRecognition {
	const validation = validateMarkdownSourceRange(source, range);
	if (!validation.valid) {
		throw new TypeError(`Invalid Markdown Callout source range: ${validation.reason}.`);
	}

	const sourceSlice = readMarkdownSourceSlice(source, range);
	const lines = sourceSlice.split("\n");
	const firstLine = lines[0]?.endsWith("\r") ? lines[0].slice(0, -1) : (lines[0] ?? "");
	const headerMatch = /^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?: (.*))?$/.exec(firstLine);
	const isBlockquote = lines.every((line, index) => {
		const normalizedLine = line.endsWith("\r") ? line.slice(0, -1) : line;
		const isTrailingSourceSeparator = index === lines.length - 1 && normalizedLine === "";
		return isTrailingSourceSeparator || normalizedLine.startsWith("> ") || normalizedLine === ">";
	});
	const marker = headerMatch?.[1];
	const type = marker === undefined ? undefined : CALLOUT_TYPE_BY_MARKER[marker];

	if (!headerMatch || !type || !isBlockquote) {
		const fallback = createMarkdownOpaqueFallback(
			source,
			range,
			"Unsupported or malformed Firefly Callout syntax remains opaque.",
		);
		return { node: fallback.node, diagnostic: fallback.diagnostic, recognized: false };
	}

	const title = headerMatch[2];
	const node: MarkdownCalloutNode = {
		category: "source-placeholder",
		kind: "callout",
		dirty: false,
		range,
		sourceSlice,
		metadata: title === undefined ? { type } : { type, title },
	};
	return {
		node,
		diagnostic: createMarkdownCodecDiagnostic(source, {
			code: "recognized-placeholder",
			message: "Firefly Callout recognized as an inert source placeholder.",
			severity: "info",
			range,
		}),
		recognized: true,
	};
}
