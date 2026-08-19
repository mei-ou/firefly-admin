import { createMarkdownCodecDiagnostic } from "./diagnostics";
import { createMarkdownOpaqueFallback } from "./opaque-fallback";
import { readMarkdownSourceSlice, validateMarkdownSourceRange } from "./source-range";
import type {
	MarkdownCodecDiagnostic,
	MarkdownSourcePlaceholderNode,
	MarkdownSourceRange,
} from "./types";

export type MarkdownMermaidFence = "backtick" | "tilde";

export interface MarkdownMermaidNode extends MarkdownSourcePlaceholderNode {
	kind: "mermaid";
	metadata: Readonly<{
		diagramKind: string;
		fence: MarkdownMermaidFence;
		body: string;
	}>;
}

export interface MarkdownMermaidRecognition {
	node: MarkdownMermaidNode | ReturnType<typeof createMarkdownOpaqueFallback>["node"];
	diagnostic: MarkdownCodecDiagnostic;
	recognized: boolean;
}

function getMermaidDiagnostic(sourceSlice: string): string | undefined {
	const bodyStart = sourceSlice.indexOf("\n") + 1;
	const body = sourceSlice.slice(bodyStart).replace(/^```\s*\r?\n?$/, "");
	if (body.startsWith("%%{init:")) {
		return "Mermaid init directives remain inert; Admin does not execute or normalize them.";
	}
	if (/^\s*click\s+.*javascript:/im.test(body)) {
		return "Mermaid javascript click actions remain inert; Admin does not execute diagram interactions.";
	}
	if (/^\s*(graph|flowchart)\b[\s\S]*-->\s*$/m.test(body)) {
		return "Mermaid source may be malformed; Admin preserves it without executing a renderer.";
	}
	return undefined;
}

function createMermaidNode(
	source: string,
	range: MarkdownSourceRange,
	fence: MarkdownMermaidFence,
	diagramKind: string,
	body: string,
): MarkdownMermaidRecognition {
	const sourceSlice = readMarkdownSourceSlice(source, range);
	const diagnosticMessage = getMermaidDiagnostic(sourceSlice);
	const node: MarkdownMermaidNode = {
		category: "source-placeholder",
		kind: "mermaid",
		dirty: false,
		range,
		sourceSlice,
		metadata: { body, diagramKind, fence },
	};
	return {
		node,
		diagnostic: createMarkdownCodecDiagnostic(source, {
			code: "recognized-placeholder",
			message:
				diagnosticMessage ?? "Firefly Mermaid fence recognized as an inert source placeholder.",
			severity: "info",
			range,
		}),
		recognized: true,
	};
}

/**
 * Recognize Mermaid fences without parsing Mermaid or creating SVG. Lowercase backtick fences have
 * real article evidence; tilde fences are accepted only as a separately diagnosed CommonMark
 * compatibility form. Uppercase language tags and malformed fences remain opaque ordinary code.
 */
export function recognizeMarkdownMermaid(
	source: string,
	range: MarkdownSourceRange = { from: 0, to: source.length },
): MarkdownMermaidRecognition {
	const validation = validateMarkdownSourceRange(source, range);
	if (!validation.valid) {
		throw new TypeError(`Invalid Markdown Mermaid source range: ${validation.reason}.`);
	}

	const sourceSlice = readMarkdownSourceSlice(source, range);
	const match =
		/^(?<fence>`{3,}|~{3,})mermaid\r?\n(?<body>[\s\S]*?)(?:\r?\n)(?<closing>\k<fence>)\r?\n?$/.exec(
			sourceSlice,
		);
	if (!match?.groups) {
		const fallback = createMarkdownOpaqueFallback(
			source,
			range,
			"Unsupported or malformed Mermaid fence remains opaque.",
		);
		return { node: fallback.node, diagnostic: fallback.diagnostic, recognized: false };
	}

	const body = match.groups.body ?? "";
	const firstNonEmptyLine =
		body
			.split(/\r?\n/)
			.find((line) => line.trim().length > 0)
			?.trim() ?? "";
	const diagramKind = firstNonEmptyLine.startsWith("%%{init:") ? "%%{init:" : firstNonEmptyLine;
	const fence: MarkdownMermaidFence = match.groups.fence?.startsWith("`") ? "backtick" : "tilde";
	return createMermaidNode(source, range, fence, diagramKind, body);
}
