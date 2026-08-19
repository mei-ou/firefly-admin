import { getEditorCommandDefinition } from "../../modules/editor-core/capability-registry";
import type { BlockMarkdownCommand, InlineMarkdownCommand } from "./editor-commands";

export type ToolbarCommandId = InlineMarkdownCommand | BlockMarkdownCommand | "link" | "image";

export type ToolbarCommandGroup = "inline" | "block" | "insert";

export interface ToolbarCommandDefinition {
	id: ToolbarCommandId;
	group: ToolbarCommandGroup;
	label: string;
	content: string;
	shortcut?: string;
	compact?: boolean;
}

/**
 * 工具栏的顺序、分组和展示信息集中在注册表中。新增普通命令时只需注册定义、补充命令
 * 序列化和测试；Svelte 组件不再随按钮数量增长而堆叠重复模板。
 */
export const TOOLBAR_COMMANDS = [
	{ id: "bold", group: "inline", label: "粗体", content: "B", shortcut: "Ctrl+B" },
	{ id: "italic", group: "inline", label: "斜体", content: "I", shortcut: "Ctrl+I" },
	{ id: "strikethrough", group: "inline", label: "删除线", content: "S" },
	{ id: "inline-code", group: "inline", label: "行内代码", content: "</>" },
	{ id: "quote", group: "block", label: "引用", content: "“" },
	{ id: "unordered-list", group: "block", label: "无序列表", content: "• 列表" },
	{ id: "ordered-list", group: "block", label: "有序列表", content: "1. 列表" },
	{ id: "code-block", group: "block", label: "代码块", content: "代码块", compact: false },
	{ id: "table", group: "block", label: "表格", content: "表格", compact: false },
	{ id: "link", group: "insert", label: "链接", content: "链接" },
	{ id: "image", group: "insert", label: "图片", content: "图片" },
	{ id: "divider", group: "insert", label: "分隔线", content: "分隔线", compact: false },
] as const satisfies readonly ToolbarCommandDefinition[];

const TOOLBAR_CAPABILITY_IDS: Readonly<Record<string, string>> = {
	quote: "blockquote",
	"unordered-list": "list",
	"ordered-list": "list",
	"code-block": "code-block",
	table: "table",
	divider: "thematic-break",
	link: "link",
	image: "image",
};

function assertToolbarCapabilities(): void {
	for (const command of TOOLBAR_COMMANDS) {
		const capabilityId = TOOLBAR_CAPABILITY_IDS[command.id] ?? command.id;
		const definition = getEditorCommandDefinition(capabilityId);
		if (definition?.status !== "enabled") {
			throw new TypeError(`Toolbar command is not enabled by editor-core: ${command.id}.`);
		}
	}
}

assertToolbarCapabilities();

export const TOOLBAR_GROUP_LABELS: Record<ToolbarCommandGroup, string> = {
	inline: "文字样式",
	block: "段落结构",
	insert: "插入内容",
};

export function getToolbarCommands(
	group: ToolbarCommandGroup,
): readonly ToolbarCommandDefinition[] {
	return TOOLBAR_COMMANDS.filter((command) => command.group === group);
}
