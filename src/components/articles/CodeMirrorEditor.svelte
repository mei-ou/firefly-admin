<script lang="ts">
import { onMount } from "svelte";
import type { CodeMirrorEditorHandle, CodeMirrorRuntime } from "./codemirror-runtime";

interface Props {
	value?: string;
	disabled?: boolean;
	onchange?: (value: string) => void;
	onready?: (handle: CodeMirrorEditorHandle) => void;
	ondispose?: () => void;
}

let { value = "", disabled = false, onchange, onready, ondispose }: Props = $props();
let host: HTMLDivElement;
let runtime = $state<CodeMirrorRuntime>();
let loading = $state(true);
let loadError = $state("");

onMount(() => {
	let disposed = false;

	async function mountEditor(): Promise<void> {
		try {
			// 仅在浏览器真正挂载编辑器时下载 CodeMirror，避免阻塞页面外壳和其他后台页面。
			const { createCodeMirrorRuntime } = await import("./codemirror-runtime");
			if (disposed) return;
			runtime = createCodeMirrorRuntime({ parent: host, value, disabled, onchange });
			const currentRuntime = runtime;
			onready?.({
				focus: () => currentRuntime.focus(),
				getSelection: () => currentRuntime.getSelection(),
				replaceRange: (text, from, to, selectionFrom, selectionTo) =>
					currentRuntime.replaceRange(text, from, to, selectionFrom, selectionTo),
				replaceSelection: (text, selectionFrom, selectionTo) =>
					currentRuntime.replaceSelection(text, selectionFrom, selectionTo),
				undo: () => currentRuntime.undo(),
				redo: () => currentRuntime.redo(),
			});
		} catch {
			loadError = "Markdown 编辑器加载失败，请刷新页面后重试。";
		} finally {
			loading = false;
		}
	}

	void mountEditor();
	return () => {
		disposed = true;
		runtime?.destroy();
		runtime = undefined;
		ondispose?.();
	};
});

$effect(() => {
	runtime?.setValue(value);
});

$effect(() => {
	runtime?.setDisabled(disabled);
});
</script>

<div class="editor-host" class:pending={loading || loadError.length > 0} bind:this={host}>
	{#if loading}<p role="status">正在加载 Markdown 编辑器…</p>{/if}
	{#if loadError}<p class="load-error" role="alert">{loadError}</p>{/if}
</div>

<style>
	.editor-host {
		overflow: hidden;
		min-height: 520px;
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		background: white;
	}

	.editor-host.pending {
		display: grid;
		place-items: center;
	}

	.editor-host p {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.82rem;
	}

	.editor-host .load-error {
		color: #b91c1c;
	}

	.editor-host:focus-within {
		border-color: var(--brand);
		box-shadow: 0 0 0 3px var(--brand-soft);
	}

	@media (max-width: 680px) {
		.editor-host { min-height: 420px; border-radius: 0 0 0.75rem 0.75rem; }
		.editor-host :global(.cm-content) { min-height: 420px; padding: 12px 0; font-size: 12px; }
	}
</style>
