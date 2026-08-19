import type { MarkdownSourcePlaceholderKind, MarkdownStructuredNodeKind } from "./types";

export type MarkdownCodecRegistryNodeKind =
	| MarkdownSourcePlaceholderKind
	| MarkdownStructuredNodeKind
	| "opaque";

export type MarkdownCodecRegistryCategory = "opaque" | "source-placeholder" | "structured";
export type MarkdownCodecCapabilityStatus = "blocked" | "enabled" | "placeholder";

export interface MarkdownCodecNodeDefinition {
	kind: MarkdownCodecRegistryNodeKind;
	category: MarkdownCodecRegistryCategory;
	status: MarkdownCodecCapabilityStatus;
	preserveUntouchedSource: true;
	allowsNetwork: false;
	allowsUserHtml: false;
}

/**
 * This registry describes codec policy, not an editor toolbar. Placeholder entries are recognized
 * but inert; blocked authoring commands such as color and underline are intentionally absent.
 */
const MARKDOWN_CODEC_NODE_DEFINITION_SOURCE = [
	{
		kind: "text",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "paragraph",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "heading",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "strong",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "emphasis",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "strikethrough",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "link",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "inline-code",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "blockquote",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "list",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "code-block",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "thematic-break",
		category: "structured",
		status: "enabled",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "callout",
		category: "source-placeholder",
		status: "placeholder",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "details",
		category: "source-placeholder",
		status: "placeholder",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "math-inline",
		category: "source-placeholder",
		status: "placeholder",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "math-block",
		category: "source-placeholder",
		status: "placeholder",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "mermaid",
		category: "source-placeholder",
		status: "placeholder",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "video",
		category: "source-placeholder",
		status: "placeholder",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
	{
		kind: "opaque",
		category: "opaque",
		status: "blocked",
		preserveUntouchedSource: true,
		allowsNetwork: false,
		allowsUserHtml: false,
	},
] as const satisfies readonly MarkdownCodecNodeDefinition[];

/** Runtime freezing makes registry policy immutable even to untyped JavaScript consumers. */
export const MARKDOWN_CODEC_NODE_DEFINITIONS: readonly MarkdownCodecNodeDefinition[] =
	Object.freeze(
		MARKDOWN_CODEC_NODE_DEFINITION_SOURCE.map((definition) => Object.freeze(definition)),
	);

export function getMarkdownCodecNodeDefinition(
	kind: MarkdownCodecRegistryNodeKind,
): MarkdownCodecNodeDefinition | undefined {
	return MARKDOWN_CODEC_NODE_DEFINITIONS.find((definition) => definition.kind === kind);
}
