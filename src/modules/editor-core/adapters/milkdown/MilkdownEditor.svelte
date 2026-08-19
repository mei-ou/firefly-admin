<script lang="ts">
import { onMount } from "svelte";
import type { BridgeProjection, BridgeSourceNodeMetadata } from "./bridge";
import type { Editor } from "@milkdown/kit/core";
import { toggleMark, setBlockType, wrapIn } from "@milkdown/kit/prose/commands";
import { redo, undo } from "@milkdown/kit/prose/history";
import { wrapInList } from "@milkdown/kit/prose/schema-list";
import { Fragment, Slice, type Node } from "@milkdown/kit/prose/model";
import { TextSelection, type Command } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import type { VisualEditorCommand } from "../../types";

interface Selection {
	from: number;
	to: number;
	text: string;
}

export interface MilkdownEditorHandle {
	focus(): void;
	getSelection(): Selection;
	flush(): string;
	runCommand(command: VisualEditorCommand): boolean;
	undo(): boolean;
	redo(): boolean;
	replaceMarkdown(markdown: string, from?: number, to?: number): boolean;
	replaceRange(
		text: string,
		from: number,
		to: number,
		selectionFrom?: number,
		selectionTo?: number,
	): void;
	replaceSelection(text: string, selectionFrom?: number, selectionTo?: number): void;
}

interface Props {
	value?: string;
	disabled?: boolean;
	onchange?: (value: string) => void;
	onready?: (handle: MilkdownEditorHandle) => void;
	ondispose?: () => void;
	onerror?: (message: string) => void;
	onsource?: (sourceRangeFrom: number) => void;
}

let {
	value = "",
	disabled = false,
	onchange,
	onready,
	ondispose,
	onerror,
	onsource,
}: Props = $props();
let host: HTMLDivElement;
let loading = $state(true);
let loadError = $state("");
let flushError = $state("");
let editorView: EditorView | null = null;
let editor: Editor | undefined;
let parser: ((markdown: string) => Node) | undefined;
let flushCurrent: (() => string) | undefined;
let bridge: typeof import("./bridge") | undefined;
let projection: BridgeProjection | undefined;
let currentSource = "";
let syncingExternal = false;
let mounted = false;
let mountGeneration = 0;

function editorSelection(): Selection {
	if (!editorView) return { from: 0, to: 0, text: "" };
	const selection = editorView.state.selection.main;
	const doc = editorView.state.doc;
	return {
		from: selection.from,
		to: selection.to,
		text: doc.textBetween(selection.from, selection.to, "\n"),
	};
}

function replaceRange(
	text: string,
	from: number,
	to: number,
	selectionFrom = text.length,
	selectionTo = selectionFrom,
): void {
	if (!editorView) return;
	const docLength = editorView.state.doc.content.size;
	const safeFrom = Math.max(0, Math.min(from, docLength));
	const safeTo = Math.max(safeFrom, Math.min(to, docLength));
	const transaction = editorView.state.tr.insertText(text, safeFrom, safeTo);
	const selectionConstructor = editorView.state.selection.constructor as unknown as {
		create(doc: unknown, anchor: number, head: number): unknown;
	};
	editorView.dispatch(
		transaction.setSelection(
			selectionConstructor.create(
				editorView.state.doc,
				safeFrom + selectionFrom,
				safeFrom + selectionTo,
			),
		),
	);
	editorView.focus();
}

function replaceSelection(
	text: string,
	selectionFrom = text.length,
	selectionTo = selectionFrom,
): void {
	const selection = editorSelection();
	replaceRange(text, selection.from, selection.to, selectionFrom, selectionTo);
}

function rangeTouchesProtectedNode(from: number, to: number): boolean {
	if (!editorView) return true;
	const { doc } = editorView.state;
	let protectedNode = false;
	doc.nodesBetween(from, to, (node) => {
		if (node.type.name.startsWith("firefly_source")) {
			protectedNode = true;
			return false;
		}
		return !protectedNode;
	});
	return protectedNode;
}

function selectionTouchesProtectedNode(): boolean {
	if (!editorView) return true;
	const { selection } = editorView.state;
	if (selection.node?.type.name.startsWith("firefly_source")) return true;
	return rangeTouchesProtectedNode(selection.from, selection.to);
}

function markdownFragment(markdown: string): Fragment | undefined {
	if (!parser) return undefined;
	const parsed = parser(markdown);
	const first = parsed.firstChild;
	if (parsed.childCount === 1 && first?.type.name === "paragraph") return first.content;
	return parsed.content;
}

function replaceMarkdown(markdown: string, from?: number, to?: number): boolean {
	if (!editorView || !parser || disabled || selectionTouchesProtectedNode()) return false;
	const fragment = markdownFragment(markdown);
	if (!fragment || fragment.size === 0) return false;
	try {
		const state = editorView.state;
		let transaction = state.tr;
		if (from !== undefined && to !== undefined) {
			const safeFrom = Math.max(0, Math.min(from, state.doc.content.size));
			const safeTo = Math.max(safeFrom, Math.min(to, state.doc.content.size));
			if (rangeTouchesProtectedNode(safeFrom, safeTo)) return false;
			transaction = transaction.setSelection(TextSelection.create(state.doc, safeFrom, safeTo));
		}
		editorView.dispatch(transaction.replaceSelection(new Slice(fragment, 0, 0)).scrollIntoView());
		editorView.focus();
		return true;
	} catch {
		return false;
	}
}

function runCommand(command: VisualEditorCommand): boolean {
	if (!editorView || disabled || selectionTouchesProtectedNode()) return false;
	const { schema } = editorView.state;
	const mark = (name: string) => schema.marks[name];
	const node = (name: string) => schema.nodes[name];
	let action: Command | undefined;

	switch (command) {
		case "bold": {
			const type = mark("strong");
			if (type) action = toggleMark(type);
			break;
		}
		case "italic": {
			const type = mark("emphasis");
			if (type) action = toggleMark(type);
			break;
		}
		case "strikethrough": {
			const type = mark("strike_through");
			if (type) action = toggleMark(type);
			break;
		}
		case "inline-code": {
			const type = mark("inlineCode");
			if (type) action = toggleMark(type);
			break;
		}
		case "heading-1":
		case "heading-2":
		case "heading-3":
		case "heading-4":
		case "heading-5":
		case "heading-6": {
			const type = node("heading");
			const level = Number(command.slice("heading-".length));
			if (type) action = setBlockType(type, { level });
			break;
		}
		case "paragraph": {
			const type = node("paragraph");
			if (type) action = setBlockType(type);
			break;
		}
		case "quote": {
			const type = node("blockquote");
			if (type) action = wrapIn(type);
			break;
		}
		case "unordered-list": {
			const type = node("bullet_list");
			if (type) action = wrapInList(type);
			break;
		}
		case "ordered-list": {
			const type = node("ordered_list");
			if (type) action = wrapInList(type);
			break;
		}
		case "code-block": {
			const type = node("code_block");
			if (type) action = setBlockType(type, { language: "" });
			break;
		}
		case "table":
			return replaceMarkdown("| 标题一 | 标题二 |\n| --- | --- |\n| 内容 | 内容 |");
		case "divider":
			return replaceMarkdown("---");
	}
	if (!action) return false;
	const handled = action(
		editorView.state,
		(transaction) => editorView?.dispatch(transaction),
		editorView,
	);
	if (handled) editorView.focus();
	return handled;
}

function runHistoryCommand(command: "undo" | "redo"): boolean {
	if (!editorView || disabled) return false;
	const handled = (command === "undo" ? undo : redo)(editorView.state, (transaction) =>
		editorView?.dispatch(transaction),
	);
	if (handled) editorView.focus();
	return handled;
}

function exposeHandle(): void {
	onready?.({
		focus: () => editorView?.focus(),
		getSelection: editorSelection,
		flush: () => {
			if (!flushCurrent) throw new TypeError("所见即所得编辑器尚未完成挂载。");
			return flushCurrent();
		},
		runCommand,
		undo: () => runHistoryCommand("undo"),
		redo: () => runHistoryCommand("redo"),
		replaceMarkdown,
		replaceRange,
		replaceSelection,
	});
}

function readSourceMetadata(): BridgeSourceNodeMetadata[] {
	return Array.from(host.querySelectorAll<HTMLElement>('[data-firefly-node="source"]')).map(
		(element) => ({
			sourceRangeFrom: Number(element.dataset.sourceRangeFrom),
			sourceRangeTo: Number(element.dataset.sourceRangeTo),
			sourceSlice: element.dataset.sourceSlice ?? "",
			category: element.dataset.category === "placeholder" ? "placeholder" : "opaque",
			kind: element.dataset.kind ?? "opaque",
			editable: false as const,
		}),
	);
}

async function mountEditor(): Promise<void> {
	const generation = mountGeneration;
	try {
		const [
			core,
			commonmarkModule,
			gfmModule,
			listenerModule,
			historyModule,
			bridgeModule,
			sourceNodeModule,
		] = await Promise.all([
			import("@milkdown/kit/core"),
			import("@milkdown/kit/preset/commonmark"),
			import("@milkdown/kit/preset/gfm"),
			import("@milkdown/kit/plugin/listener"),
			import("@milkdown/kit/plugin/history"),
			import("./bridge"),
			import("./firefly-source-node"),
		]);
		if (!host || !mounted || generation !== mountGeneration) return;
		bridge = bridgeModule;
		projection = bridgeModule.projectCodecToMilkdownMarkdown(value);
		currentSource = value;
		const initialProjection = projection;
		let editorReady = false;
		const created = core.Editor.make()
			.config((ctx) => {
				ctx.set(core.rootCtx, host);
				ctx.set(core.defaultValueCtx, initialProjection.markdown);
				ctx.update(core.remarkPluginsCtx, (plugins) => [
					...plugins,
					{
						plugin: sourceNodeModule.fireflySourceRemarkPlugin,
						options: { projection: initialProjection.visualProjection },
					},
				]);
				ctx.get(listenerModule.listenerCtx).markdownUpdated((_, markdown) => {
					if (!editorReady || syncingExternal || !projection) return;
					try {
						const next = bridgeModule.flushMilkdownMarkdown(projection, markdown);
						projection = next;
						const changed = next.source !== currentSource;
						currentSource = next.source;
						flushError = "";
						if (changed) onchange?.(next.source);
					} catch (error) {
						flushError =
							error instanceof Error ? error.message : "画布变更未通过 Markdown 保真校验。";
					}
				});
			})
			.use(commonmarkModule.commonmark)
			.use(gfmModule.gfm)
			.use(sourceNodeModule.fireflySourceNodePlugin)
			.use(listenerModule.listener)
			.use(historyModule.history);
		const createdEditor = await created.create();
		if (!host || !mounted || generation !== mountGeneration) {
			await createdEditor.destroy(true);
			return;
		}
		editor = createdEditor;
		editorView = createdEditor.action((ctx) => ctx.get(core.editorViewCtx));
		parser = createdEditor.action((ctx) => ctx.get(core.parserCtx));
		flushCurrent = () => {
			if (!projection || !editor || !editorView || !mounted || generation !== mountGeneration) {
				throw new TypeError("所见即所得编辑器尚未完成挂载。");
			}
			const serialized = createdEditor.action((ctx) =>
				ctx.get(core.serializerCtx)(ctx.get(core.editorStateCtx).doc),
			);
			const next = bridgeModule.flushMilkdownMarkdown(projection, serialized);
			const changed = next.source !== currentSource;
			projection = next;
			currentSource = next.source;
			flushError = "";
			if (changed) onchange?.(next.source);
			return next.source;
		};
		editorView.setProps({ editable: () => !disabled });
		const dom = host.querySelector<HTMLElement>(".ProseMirror");
		if (dom) {
			dom.setAttribute("role", "textbox");
			dom.setAttribute("aria-multiline", "true");
			dom.setAttribute("aria-label", "Firefly 文章所见即所得编辑器");
		}
		bridgeModule.flushBridgeNodeViewMetadata(initialProjection, readSourceMetadata());
		editorReady = true;
		loading = false;
		currentSource = initialProjection.source;
		exposeHandle();
	} catch (error) {
		if (!mounted || generation !== mountGeneration) return;
		loadError = error instanceof Error ? error.message : "所见即所得编辑器加载失败。";
		loading = false;
		onerror?.(loadError);
	}
}

onMount(() => {
	mounted = true;
	const handleSourceOpen = (event: Event): void => {
		const detail = (event as CustomEvent<{ sourceRangeFrom?: number }>).detail;
		if (typeof detail?.sourceRangeFrom === "number") onsource?.(detail.sourceRangeFrom);
	};
	host.addEventListener("firefly-source-open", handleSourceOpen);
	void mountEditor();
	return () => {
		mounted = false;
		host.removeEventListener("firefly-source-open", handleSourceOpen);
		mountGeneration += 1;
		const currentEditor = editor;
		editor = undefined;
		editorView = null;
		flushCurrent = undefined;
		bridge = undefined;
		if (currentEditor) void currentEditor.destroy(true);
		ondispose?.();
	};
});

$effect(() => {
	const nextValue = value;
	if (!editor || !editorView || !projection || !parser || !bridge || nextValue === currentSource)
		return;
	try {
		const nextProjection = bridge.projectCodecToMilkdownMarkdown(nextValue);
		const parsed = parser(nextValue);
		syncingExternal = true;
		try {
			const transaction = editorView.state.tr.replaceWith(
				0,
				editorView.state.doc.content.size,
				parsed.content,
			);
			editorView.dispatch(transaction);
			projection = nextProjection;
			currentSource = nextValue;
			flushError = "";
		} finally {
			syncingExternal = false;
		}
	} catch (error) {
		flushError = error instanceof Error ? error.message : "外部 Markdown 无法加载到画布。";
	}
});

$effect(() => {
	if (!editorView) return;
	editorView.setProps({ editable: () => !disabled });
});
</script>

<div class="editor-host" class:pending={loading || loadError.length > 0} bind:this={host}>
	{#if loading}<p role="status">正在加载所见即所得编辑器…</p>{/if}
	{#if loadError}<p class="load-error" role="alert">{loadError}</p>{/if}
	{#if flushError}<p class="flush-error" role="alert">{flushError} 请切换到 Markdown 源码模式继续。</p>{/if}
</div>

<style>
	.editor-host {
		min-height: 520px;
		overflow: hidden;
		border: 1px solid var(--border);
		border-radius: 0.7rem;
		background: white;
	}

	.editor-host.pending {
		display: grid;
		place-items: center;
	}

	.editor-host p {
		margin: 0.8rem;
		color: var(--text-muted);
		font-size: 0.82rem;
	}

	.editor-host .load-error,
	.editor-host .flush-error { color: #b91c1c; }

	:global(.editor-host .ProseMirror) {
		min-height: 620px;
		padding: 2rem max(1.2rem, calc((100% - 720px) / 2));
		outline: none;
		color: #263247;
		font-family: ui-serif, Georgia, "Noto Serif SC", serif;
		font-size: 15px;
		line-height: 1.85;
	}

	:global(.editor-host .ProseMirror h1),
	:global(.editor-host .ProseMirror h2),
	:global(.editor-host .ProseMirror h3),
	:global(.editor-host .ProseMirror h4),
	:global(.editor-host .ProseMirror h5),
	:global(.editor-host .ProseMirror h6) {
		margin: 1rem 0 0.55rem;
		color: var(--text-primary);
		font-family: Inter, "Microsoft YaHei", sans-serif;
		line-height: 1.35;
	}

	:global(.editor-host .ProseMirror p) { margin: 0.65rem 0; }
	:global(.editor-host .ProseMirror ul),
	:global(.editor-host .ProseMirror ol) { padding-left: 1.3rem; }
	:global(.editor-host .ProseMirror blockquote) {
		margin: 0.85rem 0;
		padding: 0.15rem 0 0.15rem 0.9rem;
		border-left: 3px solid var(--brand);
		color: var(--text-secondary);
	}
	:global(.editor-host .ProseMirror pre) {
		overflow: auto;
		margin: 0.85rem 0;
		padding: 0.85rem;
		border: 1px solid var(--border);
		border-radius: 0.55rem;
		background: #f8fafc;
		font-family: "Cascadia Code", Consolas, monospace;
		font-size: 0.86em;
	}
	:global(.editor-host .ProseMirror code) {
		padding: 0.12rem 0.3rem;
		border-radius: 0.3rem;
		background: #f1f5f9;
		color: #be123c;
		font-family: "Cascadia Code", Consolas, monospace;
		font-size: 0.87em;
	}
	:global(.editor-host .ProseMirror pre code) { padding: 0; background: transparent; color: inherit; }
	:global(.editor-host .ProseMirror table) { width: 100%; border-collapse: collapse; margin: 0.85rem 0; }
	:global(.editor-host .ProseMirror th),
	:global(.editor-host .ProseMirror td) { padding: 0.5rem; border: 1px solid var(--border); text-align: left; }
	:global(.editor-host .ProseMirror th) { background: var(--surface-subtle); }

	:global(.editor-host .ProseMirror:focus) {
		box-shadow: inset 0 0 0 2px var(--brand-soft);
	}

	:global(.editor-host .firefly-source-node) {
		display: block;
		position: relative;
		margin: 1.1rem 0;
		overflow: hidden;
		border: 1px dashed #c4b5fd;
		border-radius: 0.8rem;
		background: #fcfbff;
		color: #475569;
		font-family: Inter, "Microsoft YaHei", sans-serif;
		font-size: 0.86rem;
	}
	:global(.editor-host .firefly-source-head) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.62rem 0.75rem;
		border-bottom: 1px solid #e9d5ff;
		background: #f5f3ff;
	}
	:global(.editor-host .firefly-source-name),
	:global(.editor-host .firefly-source-actions) { display: flex; align-items: center; gap: 0.45rem; }
	:global(.editor-host .firefly-source-name) { font-size: 0.73rem; font-weight: 800; }
	:global(.editor-host .firefly-source-chip) {
		padding: 0.18rem 0.42rem;
		border-radius: 999px;
		background: #ede9fe;
		color: #6d28d9;
		font-size: 0.62rem;
	}
	:global(.editor-host .firefly-source-actions button) {
		min-height: 1.7rem;
		padding: 0.24rem 0.42rem;
		border: 0;
		border-radius: 0.35rem;
		background: transparent;
		color: var(--text-muted);
		font: inherit;
		font-size: 0.64rem;
		cursor: pointer;
	}
	:global(.editor-host .firefly-source-actions button:hover) { background: #e8edf5; color: var(--text-primary); }
	:global(.editor-host .firefly-source-body) { padding: 0.8rem 0.85rem; }
	:global(.editor-host .firefly-source-summary) {
		display: grid;
		grid-template-columns: 34px minmax(0, 1fr);
		gap: 0.65rem;
		align-items: center;
	}
	:global(.editor-host .firefly-source-mark) {
		display: grid;
		width: 34px;
		height: 34px;
		place-items: center;
		border-radius: 9px;
		background: #ede9fe;
		color: #6d28d9;
		font-size: 0.62rem;
		font-weight: 900;
	}
	:global(.editor-host .firefly-source-summary strong) { color: #4c1d95; font-size: 0.75rem; }
	:global(.editor-host .firefly-source-summary p) { margin: 0.18rem 0 0; color: var(--text-muted); font-size: 0.66rem; line-height: 1.5; }
	:global(.editor-host .firefly-source-body pre) {
		max-height: 100px;
		overflow: hidden;
		margin: 0.65rem 0 0;
		padding: 0.55rem 0.65rem;
		border: 0;
		border-radius: 0.45rem;
		background: #29263b;
		color: #e9e7ff;
		font: 0.64rem/1.55 "Cascadia Code", Consolas, monospace;
		white-space: pre-wrap;
	}

	:global(.editor-host span.firefly-source-node) {
		display: inline-block;
		margin: 0 0.2rem;
		padding: 0.05rem 0.3rem;
		border: 1px dashed #c4b5fd;
		border-radius: 0.3rem;
		background: #f5f3ff;
		color: #6d28d9;
		font-size: 0.8em;
	}

	@media (max-width: 680px) {
		:global(.editor-host .ProseMirror) { min-height: 500px; padding: 1.1rem 0.85rem 2rem; font-size: 15px; }
		:global(.editor-host .firefly-source-head) { align-items: flex-start; flex-wrap: wrap; padding: 0.55rem 0.6rem; }
		:global(.editor-host .firefly-source-name) { min-width: 0; flex: 1 1 100%; }
		:global(.editor-host .firefly-source-actions) { width: 100%; justify-content: flex-start; }
		:global(.editor-host .firefly-source-body) { padding: 0.7rem; }
		:global(.editor-host .firefly-source-body pre) { max-height: 84px; font-size: 0.6rem; }
	}
</style>
