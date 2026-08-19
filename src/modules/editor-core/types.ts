import type { MarkdownCodecDiagnostic } from "../markdown-codec/types";

export type EditorMode = "source" | "visual";
export type EditorCommandCategory = "block" | "inline" | "special";
export type EditorCommandStatus = "blocked" | "enabled" | "placeholder";
export type VisualEditorCommand =
	| "bold"
	| "italic"
	| "strikethrough"
	| "inline-code"
	| "heading-1"
	| "heading-2"
	| "heading-3"
	| "heading-4"
	| "heading-5"
	| "heading-6"
	| "paragraph"
	| "quote"
	| "unordered-list"
	| "ordered-list"
	| "code-block"
	| "table"
	| "divider";

export interface EditorCommandDefinition {
	id: string;
	category: EditorCommandCategory;
	status: EditorCommandStatus;
	adapters: readonly EditorMode[];
	/** Human-readable source contract for diagnostics and tests, never an HTML template. */
	sourceSyntax: string;
}

export interface EditorDocumentSnapshot {
	frontmatter: Readonly<Record<string, unknown>>;
	unknownFrontmatter: Readonly<Record<string, unknown>>;
	markdown: string;
	slug?: string;
	mode: EditorMode;
	revision: number;
	diagnostics: readonly MarkdownCodecDiagnostic[];
}

/** The only value an adapter may flush back to the session. */
export interface EditorAdapterFlush {
	markdown: string;
	revision: number;
	diagnostics: readonly MarkdownCodecDiagnostic[];
}
