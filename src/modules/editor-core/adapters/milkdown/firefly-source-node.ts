import { nodeViewCtx, nodesCtx } from "@milkdown/kit/core";
import type { MilkdownPlugin } from "@milkdown/kit/ctx";
import type { NodeSchema, RemarkPluginRaw } from "@milkdown/kit/transformer";
import type { EditorVisualProjection, EditorVisualProjectionNode } from "../../projection";
import type { NodeViewConstructor } from "@milkdown/kit/prose/view";

export const FIREFLY_SOURCE_BLOCK = "firefly_source_block";
export const FIREFLY_SOURCE_INLINE = "firefly_source_inline";

export interface FireflySourceNodeAttrs {
	sourceRangeFrom: number;
	sourceRangeTo: number;
	sourceSlice: string;
	category: "placeholder" | "opaque";
	kind: string;
	editable: false;
}

interface RemarkPosition {
	start: { offset?: number };
	end: { offset?: number };
}

export interface RemarkNode {
	type: string;
	children?: RemarkNode[];
	position?: RemarkPosition;
	[key: string]: unknown;
}

export interface RemarkRoot extends RemarkNode {
	type: "root";
	children: RemarkNode[];
}

interface FireflyRemarkOptions {
	projection: EditorVisualProjection;
}

function isProtectedNode(node: EditorVisualProjectionNode): boolean {
	return node.category === "placeholder" || node.category === "opaque";
}

function isBlockNode(node: EditorVisualProjectionNode): boolean {
	return node.category === "opaque" || node.kind !== "math-inline";
}

function overlaps(position: RemarkPosition | undefined, from: number, to: number): boolean {
	const start = position?.start.offset;
	const end = position?.end.offset;
	return typeof start === "number" && typeof end === "number" && start < to && end > from;
}

function positionFor(from: number, to: number): RemarkPosition {
	return { start: { offset: from }, end: { offset: to } };
}

function customNode(node: EditorVisualProjectionNode, inline: boolean): RemarkNode {
	return {
		type: inline ? "fireflySourceInline" : "fireflySourceBlock",
		position: positionFor(node.sourceRange.from, node.sourceRange.to),
		data: {
			sourceRangeFrom: node.sourceRange.from,
			sourceRangeTo: node.sourceRange.to,
			sourceSlice: node.sourceSlice,
			category: node.category,
			kind: node.category === "opaque" ? "opaque" : node.kind,
			editable: false,
		},
	};
}

function attrsFromRemarkNode(node: RemarkNode): FireflySourceNodeAttrs {
	const data = (node.data ?? {}) as Record<string, unknown>;
	if (
		typeof data.sourceRangeFrom !== "number" ||
		typeof data.sourceRangeTo !== "number" ||
		typeof data.sourceSlice !== "string" ||
		(data.category !== "placeholder" && data.category !== "opaque") ||
		typeof data.kind !== "string"
	) {
		throw new TypeError("Invalid Firefly source node metadata.");
	}
	return {
		sourceRangeFrom: data.sourceRangeFrom,
		sourceRangeTo: data.sourceRangeTo,
		sourceSlice: data.sourceSlice,
		category: data.category,
		kind: data.kind,
		editable: false,
	};
}

function transformInlineChildren(
	children: RemarkNode[],
	inlineNodes: readonly EditorVisualProjectionNode[],
): void {
	for (let index = 0; index < children.length; index += 1) {
		const child = children[index];
		if (!child) continue;
		if (child.children) transformInlineChildren(child.children, inlineNodes);
		if (child.type !== "text" || !child.position) continue;
		const childFrom = child.position.start.offset;
		const childTo = child.position.end.offset;
		if (typeof childFrom !== "number" || typeof childTo !== "number") continue;
		const matches = inlineNodes.filter((node) =>
			overlaps(child.position, node.sourceRange.from, node.sourceRange.to),
		);
		if (matches.length === 0) continue;

		const replacements: RemarkNode[] = [];
		let cursor = childFrom;
		for (const node of matches.sort(
			(left, right) => left.sourceRange.from - right.sourceRange.from,
		)) {
			const from = Math.max(childFrom, node.sourceRange.from);
			const to = Math.min(childTo, node.sourceRange.to);
			if (from > cursor) {
				replacements.push({
					type: "text",
					value: String(child.value ?? "").slice(cursor - childFrom, from - childFrom),
					position: positionFor(cursor, from),
				});
			}
			replacements.push(customNode(node, true));
			cursor = to;
		}
		if (cursor < childTo) {
			replacements.push({
				type: "text",
				value: String(child.value ?? "").slice(cursor - childFrom),
				position: positionFor(cursor, childTo),
			});
		}
		children.splice(index, 1, ...replacements);
		index += replacements.length - 1;
	}
}

export function transformFireflySourceAst(
	root: RemarkRoot,
	projection: EditorVisualProjection,
): void {
	const protectedNodes = projection.nodes.filter(isProtectedNode);
	const blockNodes = protectedNodes
		.filter(isBlockNode)
		.sort((left, right) => right.sourceRange.from - left.sourceRange.from);
	for (const node of blockNodes) {
		const first = root.children.findIndex((child) =>
			overlaps(child.position, node.sourceRange.from, node.sourceRange.to),
		);
		if (first < 0) continue;
		let last = first;
		while (
			last + 1 < root.children.length &&
			overlaps(root.children[last + 1]?.position, node.sourceRange.from, node.sourceRange.to)
		)
			last += 1;
		root.children.splice(first, last - first + 1, customNode(node, false));
	}
	transformInlineChildren(
		root.children,
		protectedNodes.filter((node) => !isBlockNode(node)),
	);
}

export const fireflySourceRemarkPlugin: RemarkPluginRaw<FireflyRemarkOptions> = (options) => {
	return (tree) => transformFireflySourceAst(tree as unknown as RemarkRoot, options.projection);
};

function sourceNodeSchema(id: string, inline: boolean): NodeSchema {
	return {
		inline,
		group: inline ? "inline" : "block",
		atom: true,
		isolating: true,
		selectable: true,
		attrs: {
			sourceRangeFrom: { default: 0 },
			sourceRangeTo: { default: 0 },
			sourceSlice: { default: "" },
			category: { default: "opaque" },
			kind: { default: "opaque" },
			editable: { default: false },
		},
		toDOM: () => [inline ? "span" : "div", { class: "firefly-source-node" }],
		parseDOM: [],
		parseMarkdown: {
			match: (node) => node.type === (inline ? "fireflySourceInline" : "fireflySourceBlock"),
			runner: (state, node, type) => state.addNode(type, attrsFromRemarkNode(node as RemarkNode)),
		},
		toMarkdown: {
			match: (node) => node.type.name === id,
			runner: (state, node) => state.addNode("html", undefined, String(node.attrs.sourceSlice)),
		},
	};
}

function createSourceNodeView(): NodeViewConstructor {
	return (node) => {
		const dom = document.createElement(node.type.name === FIREFLY_SOURCE_BLOCK ? "div" : "span");
		const sourceAttrs = { ...(node.attrs as FireflySourceNodeAttrs) };
		dom.className = "firefly-source-node";
		dom.contentEditable = "false";
		dom.setAttribute("aria-readonly", "true");
		dom.dataset.fireflyNode = "source";

		const sourceLabel =
			sourceAttrs.category === "opaque"
				? "源码保真块"
				: ({
						callout: "提示框",
						details: "折叠内容",
						"math-block": "数学公式",
						"math-inline": "行内公式",
						mermaid: "Mermaid",
						video: "视频",
					}[sourceAttrs.kind] ?? sourceAttrs.kind);
		const sourceDescription =
			sourceAttrs.category === "opaque"
				? "未知语法保持原始字节，不执行也不改写。"
				: "特殊语法只显示源码保真占位，修改请进入 Markdown 源码模式。";

		const render = (): void => {
			dom.dataset.category = sourceAttrs.category;
			dom.dataset.kind = sourceAttrs.kind;
			dom.dataset.sourceRangeFrom = String(sourceAttrs.sourceRangeFrom);
			dom.dataset.sourceRangeTo = String(sourceAttrs.sourceRangeTo);
			dom.dataset.sourceSlice = sourceAttrs.sourceSlice;
			if (node.type.name === FIREFLY_SOURCE_INLINE) {
				dom.textContent = `[${sourceLabel}]`;
				return;
			}
			dom.replaceChildren();
			const head = document.createElement("div");
			head.className = "firefly-source-head";
			const name = document.createElement("div");
			name.className = "firefly-source-name";
			const chip = document.createElement("span");
			chip.className = "firefly-source-chip";
			chip.textContent = sourceLabel;
			const state = document.createElement("span");
			state.textContent = "源码保真 · 不执行";
			name.appendChild(chip);
			name.appendChild(state);
			const actions = document.createElement("div");
			actions.className = "firefly-source-actions";
			const sourceButton = document.createElement("button");
			sourceButton.type = "button";
			sourceButton.textContent = "查看源码";
			sourceButton.addEventListener("click", () => {
				dom.dispatchEvent(
					new CustomEvent("firefly-source-open", {
						bubbles: true,
						detail: { sourceRangeFrom: sourceAttrs.sourceRangeFrom },
					}),
				);
			});
			const copyButton = document.createElement("button");
			copyButton.type = "button";
			copyButton.textContent = "复制";
			copyButton.addEventListener("click", () => {
				void navigator.clipboard?.writeText(sourceAttrs.sourceSlice);
			});
			actions.appendChild(sourceButton);
			actions.appendChild(copyButton);
			head.appendChild(name);
			head.appendChild(actions);
			const body = document.createElement("div");
			body.className = "firefly-source-body";
			const summary = document.createElement("div");
			summary.className = "firefly-source-summary";
			const mark = document.createElement("span");
			mark.className = "firefly-source-mark";
			mark.textContent = "SRC";
			const copy = document.createElement("div");
			const title = document.createElement("strong");
			title.textContent = `已识别${sourceLabel}`;
			const description = document.createElement("p");
			description.textContent = sourceDescription;
			copy.appendChild(title);
			copy.appendChild(description);
			summary.appendChild(mark);
			summary.appendChild(copy);
			const snippet = document.createElement("pre");
			snippet.textContent = sourceAttrs.sourceSlice;
			body.appendChild(summary);
			body.appendChild(snippet);
			dom.appendChild(head);
			dom.appendChild(body);
		};
		render();
		return {
			dom,
			stopEvent: () => true,
			ignoreMutation: () => true,
			update: (next) => {
				if (next.type !== node.type) return false;
				if (JSON.stringify(next.attrs) !== JSON.stringify(sourceAttrs)) return false;
				render();
				return true;
			},
		};
	};
}

export const fireflySourceNodePlugin: MilkdownPlugin = (ctx) => async () => {
	const schemas: Array<[string, NodeSchema]> = [
		[FIREFLY_SOURCE_BLOCK, sourceNodeSchema(FIREFLY_SOURCE_BLOCK, false)],
		[FIREFLY_SOURCE_INLINE, sourceNodeSchema(FIREFLY_SOURCE_INLINE, true)],
	];
	ctx.update(nodesCtx, (nodes) => [...nodes, ...schemas]);
	const view = createSourceNodeView();
	ctx.update(nodeViewCtx, (views) => [
		...views,
		[FIREFLY_SOURCE_BLOCK, view] as [string, NodeViewConstructor],
		[FIREFLY_SOURCE_INLINE, view] as [string, NodeViewConstructor],
	]);
	return () => {
		ctx.update(nodesCtx, (nodes) =>
			nodes.filter(([id]) => id !== FIREFLY_SOURCE_BLOCK && id !== FIREFLY_SOURCE_INLINE),
		);
		ctx.update(nodeViewCtx, (views) =>
			views.filter(([id]) => id !== FIREFLY_SOURCE_BLOCK && id !== FIREFLY_SOURCE_INLINE),
		);
	};
};
