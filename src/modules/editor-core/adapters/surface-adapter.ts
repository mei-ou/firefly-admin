import type { EditorAdapter, EditorAdapterInput, EditorSurface } from "./editor-adapter";
import type { EditorAdapterFlush, EditorMode } from "../types";

function assertMounted(mounted: boolean): void {
	if (!mounted) throw new TypeError("Editor adapter is not mounted.");
}

/** Shared lifecycle guard for kernel-specific surfaces injected by a thin bridge. */
export function createSurfaceEditorAdapter(
	surface: EditorSurface,
	mode: EditorMode,
): EditorAdapter {
	let mounted = false;
	let destroyed = false;
	let revision = 0;

	function assertAlive(): void {
		if (destroyed) throw new TypeError("Editor adapter has been destroyed.");
	}

	return {
		mode,
		mount(input: EditorAdapterInput): void {
			assertAlive();
			if (mounted) throw new TypeError("Editor adapter is already mounted.");
			surface.setValue(input.markdown);
			surface.setDisabled(input.disabled ?? false);
			revision = input.revision;
			mounted = true;
		},
		setMarkdown(input: EditorAdapterInput): boolean {
			assertAlive();
			assertMounted(mounted);
			if (input.revision < revision) return false;
			surface.setValue(input.markdown);
			surface.setDisabled(input.disabled ?? false);
			revision = input.revision;
			return true;
		},
		flush(): EditorAdapterFlush {
			assertAlive();
			assertMounted(mounted);
			return { markdown: surface.getValue(), revision, diagnostics: [] };
		},
		destroy(): void {
			if (destroyed) return;
			destroyed = true;
			mounted = false;
			surface.destroy();
		},
	};
}
