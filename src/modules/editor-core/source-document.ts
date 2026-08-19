import {
	buildEditableMarkdownDocument,
	parseEditableMarkdownDocument,
} from "../../utils/frontmatter-utils";

export interface EditorSourceDocument {
	frontmatter: Readonly<Record<string, unknown>>;
	unknownFrontmatter: Readonly<Record<string, unknown>>;
	markdown: string;
	slug?: string;
}

/** Parses the complete source atomically; callers receive no partial document on failure. */
export function parseEditorSourceDocument(source: string): EditorSourceDocument {
	const parsed = parseEditableMarkdownDocument(source);
	return {
		frontmatter: { ...parsed.frontmatter },
		unknownFrontmatter: { ...parsed.unknownFrontmatter },
		markdown: parsed.markdown,
		...(parsed.slug === undefined ? {} : { slug: parsed.slug }),
	};
}

export interface BuildEditorSourceDocumentInput {
	frontmatter: Readonly<Record<string, unknown>>;
	unknownFrontmatter: Readonly<Record<string, unknown>>;
	markdown: string;
	slug?: string;
}

export function buildEditorSourceDocument(input: BuildEditorSourceDocumentInput): string {
	return buildEditableMarkdownDocument(
		input.frontmatter,
		input.unknownFrontmatter,
		input.markdown,
		input.slug,
	);
}

export type EditorSourceParseResult = { ok: true; document: EditorSourceDocument } | { ok: false };

export function tryParseEditorSourceDocument(source: string): EditorSourceParseResult {
	try {
		return { ok: true, document: parseEditorSourceDocument(source) };
	} catch {
		return { ok: false };
	}
}
