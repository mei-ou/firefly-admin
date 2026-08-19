import { FIREFLY_SYNTAX_BASELINE } from "./firefly-callout-fixtures";

export { FIREFLY_SYNTAX_BASELINE };

export type FireflyInlineStyleDisposition = "ordinary-text" | "opaque" | "structured";
export type FireflyInlineStyleFeature =
	| "bold"
	| "color"
	| "font-size"
	| "highlight"
	| "italic"
	| "link"
	| "spoiler"
	| "strikethrough"
	| "underline";
export type FireflyInlineStyleSupport = "blocked" | "enabled" | "not-applicable";

export interface FireflyInlineStyleFixture {
	id: string;
	source: string;
	expected: {
		feature: FireflyInlineStyleFeature;
		disposition: FireflyInlineStyleDisposition;
		support: FireflyInlineStyleSupport;
		canonicalAfterEdit?: string;
		diagnostic: string;
	};
	sourceEvidence: string;
}

/**
 * Only standard emphasis and GFM strikethrough have both pinned article evidence and a stable
 * Markdown AST contract. The other requested toolbar marks stay blocked until Firefly defines a
 * canonical, allowlisted source syntax; raw HTML compatibility is not treated as feature support.
 */
export const FIREFLY_INLINE_STYLE_SUPPORT = {
	bold: "enabled",
	italic: "enabled",
	strikethrough: "enabled",
	underline: "blocked",
	highlight: "blocked",
	color: "blocked",
	fontSize: "blocked",
} as const satisfies Record<
	"bold" | "color" | "fontSize" | "highlight" | "italic" | "strikethrough" | "underline",
	"blocked" | "enabled"
>;

export const FIREFLY_INLINE_STYLE_FIXTURES: readonly FireflyInlineStyleFixture[] = [
	{
		id: "bold-asterisk",
		source: "**粗体文本**",
		expected: {
			feature: "bold",
			disposition: "structured",
			support: "enabled",
			canonicalAfterEdit: "**粗体文本**",
			diagnostic: "Real article syntax with a stable CommonMark strong node.",
		},
		sourceEvidence: "src/content/spec/about.md:3 and markdown-tutorial.md:703-727",
	},
	{
		id: "bold-underscore",
		source: "__粗体文本__",
		expected: {
			feature: "bold",
			disposition: "structured",
			support: "enabled",
			canonicalAfterEdit: "**粗体文本**",
			diagnostic:
				"Documented alternative delimiter; semantic editing may normalize it to asterisks.",
		},
		sourceEvidence: "src/content/posts/markdown-tutorial.md:703-727",
	},
	{
		id: "italic-asterisk",
		source: "*斜体文本*",
		expected: {
			feature: "italic",
			disposition: "structured",
			support: "enabled",
			canonicalAfterEdit: "*斜体文本*",
			diagnostic: "Real article syntax with a stable CommonMark emphasis node.",
		},
		sourceEvidence: "src/content/spec/about.md:28 and markdown-tutorial.md:703-727",
	},
	{
		id: "italic-underscore",
		source: "_斜体文本_",
		expected: {
			feature: "italic",
			disposition: "structured",
			support: "enabled",
			canonicalAfterEdit: "*斜体文本*",
			diagnostic: "Real alternative delimiter; semantic editing may normalize it to asterisks.",
		},
		sourceEvidence: "src/content/posts/markdown-tutorial.md:703-727",
	},
	{
		id: "gfm-strikethrough",
		source: "~~删除文本~~",
		expected: {
			feature: "strikethrough",
			disposition: "structured",
			support: "enabled",
			canonicalAfterEdit: "~~删除文本~~",
			diagnostic: "Real article syntax rendered by Astro's enabled GFM pipeline.",
		},
		sourceEvidence: "src/content/posts/markdown-tutorial.md:852-871",
	},
	{
		id: "nested-standard-marks",
		source: "***粗斜体*** 和 **粗体中的 ~~删除线~~**",
		expected: {
			feature: "bold",
			disposition: "structured",
			support: "enabled",
			diagnostic: "Standard Markdown marks may nest without using raw HTML.",
		},
		sourceEvidence: "pinned CommonMark and GFM processor probe",
	},
	{
		id: "escaped-asterisks-are-text",
		source: "\\*不是斜体\\*",
		expected: {
			feature: "italic",
			disposition: "ordinary-text",
			support: "not-applicable",
			diagnostic: "Escaped delimiters remain literal text and must not create a mark.",
		},
		sourceEvidence: "src/content/posts/markdown-tutorial.md:731-743",
	},
	{
		id: "link-css-is-not-underline-mark",
		source: "[带下划线视觉的链接](https://example.com)",
		expected: {
			feature: "link",
			disposition: "structured",
			support: "enabled",
			diagnostic:
				"Firefly CSS underlines article links; the underline belongs to link rendering, not a free text mark.",
		},
		sourceEvidence: "src/styles/markdown.css:37-49",
	},
	{
		id: "raw-html-underline",
		source: "<u>下划线文本</u>",
		expected: {
			feature: "underline",
			disposition: "opaque",
			support: "blocked",
			diagnostic:
				"Raw HTML passes through Firefly, but no real article or allowlisted underline syntax exists.",
		},
		sourceEvidence: "pinned raw-HTML processor probe; no matching article source found",
	},
	{
		id: "directive-underline",
		source: ":u[下划线文本]",
		expected: {
			feature: "underline",
			disposition: "opaque",
			support: "blocked",
			diagnostic:
				"The generic directive bridge emits a u element without a directive-name allowlist; this is not a stable authoring contract.",
		},
		sourceEvidence: "src/plugins/remark-directive-rehype.js:33-97 and processor probe",
	},
	{
		id: "raw-html-highlight",
		source: "<mark>高亮文本</mark>",
		expected: {
			feature: "highlight",
			disposition: "opaque",
			support: "blocked",
			diagnostic:
				"Raw mark HTML renders, but article CSS and real content define no canonical body highlight.",
		},
		sourceEvidence: "pinned raw-HTML processor probe; no matching article source found",
	},
	{
		id: "directive-highlight",
		source: ":mark[高亮文本]",
		expected: {
			feature: "highlight",
			disposition: "opaque",
			support: "blocked",
			diagnostic:
				"The generic directive bridge can emit mark, but it has no tag or attribute safety allowlist.",
		},
		sourceEvidence: "src/plugins/remark-directive-rehype.js:33-97 and processor probe",
	},
	{
		id: "double-equals-is-ordinary-text",
		source: "==不是高亮语法==",
		expected: {
			feature: "highlight",
			disposition: "ordinary-text",
			support: "blocked",
			diagnostic: "No enabled plugin recognizes double-equals body highlighting.",
		},
		sourceEvidence: "pinned processor probe; no matching plugin or article source found",
	},
	{
		id: "spoiler-is-not-highlight",
		source: ":spoiler[被隐藏的文本]",
		expected: {
			feature: "spoiler",
			disposition: "opaque",
			support: "not-applicable",
			diagnostic:
				"Spoiler is a real reveal-on-hover directive, not a body highlight mark, and is outside the current node registry scope.",
		},
		sourceEvidence: "src/content/posts/markdown-extended.md:246-253 and main.css:510-527",
	},
	{
		id: "raw-html-color",
		source: '<span style="color: red">红色文本</span>',
		expected: {
			feature: "color",
			disposition: "opaque",
			support: "blocked",
			diagnostic:
				"Arbitrary inline style passes through without sanitization; no canonical Markdown color syntax exists.",
		},
		sourceEvidence: "pinned raw-HTML processor probe; no matching article source found",
	},
	{
		id: "raw-html-font-size",
		source: '<span style="font-size: 32px">大号文本</span>',
		expected: {
			feature: "font-size",
			disposition: "opaque",
			support: "blocked",
			diagnostic:
				"Arbitrary CSS size passes through without a value allowlist; no canonical Markdown size syntax exists.",
		},
		sourceEvidence: "pinned raw-HTML processor probe; no matching article source found",
	},
	{
		id: "deprecated-font-element",
		source: '<font color="red" size="5">旧式文本</font>',
		expected: {
			feature: "color",
			disposition: "opaque",
			support: "blocked",
			diagnostic:
				"Deprecated arbitrary HTML has no real article evidence and must never be generated.",
		},
		sourceEvidence: "negative compatibility fixture",
	},
	{
		id: "directive-style-and-event",
		source: ':span[危险文本]{style="color:red;font-size:32px" onclick="alert(1)"}',
		expected: {
			feature: "color",
			disposition: "opaque",
			support: "blocked",
			diagnostic:
				"The generic directive bridge preserves arbitrary style and event attributes, so it cannot define a safe text-style protocol.",
		},
		sourceEvidence: "src/plugins/remark-directive-rehype.js:80-97 and processor probe",
	},
	{
		id: "mdx-tailwind-color-and-size",
		source: '<span class="text-red-500 text-4xl">MDX 文本</span>',
		expected: {
			feature: "color",
			disposition: "opaque",
			support: "blocked",
			diagnostic:
				"Real MDX presentation classes are trusted executable content and are outside Admin's format-md article contract.",
		},
		sourceEvidence: "src/content/posts/mdx-example.mdx:40-56 and spec/friends.mdx:49-146",
	},
];
