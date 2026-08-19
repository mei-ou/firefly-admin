import type {
	EditorCommandCategory,
	EditorCommandDefinition,
	EditorCommandStatus,
	EditorMode,
} from "./types";

type CommandSource = {
	id: string;
	category: EditorCommandCategory;
	status: EditorCommandStatus;
	sourceSyntax: string;
	adapters: readonly EditorMode[];
};

const EDITOR_COMMAND_DEFINITION_SOURCE = [
	{
		id: "bold",
		category: "inline",
		status: "enabled",
		sourceSyntax: "**text**",
		adapters: ["source", "visual"],
	},
	{
		id: "italic",
		category: "inline",
		status: "enabled",
		sourceSyntax: "*text*",
		adapters: ["source", "visual"],
	},
	{
		id: "strikethrough",
		category: "inline",
		status: "enabled",
		sourceSyntax: "~~text~~",
		adapters: ["source", "visual"],
	},
	{
		id: "inline-code",
		category: "inline",
		status: "enabled",
		sourceSyntax: "`code`",
		adapters: ["source", "visual"],
	},
	{
		id: "heading",
		category: "block",
		status: "enabled",
		sourceSyntax: "# text",
		adapters: ["source", "visual"],
	},
	{
		id: "blockquote",
		category: "block",
		status: "enabled",
		sourceSyntax: "> text",
		adapters: ["source", "visual"],
	},
	{
		id: "list",
		category: "block",
		status: "enabled",
		sourceSyntax: "- text",
		adapters: ["source", "visual"],
	},
	{
		id: "code-block",
		category: "block",
		status: "enabled",
		sourceSyntax: "```text```",
		adapters: ["source", "visual"],
	},
	{
		id: "table",
		category: "block",
		status: "enabled",
		sourceSyntax: "| cell | cell |",
		adapters: ["source", "visual"],
	},
	{
		id: "thematic-break",
		category: "block",
		status: "enabled",
		sourceSyntax: "---",
		adapters: ["source", "visual"],
	},
	{
		id: "image",
		category: "inline",
		status: "enabled",
		sourceSyntax: "![alt](./asset.png)",
		adapters: ["source", "visual"],
	},
	{
		id: "link",
		category: "inline",
		status: "enabled",
		sourceSyntax: "[label](https://example.com)",
		adapters: ["source", "visual"],
	},
	{
		id: "callout",
		category: "special",
		status: "placeholder",
		sourceSyntax: "> [!NOTE]",
		adapters: ["source", "visual"],
	},
	{
		id: "details",
		category: "special",
		status: "placeholder",
		sourceSyntax: "<details>...</details>",
		adapters: ["source", "visual"],
	},
	{
		id: "math",
		category: "special",
		status: "placeholder",
		sourceSyntax: "$...$ or $$...$$",
		adapters: ["source", "visual"],
	},
	{
		id: "mermaid",
		category: "special",
		status: "placeholder",
		sourceSyntax: "```mermaid...```",
		adapters: ["source", "visual"],
	},
	{
		id: "video",
		category: "special",
		status: "placeholder",
		sourceSyntax: "fixed iframe source",
		adapters: ["source", "visual"],
	},
	{
		id: "underline",
		category: "inline",
		status: "blocked",
		sourceSyntax: "no confirmed Firefly syntax",
		adapters: [],
	},
	{
		id: "highlight",
		category: "inline",
		status: "blocked",
		sourceSyntax: "no confirmed Firefly syntax",
		adapters: [],
	},
	{
		id: "text-color",
		category: "inline",
		status: "blocked",
		sourceSyntax: "no confirmed Firefly syntax",
		adapters: [],
	},
	{
		id: "font-size",
		category: "inline",
		status: "blocked",
		sourceSyntax: "no confirmed Firefly syntax",
		adapters: [],
	},
] as const satisfies readonly CommandSource[];

export const EDITOR_COMMAND_DEFINITIONS: readonly EditorCommandDefinition[] = Object.freeze(
	EDITOR_COMMAND_DEFINITION_SOURCE.map((definition) => Object.freeze(definition)),
);

export function getEditorCommandDefinition(id: string): EditorCommandDefinition | undefined {
	return EDITOR_COMMAND_DEFINITIONS.find((definition) => definition.id === id);
}

export function assertEditorCommandAvailable(
	id: string,
	mode: EditorMode,
): EditorCommandDefinition {
	const definition = getEditorCommandDefinition(id);
	if (definition?.status !== "enabled" || !definition.adapters.includes(mode)) {
		throw new TypeError(`Editor command is unavailable in ${mode} mode: ${id}.`);
	}
	return definition;
}
