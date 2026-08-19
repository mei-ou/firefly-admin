import { markdown } from "@codemirror/lang-markdown";
import { redo, undo } from "@codemirror/commands";
import { Compartment } from "@codemirror/state";
import { basicSetup, EditorView } from "codemirror";

export interface CodeMirrorRuntimeOptions {
	parent: HTMLElement;
	value: string;
	disabled: boolean;
	onchange?: (value: string) => void;
}

export interface CodeMirrorSelection {
	from: number;
	to: number;
	text: string;
}

export interface CodeMirrorEditorHandle {
	focus(): void;
	getSelection(): CodeMirrorSelection;
	replaceRange(
		text: string,
		from: number,
		to: number,
		selectionFrom?: number,
		selectionTo?: number,
	): void;
	replaceSelection(text: string, selectionFrom?: number, selectionTo?: number): void;
	undo(): void;
	redo(): void;
}

export interface CodeMirrorRuntime extends CodeMirrorEditorHandle {
	destroy(): void;
	getValue(): string;
	setDisabled(disabled: boolean): void;
	setValue(value: string): void;
}

const editorTheme = EditorView.theme({
	"&": {
		minHeight: "520px",
		backgroundColor: "#ffffff",
		color: "#172033",
		fontSize: "14px",
	},
	".cm-content": {
		minHeight: "520px",
		padding: "16px 0",
		fontFamily: '"Cascadia Code", "SFMono-Regular", Consolas, monospace',
		lineHeight: "1.65",
	},
	".cm-gutters": {
		backgroundColor: "#f8fafc",
		color: "#8993a4",
		border: "none",
	},
	".cm-activeLine, .cm-activeLineGutter": {
		backgroundColor: "#eff6ff",
	},
	"&.cm-focused": { outline: "none" },
});

/**
 * CodeMirror 及其语言包较大，因此该模块只由浏览器挂载后的动态 import 加载。
 * 运行时对象隐藏 CodeMirror 类型，让轻量 Svelte 外壳不会把编辑器依赖拉回首屏 chunk。
 */
export function createCodeMirrorRuntime(options: CodeMirrorRuntimeOptions): CodeMirrorRuntime {
	let syncingExternalValue = false;
	const editableCompartment = new Compartment();
	const view = new EditorView({
		doc: options.value,
		parent: options.parent,
		extensions: [
			basicSetup,
			markdown(),
			editorTheme,
			EditorView.lineWrapping,
			editableCompartment.of(EditorView.editable.of(!options.disabled)),
			EditorView.updateListener.of((update) => {
				if (update.docChanged && !syncingExternalValue) {
					options.onchange?.(update.state.doc.toString());
				}
			}),
		],
	});

	return {
		destroy: () => view.destroy(),
		focus: () => view.focus(),
		getSelection: () => {
			const selection = view.state.selection.main;
			return {
				from: selection.from,
				to: selection.to,
				text: view.state.sliceDoc(selection.from, selection.to),
			};
		},
		getValue: () => view.state.doc.toString(),
		replaceRange: (text, from, to, selectionFrom = text.length, selectionTo = selectionFrom) => {
			const documentLength = view.state.doc.length;
			const safeFrom = Math.max(0, Math.min(from, documentLength));
			const safeTo = Math.max(safeFrom, Math.min(to, documentLength));
			view.dispatch({
				changes: { from: safeFrom, to: safeTo, insert: text },
				selection: {
					anchor: safeFrom + selectionFrom,
					head: safeFrom + selectionTo,
				},
				scrollIntoView: true,
			});
			view.focus();
		},
		replaceSelection: (text, selectionFrom = text.length, selectionTo = selectionFrom) => {
			const selection = view.state.selection.main;
			view.dispatch({
				changes: { from: selection.from, to: selection.to, insert: text },
				selection: {
					anchor: selection.from + selectionFrom,
					head: selection.from + selectionTo,
				},
				scrollIntoView: true,
			});
			view.focus();
		},
		undo: () => {
			undo(view);
			view.focus();
		},
		redo: () => {
			redo(view);
			view.focus();
		},
		setDisabled: (disabled) => {
			view.dispatch({
				effects: editableCompartment.reconfigure(EditorView.editable.of(!disabled)),
			});
		},
		setValue: (value) => {
			const currentValue = view.state.doc.toString();
			if (value === currentValue) return;
			// 详情加载等父级同步不应被误判为用户输入，否则会把刚加载的文章立即标记为脏。
			syncingExternalValue = true;
			try {
				view.dispatch({ changes: { from: 0, to: currentValue.length, insert: value } });
			} finally {
				syncingExternalValue = false;
			}
		},
	};
}
