import type { MarkdownCodecDiagnostic } from "../markdown-codec/types";
import { buildEditorSourceDocument, tryParseEditorSourceDocument } from "./source-document";
import type { EditorAdapterFlush, EditorDocumentSnapshot, EditorMode } from "./types";

export interface CreateEditorSessionInput {
	frontmatter?: Readonly<Record<string, unknown>>;
	unknownFrontmatter?: Readonly<Record<string, unknown>>;
	markdown: string;
	slug?: string;
	mode?: EditorMode;
}

export interface EditorSession {
	snapshot(): EditorDocumentSnapshot;
	updateMarkdown(markdown: string): number;
	updateFrontmatter(
		frontmatter: Readonly<Record<string, unknown>>,
		unknownFrontmatter: Readonly<Record<string, unknown>>,
	): number;
	serializeSource(): string;
	applySource(source: string): boolean;
	setMode(mode: EditorMode): number;
	acceptFlush(result: EditorAdapterFlush): boolean;
	acceptDiagnostics(revision: number, diagnostics: readonly MarkdownCodecDiagnostic[]): boolean;
	isCurrent(revision: number): boolean;
}

function hasFatalDiagnostic(diagnostics: readonly MarkdownCodecDiagnostic[]): boolean {
	return diagnostics.some((diagnostic) => diagnostic.severity === "fatal");
}

/** Owns persisted Markdown/frontmatter and rejects stale adapter results at one transaction gate. */
export function createEditorSession(input: CreateEditorSessionInput): EditorSession {
	let state: EditorDocumentSnapshot = {
		frontmatter: { ...(input.frontmatter ?? {}) },
		unknownFrontmatter: { ...(input.unknownFrontmatter ?? {}) },
		markdown: input.markdown,
		...(input.slug === undefined ? {} : { slug: input.slug }),
		mode: input.mode ?? "visual",
		revision: 0,
		diagnostics: [],
	};
	let diagnostics: readonly MarkdownCodecDiagnostic[] = [];

	function bump(next: Partial<EditorDocumentSnapshot>): number {
		state = { ...state, ...next, revision: state.revision + 1 };
		return state.revision;
	}

	return {
		snapshot: () => ({
			...state,
			frontmatter: { ...state.frontmatter },
			unknownFrontmatter: { ...state.unknownFrontmatter },
			diagnostics: [...diagnostics],
		}),
		updateMarkdown: (markdown) => bump({ markdown }),
		updateFrontmatter: (frontmatter, unknownFrontmatter) =>
			bump({ frontmatter: { ...frontmatter }, unknownFrontmatter: { ...unknownFrontmatter } }),
		serializeSource: () => buildEditorSourceDocument(state),
		applySource: (source) => {
			const result = tryParseEditorSourceDocument(source);
			if (!result.ok) return false;
			const parsed = result.document;

			const stateWithoutSlug = { ...state };
			delete stateWithoutSlug.slug;
			state = {
				...stateWithoutSlug,
				frontmatter: { ...parsed.frontmatter },
				unknownFrontmatter: { ...parsed.unknownFrontmatter },
				markdown: parsed.markdown,
				...(parsed.slug === undefined ? {} : { slug: parsed.slug }),
				diagnostics: [],
				revision: state.revision + 1,
			};
			diagnostics = [];
			return true;
		},
		setMode: (mode) => (mode === state.mode ? state.revision : bump({ mode })),
		acceptFlush: (result) => {
			if (result.revision !== state.revision || hasFatalDiagnostic(result.diagnostics))
				return false;
			diagnostics = result.diagnostics;
			bump({ markdown: result.markdown, diagnostics: [...result.diagnostics] });
			return true;
		},
		acceptDiagnostics: (revision, nextDiagnostics) => {
			if (revision !== state.revision) return false;
			diagnostics = [...nextDiagnostics];
			state = { ...state, diagnostics: [...nextDiagnostics] };
			return true;
		},
		isCurrent: (revision) => revision === state.revision,
	};
}
