import { recognizeMarkdownCallout } from "./callout";
import { createMarkdownCodecDocument, type CreateMarkdownCodecDocumentResult } from "./document";
import { recognizeMarkdownDetails } from "./details";
import { recognizeMarkdownMath } from "./math";
import { recognizeMarkdownMermaid } from "./mermaid";
import {
	isMarkdownRecognizerResultRecognized,
	validateMarkdownRecognizerResult,
	type MarkdownRecognizerResult,
} from "./recognizer-protocol";
import { createMarkdownOpaqueFallback } from "./opaque-fallback";
import { createMarkdownSourceCursor, type MarkdownSourceLine } from "./source-cursor";
import { recognizeMarkdownVideo } from "./video";
import type {
	MarkdownCodecDiagnostic,
	MarkdownCodecNode,
	MarkdownSourceRange,
	MarkdownStructuredNodeKind,
} from "./types";

export interface ParseMarkdownDocumentOptions {
	readonly maxIterations?: number;
}

const DEFAULT_MAX_ITERATIONS = 100_000;

function createTextNode(
	source: string,
	range: MarkdownSourceRange,
	kind: MarkdownStructuredNodeKind = "text",
): MarkdownCodecNode {
	return {
		category: "structured",
		kind,
		dirty: false,
		range,
		sourceSlice: source.slice(range.from, range.to),
	};
}

function createCodeBlockNode(source: string, range: MarkdownSourceRange): MarkdownCodecNode {
	return {
		category: "structured",
		kind: "code-block",
		dirty: false,
		range,
		sourceSlice: source.slice(range.from, range.to),
	};
}

function normalizeLineText(line: MarkdownSourceLine): string {
	return line.text.endsWith("\r") ? line.text.slice(0, -1) : line.text;
}

function appendTextNode(
	source: string,
	range: MarkdownSourceRange,
	nodes: MarkdownCodecNode[],
	kind: MarkdownStructuredNodeKind = "text",
): void {
	if (range.from < range.to) nodes.push(createTextNode(source, range, kind));
}

function getOrdinaryLineKind(
	lineText: string,
): "blockquote" | "heading" | "list" | "paragraph" | "thematic-break" {
	if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(lineText)) return "heading";
	if (/^ {0,3}(?:\*\s*){3,}$/.test(lineText) || /^ {0,3}(?:-\s*){3,}$/.test(lineText)) {
		return "thematic-break";
	}
	if (/^ {0,3}> ?/.test(lineText)) return "blockquote";
	if (/^ {0,3}(?:[-+*]|\d+[.)])[ \t]+/.test(lineText)) return "list";
	return "paragraph";
}

function findInlineCodeEnd(source: string, from: number, to: number): number | null {
	let runLength = 0;
	while (from + runLength < to && source[from + runLength] === "`") runLength += 1;
	const closing = "`".repeat(runLength);
	const closingFrom = source.indexOf(closing, from + runLength);
	return closingFrom < 0 ? null : closingFrom + runLength;
}

function appendInlineTextAndMath(
	source: string,
	range: MarkdownSourceRange,
	nodes: MarkdownCodecNode[],
	diagnostics: MarkdownCodecDiagnostic[],
	plainKind: MarkdownStructuredNodeKind,
): void {
	let currentOffset = range.from;
	while (currentOffset < range.to) {
		if (source[currentOffset] === "`") {
			const codeEnd = findInlineCodeEnd(source, currentOffset, range.to);
			if (codeEnd !== null) {
				let nextDollar = codeEnd;
				while (nextDollar < range.to && source[nextDollar] !== "$") nextDollar += 1;
				appendTextNode(source, { from: currentOffset, to: nextDollar }, nodes);
				currentOffset = nextDollar;
				continue;
			}
		}
		const probeRange = { from: currentOffset, to: range.to };
		const recognition = recognizeMarkdownMath(source, probeRange);
		if (!recognition.recognized) {
			appendTextNode(source, probeRange, nodes, plainKind);
			return;
		}

		const result: MarkdownRecognizerResult = {
			candidateRange: probeRange,
			disposition: "recognized",
			node: recognition.node,
			diagnostic: recognition.diagnostic,
		};
		const rangeValidation = validateMarkdownRecognizerResult(source, result);
		if (!rangeValidation.valid || !isMarkdownRecognizerResultRecognized(result)) {
			appendTextNode(source, probeRange, nodes, plainKind);
			return;
		}

		const mathRange = result.node.range;
		if (mathRange.from < currentOffset || mathRange.to > range.to) {
			appendTextNode(source, probeRange, nodes, plainKind);
			return;
		}
		appendTextNode(source, { from: currentOffset, to: mathRange.from }, nodes);
		nodes.push(result.node);
		diagnostics.push(result.diagnostic);
		if (mathRange.to <= currentOffset) {
			appendTextNode(source, probeRange, nodes, plainKind);
			return;
		}
		currentOffset = mathRange.to;
	}
}

function getFenceOpening(lineText: string): { marker: string; info: string } | null {
	const match = /^ {0,3}(?<marker>`{3,}|~{3,})(?<info>.*)$/.exec(lineText);
	if (!match?.groups) return null;
	return { marker: match.groups.marker ?? "", info: (match.groups.info ?? "").trim() };
}

function isFenceClosing(lineText: string, openingMarker: string): boolean {
	const closing = new RegExp(`^ {0,3}(${openingMarker[0]}{${openingMarker.length},})\\s*$`);
	return closing.test(lineText);
}

function findFenceEnd(
	lines: readonly MarkdownSourceLine[],
	startIndex: number,
	marker: string,
): number {
	for (let index = startIndex + 1; index < lines.length; index += 1) {
		if (isFenceClosing(normalizeLineText(lines[index] as MarkdownSourceLine), marker)) return index;
	}
	return -1;
}

function findLineWithText(
	lines: readonly MarkdownSourceLine[],
	startIndex: number,
	text: string,
): number {
	for (let index = startIndex; index < lines.length; index += 1) {
		if (normalizeLineText(lines[index] as MarkdownSourceLine) === text) return index;
	}
	return -1;
}

function getCandidateRange(
	lines: readonly MarkdownSourceLine[],
	fromIndex: number,
	toIndex: number,
): MarkdownSourceRange {
	const first = lines[fromIndex];
	const last = lines[toIndex];
	if (!first || !last) throw new Error("Markdown parser candidate line is missing.");
	return { from: first.range.from, to: last.range.to };
}

function appendRecognizerNode(
	source: string,
	candidateRange: MarkdownSourceRange,
	recognition: {
		node: MarkdownCodecNode;
		diagnostic: MarkdownCodecDiagnostic;
		recognized?: boolean;
		disposition?: "blocked" | "opaque" | "structured";
	},
	nodes: MarkdownCodecNode[],
	diagnostics: MarkdownCodecDiagnostic[],
): boolean {
	const result: MarkdownRecognizerResult = {
		candidateRange,
		disposition:
			recognition.recognized === false ||
			recognition.disposition === "opaque" ||
			recognition.disposition === "blocked"
				? "opaque"
				: "recognized",
		node: recognition.node,
		diagnostic: recognition.diagnostic,
	};
	const validation = validateMarkdownRecognizerResult(source, result);
	if (!validation.valid) return false;
	nodes.push(result.node);
	diagnostics.push(result.diagnostic);
	return true;
}

function findRawHtmlEnd(lines: readonly MarkdownSourceLine[], startIndex: number): number {
	const lineText = normalizeLineText(lines[startIndex] as MarkdownSourceLine);
	if (/^\s*<!--/.test(lineText)) {
		for (let index = startIndex; index < lines.length; index += 1) {
			if (normalizeLineText(lines[index] as MarkdownSourceLine).includes("-->")) return index;
		}
		return lines.length - 1;
	}
	const openingMatch = /^\s*<([A-Za-z][A-Za-z0-9:-]*)\b[^>]*>/.exec(lineText);
	if (!openingMatch || /\/\s*>$/.test(lineText)) return startIndex;
	const tagName = openingMatch[1];
	if (!tagName || /^\s*<\//.test(lineText) || new RegExp(`</${tagName}\\s*>`, "i").test(lineText)) {
		return startIndex;
	}
	const closingPattern = new RegExp(`^\\s*</${tagName}\\s*>\\s*$`, "i");
	for (let index = startIndex + 1; index < lines.length; index += 1) {
		if (closingPattern.test(normalizeLineText(lines[index] as MarkdownSourceLine))) return index;
	}
	return startIndex;
}

function isRawHtmlCandidate(lineText: string): boolean {
	return /^\s*(?:<!--[\s\S]*|<\/?[A-Za-z][A-Za-z0-9:-]*(?:\s|\/?>))/.test(lineText);
}

function readAllSourceLines(source: string): MarkdownSourceLine[] {
	const cursor = createMarkdownSourceCursor(source);
	const lines: MarkdownSourceLine[] = [];
	while (!cursor.atEnd) {
		const line = cursor.readLine();
		if (!line) break;
		lines.push(line);
		cursor.advanceTo(line.range.to);
	}
	return lines;
}

function createFailureOpaque(
	source: string,
	range: MarkdownSourceRange,
	reason: string,
	nodes: MarkdownCodecNode[],
	diagnostics: MarkdownCodecDiagnostic[],
): void {
	const fallback = createMarkdownOpaqueFallback(source, range, reason);
	nodes.push(fallback.node);
	diagnostics.push(fallback.diagnostic);
}

/**
 * Parses the source into a complete, source-backed document without constructing DOM or editor JSON.
 * This first milestone deliberately treats ordinary Markdown as text fragments; special syntax is
 * recognized only after a complete block candidate has been isolated.
 */
export function parseMarkdownDocument(
	source: string,
	options: ParseMarkdownDocumentOptions = {},
): CreateMarkdownCodecDocumentResult {
	if (source.length === 0) return createMarkdownCodecDocument(source, []);

	const lines = readAllSourceLines(source);
	const nodes: MarkdownCodecNode[] = [];
	const diagnostics: MarkdownCodecDiagnostic[] = [];
	const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
	let lineIndex = 0;
	let currentOffset = 0;
	let iterations = 0;

	while (lineIndex < lines.length) {
		iterations += 1;
		if (iterations > maxIterations) {
			createFailureOpaque(
				source,
				{ from: currentOffset, to: source.length },
				"Markdown parser iteration budget exhausted; remaining source remains opaque.",
				nodes,
				diagnostics,
			);
			break;
		}

		const line = lines[lineIndex];
		if (!line) break;
		const lineText = normalizeLineText(line);
		const fence = getFenceOpening(lineText);
		if (fence) {
			const endIndex = findFenceEnd(lines, lineIndex, fence.marker);
			if (endIndex < 0) {
				createFailureOpaque(
					source,
					{ from: line.range.from, to: source.length },
					"Unclosed Markdown fence remains opaque.",
					nodes,
					diagnostics,
				);
				break;
			}
			const candidateRange = getCandidateRange(lines, lineIndex, endIndex);
			if (fence.info === "mermaid") {
				const recognition = recognizeMarkdownMermaid(source, candidateRange);
				if (!appendRecognizerNode(source, candidateRange, recognition, nodes, diagnostics)) {
					createFailureOpaque(
						source,
						candidateRange,
						"Invalid Mermaid recognizer result remains opaque.",
						nodes,
						diagnostics,
					);
				}
			} else {
				nodes.push(createCodeBlockNode(source, candidateRange));
			}
			currentOffset = candidateRange.to;
			lineIndex = endIndex + 1;
			continue;
		}

		if (lineText === "<details>" || lineText === "<details open>") {
			const endIndex = findLineWithText(lines, lineIndex + 1, "</details>");
			if (endIndex < 0) {
				createFailureOpaque(
					source,
					{ from: line.range.from, to: source.length },
					"Unclosed Details block remains opaque.",
					nodes,
					diagnostics,
				);
				break;
			}
			const candidateRange = getCandidateRange(lines, lineIndex, endIndex);
			const recognition = recognizeMarkdownDetails(source, candidateRange);
			if (!appendRecognizerNode(source, candidateRange, recognition, nodes, diagnostics)) {
				createFailureOpaque(
					source,
					candidateRange,
					"Invalid Details recognizer result remains opaque.",
					nodes,
					diagnostics,
				);
			}
			currentOffset = candidateRange.to;
			lineIndex = endIndex + 1;
			continue;
		}

		if (/^> \[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?: .*)?$/.test(lineText)) {
			let endIndex = lineIndex;
			while (endIndex + 1 < lines.length) {
				const nextText = normalizeLineText(lines[endIndex + 1] as MarkdownSourceLine);
				if (!nextText.startsWith("> ") && nextText !== ">") break;
				endIndex += 1;
			}
			const candidateRange = getCandidateRange(lines, lineIndex, endIndex);
			const recognition = recognizeMarkdownCallout(source, candidateRange);
			if (!appendRecognizerNode(source, candidateRange, recognition, nodes, diagnostics)) {
				createFailureOpaque(
					source,
					candidateRange,
					"Invalid Callout recognizer result remains opaque.",
					nodes,
					diagnostics,
				);
			}
			currentOffset = candidateRange.to;
			lineIndex = endIndex + 1;
			continue;
		}

		if (lineText === "$$") {
			const endIndex = findLineWithText(lines, lineIndex + 1, "$$");
			if (endIndex >= 0) {
				const candidateRange = getCandidateRange(lines, lineIndex, endIndex);
				const recognition = recognizeMarkdownMath(source, candidateRange);
				if (!appendRecognizerNode(source, candidateRange, recognition, nodes, diagnostics)) {
					createFailureOpaque(
						source,
						candidateRange,
						"Invalid Math recognizer result remains opaque.",
						nodes,
						diagnostics,
					);
				}
				currentOffset = candidateRange.to;
				lineIndex = endIndex + 1;
				continue;
			}
			createFailureOpaque(
				source,
				{ from: line.range.from, to: source.length },
				"Unclosed Math block remains opaque.",
				nodes,
				diagnostics,
			);
			break;
		}

		if (/^\s*<iframe\b/i.test(lineText)) {
			const candidateRange = line.range;
			const recognition = recognizeMarkdownVideo(source, candidateRange);
			if (!appendRecognizerNode(source, candidateRange, recognition, nodes, diagnostics)) {
				createFailureOpaque(
					source,
					candidateRange,
					"Invalid Video recognizer result remains opaque.",
					nodes,
					diagnostics,
				);
			}
			currentOffset = candidateRange.to;
			lineIndex += 1;
			continue;
		}

		if (isRawHtmlCandidate(lineText)) {
			const endIndex = findRawHtmlEnd(lines, lineIndex);
			const candidateRange = getCandidateRange(lines, lineIndex, endIndex);
			createFailureOpaque(
				source,
				candidateRange,
				"Unknown or unsafe raw HTML remains opaque.",
				nodes,
				diagnostics,
			);
			currentOffset = candidateRange.to;
			lineIndex = endIndex + 1;
			continue;
		}

		appendInlineTextAndMath(
			source,
			line.contentRange,
			nodes,
			diagnostics,
			getOrdinaryLineKind(lineText),
		);
		if (line.newlineRange) appendTextNode(source, line.newlineRange, nodes);
		currentOffset = line.range.to;
		lineIndex += 1;
	}

	if (currentOffset < source.length && nodes.length > 0) {
		const lastNode = nodes[nodes.length - 1];
		if (lastNode && lastNode.range.to < source.length) {
			createFailureOpaque(
				source,
				{ from: lastNode.range.to, to: source.length },
				"Parser stopped before EOF; remaining source remains opaque.",
				nodes,
				diagnostics,
			);
		}
	}
	return createMarkdownCodecDocument(source, nodes, diagnostics);
}
