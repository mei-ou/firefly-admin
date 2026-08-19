import { createSurfaceEditorAdapter } from "./surface-adapter";
import type { EditorAdapter, EditorSurface } from "./editor-adapter";

/** Bridges the existing CodeMirror surface without exposing CodeMirror types to editor-core. */
export function createCodeMirrorAdapter(surface: EditorSurface): EditorAdapter {
	return createSurfaceEditorAdapter(surface, "source");
}
