import type { EditorAdapterFlush, EditorMode } from "../types";
import type { EditorVisualProjection } from "../projection";

export interface EditorAdapterInput {
	markdown: string;
	revision: number;
	disabled?: boolean;
}

export interface EditorSurface {
	getValue(): string;
	setValue(value: string): void;
	setDisabled(disabled: boolean): void;
	destroy(): void;
}

export interface VisualEditorSurface extends EditorSurface {
	setProjection(projection: EditorVisualProjection): void;
	getProjection(): EditorVisualProjection;
}

/**
 * Kernel-neutral adapter contract. Implementations may keep private editor state in memory, but
 * the public flush boundary is always Markdown plus diagnostics; HTML and editor JSON are absent.
 */
export interface EditorAdapter {
	readonly mode: EditorMode;
	mount(input: EditorAdapterInput): void;
	setMarkdown(input: EditorAdapterInput): boolean;
	flush(): EditorAdapterFlush;
	destroy(): void;
}
