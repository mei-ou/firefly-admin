export const FIREFLY_SYNTAX_BASELINE = {
	repository: "https://github.com/mei-ou/Firefly.git",
	branch: "test",
	commit: "25006af903b9ef067963981ac51cb39aae431036",
	upstreamCommit: "dd48f0b240aafd19ebba0b4e0812de3cc23be75a",
	calloutTheme: "github",
} as const;

export type FireflyCalloutType = "caution" | "important" | "note" | "tip" | "warning";

export interface FireflyCalloutFixture {
	id: string;
	source: string;
	expected: {
		recognized: boolean;
		type?: FireflyCalloutType;
		title?: string;
	};
	sourceEvidence: string;
}

/**
 * These fixtures are copied from the pinned Firefly repository instead of being inferred from
 * rehype-callouts documentation. The codec must preserve each source slice until a user edits the
 * callout; merely parsing or switching editor modes must not rewrite it.
 */
export const FIREFLY_CALLOUT_FIXTURES: readonly FireflyCalloutFixture[] = [
	{
		id: "github-note-default-title",
		source: "> [!NOTE]\n> 突出显示用户应该考虑的信息。\n",
		expected: { recognized: true, type: "note" },
		sourceEvidence: "src/content/posts/code-examples.md:331",
	},
	{
		id: "github-tip-explicit-title",
		source: "> [!TIP] TIP\n> 可选信息，帮助用户更成功。\n",
		expected: { recognized: true, type: "tip", title: "TIP" },
		sourceEvidence: "src/content/posts/markdown-extended.md:56",
	},
	{
		id: "github-important",
		source: "> [!IMPORTANT] IMPORTANT\n> 用户成功所必需的关键信息。\n",
		expected: { recognized: true, type: "important", title: "IMPORTANT" },
		sourceEvidence: "src/content/posts/markdown-extended.md:59",
	},
	{
		id: "github-warning",
		source: "> [!WARNING] WARNING\n> 关键内容，需要立即注意。\n",
		expected: { recognized: true, type: "warning", title: "WARNING" },
		sourceEvidence: "src/content/posts/markdown-extended.md:62",
	},
	{
		id: "github-caution",
		source: "> [!CAUTION] CAUTION\n> 行动的负面潜在后果。\n",
		expected: { recognized: true, type: "caution", title: "CAUTION" },
		sourceEvidence: "src/content/posts/markdown-extended.md:65",
	},
	{
		id: "github-note-custom-title",
		source: "> [!NOTE] 自定义标题\n> 这是一个带有自定义标题的示例。\n",
		expected: { recognized: true, type: "note", title: "自定义标题" },
		sourceEvidence: "src/content/posts/markdown-extended.md:68",
	},
	{
		id: "ordinary-blockquote",
		source: "> 普通引用，不是提示框。\n",
		expected: { recognized: false },
		sourceEvidence: "negative fixture derived from the pinned parser contract",
	},
	{
		id: "unsupported-callout-type",
		source: "> [!DANGER] 未在当前 GitHub 主题中启用\n> 必须保留原始源码，不得猜测映射。\n",
		expected: { recognized: false },
		sourceEvidence: "siteConfig.post.rehypeCallouts.theme=github and rehype-callouts 2.2.0",
	},
	{
		id: "docusaurus-fence-not-current-theme",
		source: ":::tip\n这只是说明文章中的其他主题示例。\n:::\n",
		expected: { recognized: false },
		sourceEvidence: "src/content/posts/markdown-extended.md:219; current theme remains github",
	},
	{
		id: "python-admonition-disabled",
		source: '!!! note "标题"\n    当前部署关闭了 Python-Markdown admonition 转换。\n',
		expected: { recognized: false },
		sourceEvidence: "src/config/siteConfig.ts:203-207; enablePythonMarkdownAdmonitions=false",
	},
];
