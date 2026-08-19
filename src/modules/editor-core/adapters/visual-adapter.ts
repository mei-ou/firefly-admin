import { createSurfaceEditorAdapter } from "./surface-adapter";
import {
	applyEditorVisualProjectionChanges,
	createEditorVisualProjection,
	type EditorVisualProjection,
} from "../projection";
import type { EditorAdapter, EditorAdapterInput, VisualEditorSurface } from "./editor-adapter";

/**
 * Kernel-neutral visual entry point. A future Milkdown bridge supplies only this surface contract;
 * Milkdown context, ProseMirror state and HTML never cross into editor-core.
 */
export function createVisualEditorAdapter(surface: VisualEditorSurface): EditorAdapter {
	const adapter = createSurfaceEditorAdapter(surface, "visual");
	let currentRevision: number | null = null;
	let currentProjection: EditorVisualProjection | null = null;
	return {
		...adapter,
		mount(input: EditorAdapterInput): void {
			const projection = createEditorVisualProjection(input.markdown, input.revision);
			adapter.mount(input);
			surface.setProjection(projection);
			currentRevision = input.revision;
			currentProjection = projection;
		},
		setMarkdown(input: EditorAdapterInput): boolean {
			if (currentRevision !== null && input.revision < currentRevision) return false;
			const projection = createEditorVisualProjection(input.markdown, input.revision);
			const accepted = adapter.setMarkdown(input);
			if (accepted) {
				surface.setProjection(projection);
				currentRevision = input.revision;
				currentProjection = projection;
			}
			return accepted;
		},
		flush(): ReturnType<EditorAdapter["flush"]> {
			const base = adapter.flush();
			if (!currentProjection) throw new TypeError("Visual editor adapter has no projection.");
			const nextProjection = applyEditorVisualProjectionChanges(
				currentProjection,
				surface.getProjection(),
				base.revision,
			);
			const sourceChanged = nextProjection.source !== currentProjection.source;
			currentProjection = nextProjection;
			if (sourceChanged) surface.setProjection(nextProjection);
			return {
				markdown: nextProjection.source,
				revision: base.revision,
				diagnostics: nextProjection.diagnostics,
			};
		},
	};
}
