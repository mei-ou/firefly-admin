import { validateMarkdownSourceRange } from "./source-range";
import { parseMarkdownDocument } from "./parser";
import type { MarkdownCodecDocument, MarkdownCodecNode } from "./types";

function getNodeSource(node: MarkdownCodecNode): string {
	if (node.category !== "structured" || !node.dirty) return node.sourceSlice;
	if (node.serializedSource === undefined) {
		throw new TypeError("A dirty structured Markdown node must provide canonical source.");
	}
	return node.serializedSource;
}

/**
 * Serializes only source-backed codec nodes. Placeholder and opaque nodes never acquire a new
 * source form; a structured adapter must explicitly provide canonical Markdown after an edit.
 */
export function serializeMarkdownCodecDocument(document: MarkdownCodecDocument): string {
	if (document.diagnostics.some((diagnostic) => diagnostic.severity === "fatal")) {
		throw new TypeError("Cannot serialize a Markdown document with fatal codec diagnostics.");
	}

	const source = document.nodes.map((node) => node.sourceSlice).join("");
	let expectedFrom = 0;
	const chunks: string[] = [];
	for (const node of document.nodes) {
		const validation = validateMarkdownSourceRange(source, node.range);
		if (!validation.valid || node.range.from !== expectedFrom) {
			throw new TypeError("Cannot serialize an unordered or gapped Markdown codec document.");
		}
		chunks.push(getNodeSource(node));
		expectedFrom = node.range.to;
	}
	if (expectedFrom !== document.sourceLength) {
		throw new TypeError("Cannot serialize a Markdown codec document with uncovered source.");
	}
	return chunks.join("");
}

/**
 * The first codec milestone preserves untouched source exactly. This is intentionally an
 * idempotent canonicalization boundary until a structured adapter marks a node dirty.
 */
export function canonicalizeMarkdownSource(source: string): string {
	const parsed = parseMarkdownDocument(source);
	if (!parsed.valid) throw new TypeError("Cannot canonicalize an invalid Markdown codec document.");
	return serializeMarkdownCodecDocument(parsed.document);
}

export function serializeUntouchedMarkdownDocument(document: MarkdownCodecDocument): string {
	for (const node of document.nodes) {
		if (node.dirty) throw new TypeError("Dirty structured nodes require an explicit serializer.");
	}
	return serializeMarkdownCodecDocument(document);
}
