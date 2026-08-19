import { FIREFLY_SYNTAX_BASELINE } from "./firefly-callout-fixtures";

export { FIREFLY_SYNTAX_BASELINE };

export type FireflyDetailsDisposition = "opaque" | "structured";

export interface FireflyDetailsFixture {
	id: string;
	source: string;
	expected: {
		disposition: FireflyDetailsDisposition;
		open?: boolean;
		summary?: string;
		bodyMarkdown?: string;
		reason?: string;
	};
	sourceEvidence: string;
}

/**
 * Firefly currently renders raw HTML through Astro's unified Markdown processor. Admin only treats
 * the smallest audited Details subset as structured data; every attribute, nested raw HTML element,
 * or malformed boundary remains opaque so mode switches cannot broaden Firefly's trust boundary.
 */
export const FIREFLY_DETAILS_FIXTURES: readonly FireflyDetailsFixture[] = [
	{
		id: "details-real-article-closed",
		source:
			"<details>\n<summary>点击展开 Obsidian 语法列表</summary>\n\n```markdown\n> [!NOTE] NOTE\n> 通用的笔记块。\n```\n</details>\n",
		expected: {
			disposition: "structured",
			open: false,
			summary: "点击展开 Obsidian 语法列表",
			bodyMarkdown: "```markdown\n> [!NOTE] NOTE\n> 通用的笔记块。\n```\n",
		},
		sourceEvidence: "src/content/posts/markdown-extended.md:78-167",
	},
	{
		id: "details-audited-open-attribute",
		source: "<details open>\n<summary>默认展开</summary>\n\n正文 **加粗**。\n</details>\n",
		expected: {
			disposition: "structured",
			open: true,
			summary: "默认展开",
			bodyMarkdown: "正文 **加粗**。\n",
		},
		sourceEvidence:
			"HTML details open attribute verified against the pinned Astro unified processor",
	},
	{
		id: "details-summary-markdown-is-literal",
		source: "<details>\n<summary>标题 **不会加粗**</summary>\n\n正文\n</details>\n",
		expected: {
			disposition: "structured",
			open: false,
			summary: "标题 **不会加粗**",
			bodyMarkdown: "正文\n",
		},
		sourceEvidence:
			"rehype-raw preserves summary contents as raw HTML text; Markdown is not parsed inside summary",
	},
	{
		id: "details-missing-body-separator",
		source: "<details>\n<summary>标题</summary>\n正文 **不会解析**\n</details>\n",
		expected: {
			disposition: "opaque",
			reason: "A blank line after summary is required for the body to resume Markdown parsing.",
		},
		sourceEvidence: "verified against @astrojs/markdown-remark 7.2.2 and rehype-raw 7",
	},
	{
		id: "details-extra-class-is-opaque",
		source: '<details class="fold">\n<summary>带样式类</summary>\n\n正文\n</details>\n',
		expected: {
			disposition: "opaque",
			reason:
				"Admin V0 only audits the optional open attribute and does not preserve editable classes.",
		},
		sourceEvidence: "negative fixture derived from the Admin V0 safe structured subset",
	},
	{
		id: "details-event-handler-is-opaque",
		source:
			'<details onclick="alert(1)">\n<summary onmouseover="alert(2)">危险属性</summary>\n\n正文\n</details>\n',
		expected: {
			disposition: "opaque",
			reason:
				"Firefly passes raw HTML event attributes through; Admin must not execute or normalize them.",
		},
		sourceEvidence: "verified against the pinned Astro unified processor without rehype-sanitize",
	},
	{
		id: "details-script-body-is-opaque",
		source: "<details>\n<summary>危险正文</summary>\n\n<script>alert(1)</script>\n</details>\n",
		expected: {
			disposition: "opaque",
			reason: "Raw script elements pass through Firefly's current Markdown pipeline.",
		},
		sourceEvidence: "verified against the pinned Astro unified processor without rehype-sanitize",
	},
	{
		id: "details-malformed-missing-summary",
		source: "<details>\n\n正文\n</details>\n",
		expected: {
			disposition: "opaque",
			reason: "The structured subset requires one leading summary element.",
		},
		sourceEvidence: "negative fixture derived from the HTML details content model",
	},
];
