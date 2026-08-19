export type MarkdownStructuredNodeKind =
	| "blockquote"
	| "code-block"
	| "emphasis"
	| "heading"
	| "inline-code"
	| "link"
	| "list"
	| "paragraph"
	| "strikethrough"
	| "strong"
	| "text"
	| "thematic-break";

export type MarkdownSourcePlaceholderKind =
	| "callout"
	| "details"
	| "math-block"
	| "math-inline"
	| "mermaid"
	| "video";

export type MarkdownCalloutType = "caution" | "important" | "note" | "tip" | "warning";

/** JavaScript UTF-16 half-open offsets: `source.slice(from, to)`. */
export interface MarkdownSourceRange {
	from: number;
	to: number;
}

export interface MarkdownSourceLocation {
	line: number;
	column: number;
}

export type MarkdownCodecDiagnosticSeverity = "error" | "fatal" | "info" | "warning";

export type MarkdownCodecDiagnosticCode =
	| "invalid-source-range"
	| "opaque-fallback"
	| "recognized-placeholder"
	| "overlapping-source-range"
	| "source-gap"
	| "source-slice-mismatch"
	| "unsorted-source-range"
	| "unsupported-syntax";

export interface MarkdownCodecDiagnostic {
	code: MarkdownCodecDiagnosticCode;
	message: string;
	severity: MarkdownCodecDiagnosticSeverity;
	range: MarkdownSourceRange | null;
	location: MarkdownSourceLocation | null;
}

interface MarkdownSourceBackedNode {
	range: MarkdownSourceRange;
	sourceSlice: string;
}

/**
 * Structured nodes may eventually be normalized, but only after a user edit marks the node dirty.
 * The skeleton intentionally carries no editor-kernel object or rendered HTML.
 */
export interface MarkdownStructuredNode extends MarkdownSourceBackedNode {
	category: "structured";
	kind: MarkdownStructuredNodeKind;
	dirty: boolean;
	/** Canonical source supplied by an adapter after an explicit structured edit. */
	serializedSource?: string;
}

/**
 * V0 placeholders are recognized source regions, not executable previews. Their source remains
 * immutable in the visual projection and can only be changed from the complete source editor.
 */
export interface MarkdownSourcePlaceholderNode extends MarkdownSourceBackedNode {
	category: "source-placeholder";
	kind: MarkdownSourcePlaceholderKind;
	dirty: false;
	diagnosticCode?: MarkdownCodecDiagnosticCode;
	metadata?: Readonly<Record<string, boolean | string>>;
}

/** Unknown, malformed, blocked, or unsafe syntax fails closed into an exact source slice. */
export interface MarkdownOpaqueNode extends MarkdownSourceBackedNode {
	category: "opaque";
	kind: "opaque";
	dirty: false;
	reason: string;
}

export type MarkdownCodecNode =
	| MarkdownOpaqueNode
	| MarkdownSourcePlaceholderNode
	| MarkdownStructuredNode;

export interface MarkdownCodecDocument {
	sourceLength: number;
	nodes: readonly MarkdownCodecNode[];
	diagnostics: readonly MarkdownCodecDiagnostic[];
}
