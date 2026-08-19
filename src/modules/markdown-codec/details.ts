import { createMarkdownCodecDiagnostic } from "./diagnostics";
import { createMarkdownOpaqueFallback } from "./opaque-fallback";
import { readMarkdownSourceSlice, validateMarkdownSourceRange } from "./source-range";
import type {
	MarkdownCodecDiagnostic,
	MarkdownSourcePlaceholderNode,
	MarkdownSourceRange,
} from "./types";

export interface MarkdownDetailsNode extends MarkdownSourcePlaceholderNode {
	kind: "details";
	metadata: Readonly<{
		bodyMarkdown: string;
		open: boolean;
		summary: string;
	}>;
}

export interface MarkdownDetailsRecognition {
	node: MarkdownDetailsNode | ReturnType<typeof createMarkdownOpaqueFallback>["node"];
	diagnostic: MarkdownCodecDiagnostic;
	recognized: boolean;
}

function normalizeMarkdownLineEndings(source: string): string {
	return source.replaceAll("\r\n", "\n");
}

function containsUnsafeDetailsHtml(bodyMarkdown: string): boolean {
	return /<!--|<\/?[A-Za-z][^>]*>/.test(bodyMarkdown);
}

/**
 * Recognize only the audited Firefly Details subset. The visual projection stays inert and never
 * creates native Details/Summary DOM. Extra attributes, nested raw HTML, ambiguous boundaries, and
 * malformed blocks fail closed into an exact opaque source slice.
 */
export function recognizeMarkdownDetails(
	source: string,
	range: MarkdownSourceRange = { from: 0, to: source.length },
): MarkdownDetailsRecognition {
	const validation = validateMarkdownSourceRange(source, range);
	if (!validation.valid) {
		throw new TypeError(`Invalid Markdown Details source range: ${validation.reason}.`);
	}

	const sourceSlice = readMarkdownSourceSlice(source, range);
	const normalizedSource = normalizeMarkdownLineEndings(sourceSlice);
	const match =
		/^<details( open)?>\n<summary>([^\n<>]*)<\/summary>\n\n([\s\S]*?)<\/details>\n?$/.exec(
			normalizedSource,
		);
	const bodyMarkdown = match?.[3];
	if (!match || bodyMarkdown === undefined || containsUnsafeDetailsHtml(bodyMarkdown)) {
		const fallback = createMarkdownOpaqueFallback(
			source,
			range,
			"Unsupported, unsafe, or malformed Firefly Details syntax remains opaque.",
		);
		return { node: fallback.node, diagnostic: fallback.diagnostic, recognized: false };
	}

	const node: MarkdownDetailsNode = {
		category: "source-placeholder",
		kind: "details",
		dirty: false,
		range,
		sourceSlice,
		metadata: {
			bodyMarkdown,
			open: match[1] === " open",
			summary: match[2] ?? "",
		},
	};
	return {
		node,
		diagnostic: createMarkdownCodecDiagnostic(source, {
			code: "recognized-placeholder",
			message: "Firefly Details recognized as an inert source placeholder.",
			severity: "info",
			range,
		}),
		recognized: true,
	};
}
