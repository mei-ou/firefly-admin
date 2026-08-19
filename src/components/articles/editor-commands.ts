export type InlineMarkdownCommand = "bold" | "italic" | "strikethrough" | "inline-code";

export type HeadingMarkdownCommand = `heading-${1 | 2 | 3 | 4 | 5 | 6}`;

export type BlockMarkdownCommand =
	| "paragraph"
	| HeadingMarkdownCommand
	| "quote"
	| "unordered-list"
	| "ordered-list"
	| "code-block"
	| "table"
	| "divider";

export interface MarkdownSelection {
	from: number;
	to: number;
	text: string;
}

export interface MarkdownReplacement {
	text: string;
	selectionFrom: number;
	selectionTo: number;
}

interface InlineWrapper {
	before: string;
	after: string;
	placeholder: string;
}

const INLINE_WRAPPERS: Record<InlineMarkdownCommand, InlineWrapper> = {
	bold: { before: "**", after: "**", placeholder: "粗体文字" },
	italic: { before: "*", after: "*", placeholder: "斜体文字" },
	strikethrough: { before: "~~", after: "~~", placeholder: "删除线文字" },
	"inline-code": { before: "`", after: "`", placeholder: "代码" },
};

function normalizeSelection(selection: MarkdownSelection): MarkdownSelection {
	const from = Math.max(0, Math.min(selection.from, selection.to));
	const to = Math.max(from, Math.max(selection.from, selection.to));
	return { from, to, text: selection.text };
}

function createWrappedReplacement(
	selection: MarkdownSelection,
	wrapper: InlineWrapper,
): MarkdownReplacement {
	const normalized = normalizeSelection(selection);
	const content = normalized.text || wrapper.placeholder;
	const text = `${wrapper.before}${content}${wrapper.after}`;
	const selectionFrom = wrapper.before.length;
	return {
		text,
		selectionFrom,
		selectionTo: selectionFrom + content.length,
	};
}

/**
 * 工具栏只生成明确允许的 Markdown/HTML 子集。命令层保持纯函数，图形编辑器和
 * CodeMirror 可以共享同一序列化契约，而不必各自维护格式语义。
 */
export function createInlineMarkdownReplacement(
	command: InlineMarkdownCommand,
	selection: MarkdownSelection,
): MarkdownReplacement {
	return createWrappedReplacement(selection, INLINE_WRAPPERS[command]);
}

function prefixLines(text: string, prefix: string): string {
	const source = text || "列表项";
	return source
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

export function createBlockMarkdownReplacement(
	command: BlockMarkdownCommand,
	selection: MarkdownSelection,
): MarkdownReplacement {
	const content = selection.text.trim();
	let text: string;
	switch (command) {
		case "paragraph":
			text = content || "正文";
			break;
		case "heading-1":
		case "heading-2":
		case "heading-3":
		case "heading-4":
		case "heading-5":
		case "heading-6": {
			const level = Number(command.slice("heading-".length));
			const labels = ["一级标题", "二级标题", "三级标题", "四级标题", "五级标题", "六级标题"];
			text = `${"#".repeat(level)} ${content || labels[level - 1]}`;
			break;
		}
		case "quote":
			text = prefixLines(content || "引用内容", "> ");
			break;
		case "unordered-list":
			text = prefixLines(content, "- ");
			break;
		case "ordered-list":
			text = (content || "列表项")
				.split("\n")
				.map((line, index) => `${index + 1}. ${line}`)
				.join("\n");
			break;
		case "code-block":
			text = `\`\`\`\n${content || "代码"}\n\`\`\``;
			break;
		case "table":
			text = "| 标题一 | 标题二 |\n| --- | --- |\n| 内容 | 内容 |";
			break;
		case "divider":
			text = "---";
			break;
	}
	return { text, selectionFrom: 0, selectionTo: text.length };
}

function escapeMarkdownLabel(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function escapeMarkdownTitle(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function encodeMarkdownDestination(value: string): string {
	return value.replaceAll(" ", "%20").replaceAll("(", "%28").replaceAll(")", "%29");
}

export function createMarkdownLink(input: { text: string; href: string; title?: string }): string {
	const label = escapeMarkdownLabel(input.text.trim() || "链接文字");
	const destination = encodeMarkdownDestination(input.href);
	const title = input.title?.trim();
	return `[${label}](${destination}${title ? ` "${escapeMarkdownTitle(title)}"` : ""})`;
}

export function createMarkdownImage(input: { alt: string; src: string; title?: string }): string {
	const alt = escapeMarkdownLabel(input.alt.trim());
	const destination = encodeMarkdownDestination(input.src);
	const title = input.title?.trim();
	return `![${alt}](${destination}${title ? ` "${escapeMarkdownTitle(title)}"` : ""})`;
}
