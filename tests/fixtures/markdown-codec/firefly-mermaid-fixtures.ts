import { FIREFLY_SYNTAX_BASELINE } from "./firefly-callout-fixtures";

export { FIREFLY_SYNTAX_BASELINE };

export type FireflyMermaidFence = "backtick" | "tilde";
export type FireflyMermaidRender = "error-fallback" | "ordinary-code" | "static-svg";

export interface FireflyMermaidFixture {
	id: string;
	source: string;
	expected: {
		recognized: boolean;
		fence?: FireflyMermaidFence;
		diagramKind?: string;
		fireflyRender: FireflyMermaidRender;
		diagnostic?: string;
	};
	sourceEvidence: string;
}

/**
 * Every kind in this list occurs in the pinned Firefly article and was rendered successfully with
 * its pinned @mermanjs/web dependency. It is evidence, not an Admin-side Mermaid grammar allowlist.
 */
export const FIREFLY_REAL_MERMAID_DIAGRAM_KINDS = [
	"graph TD",
	"sequenceDiagram",
	"erDiagram",
	"classDiagram",
	"stateDiagram-v2",
	"xychart-beta",
	"pie showData",
	"gantt",
	"mindmap",
	"timeline",
	"journey",
	"gitGraph",
	"kanban",
	"sankey-beta",
] as const;

/**
 * Admin V0 may classify an exact lowercase `mermaid` code fence for an inert source placeholder.
 * It must preserve the complete fence and body while untouched, and must never run Merman, insert
 * generated SVG, or infer that a recognized fence contains valid Mermaid syntax.
 */
export const FIREFLY_MERMAID_FIXTURES: readonly FireflyMermaidFixture[] = [
	{
		id: "real-flowchart",
		source:
			"```mermaid\ngraph TD\n    A[开始] --> B{条件检查}\n    B -->|是| C[处理步骤 1]\n    B -->|否| D[处理步骤 2]\n```\n",
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "graph TD",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:23-41",
	},
	{
		id: "real-sequence-diagram",
		source:
			"```mermaid\nsequenceDiagram\n    participant User as 用户\n    participant Server as 服务器\n    User->>Server: 提交请求\n    Server-->>User: 返回结果\n```\n",
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "sequenceDiagram",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:47-71",
	},
	{
		id: "real-er-diagram",
		source:
			'```mermaid\nerDiagram\n    USER {\n        int id PK\n        string username\n    }\n    ARTICLE {\n        int id PK\n        int author_id FK\n    }\n    USER ||--o{ ARTICLE : "writes"\n```\n',
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "erDiagram",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:77-108",
	},
	{
		id: "real-class-diagram",
		source:
			'```mermaid\nclassDiagram\n    class User {\n        +String username\n        +login()\n    }\n    class Article {\n        +String title\n        +publish()\n    }\n    User "1" -- "*" Article : 写作\n```\n',
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "classDiagram",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:114-154",
	},
	{
		id: "real-state-diagram",
		source:
			"```mermaid\nstateDiagram-v2\n    [*] --> 草稿\n    草稿 --> 审核中 : 提交\n    审核中 --> 已发布 : 批准\n    已发布 --> [*]\n```\n",
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "stateDiagram-v2",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:160-180",
	},
	{
		id: "real-xy-chart",
		source:
			'```mermaid\nxychart-beta\n    title "月度访问量趋势"\n    x-axis [1月, 2月, 3月]\n    y-axis "访问量" 0 --> 5000\n    bar [2500, 3200, 4100]\n    line [2500, 3200, 4100]\n```\n',
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "xychart-beta",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:186-193",
	},
	{
		id: "real-pie-chart",
		source:
			'```mermaid\npie showData\n    title 内容类型占比\n    "技术文章" : 45\n    "项目记录" : 30\n    "其他" : 25\n```\n',
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "pie showData",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:199-206",
	},
	{
		id: "real-gantt-chart",
		source:
			"```mermaid\ngantt\n    title 博客版本发布计划\n    dateFormat YYYY-MM-DD\n    section 准备\n    需求整理 :done, req, 2026-07-01, 3d\n    section 发布\n    正式上线 :milestone, release, after req, 0d\n```\n",
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "gantt",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:212-226",
	},
	{
		id: "real-mindmap",
		source:
			"```mermaid\nmindmap\n  root((Firefly))\n    内容\n      技术文章\n    工程\n      Astro\n      Merman\n```\n",
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "mindmap",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:232-246",
	},
	{
		id: "real-timeline",
		source:
			"```mermaid\ntimeline\n    title Firefly 演进时间线\n    2024 : 建立博客\n    2025 : 加入搜索与图库\n    2026 : 使用 Merman 渲染图表\n```\n",
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "timeline",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:252-261",
	},
	{
		id: "real-user-journey",
		source:
			"```mermaid\njourney\n    title 读者浏览文章的旅程\n    section 发现内容\n      打开首页: 5: 读者\n      搜索主题: 4: 读者\n```\n",
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "journey",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:267-279",
	},
	{
		id: "real-git-graph",
		source:
			'```mermaid\ngitGraph\n    commit id: "init"\n    branch feature\n    checkout feature\n    commit id: "add-diagrams"\n    checkout main\n    merge feature id: "merge-feature"\n```\n',
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "gitGraph",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:285-295",
	},
	{
		id: "real-kanban",
		source:
			"```mermaid\nkanban\n  todo[待办]\n    task1[整理需求]\n  doing[进行中]\n    task2[接入 Merman]\n  done[已完成]\n    task3[亮暗主题]\n```\n",
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "kanban",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:301-311",
	},
	{
		id: "real-sankey",
		source:
			"```mermaid\nsankey-beta\nHome,Post list,1200\nHome,Search,450\nPost list,Post detail,900\nPost detail,External shares,180\n```\n",
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "sankey-beta",
			fireflyRender: "static-svg",
		},
		sourceEvidence: "src/content/posts/markdown-mermaid.md:317-325",
	},
	{
		id: "commonmark-tilde-fence",
		source: "~~~mermaid\ngraph TD\n    A --> B\n~~~\n",
		expected: {
			recognized: true,
			fence: "tilde",
			diagramKind: "graph TD",
			fireflyRender: "static-svg",
			diagnostic: "Plugin-compatible CommonMark fence; no matching real article source was found.",
		},
		sourceEvidence: "pinned remark parser and Firefly plugin probe",
	},
	{
		id: "uppercase-language-is-ordinary-code",
		source: "```Mermaid\ngraph TD\n    A --> B\n```\n",
		expected: {
			recognized: false,
			fireflyRender: "ordinary-code",
			diagnostic: "remarkMermaid requires node.lang to equal lowercase mermaid exactly.",
		},
		sourceEvidence: "src/plugins/remark-mermaid.js:3-23 and pinned-processor probe",
	},
	{
		id: "malformed-mermaid-falls-back",
		source: "```mermaid\ngraph TD\n    A -->\n```\n",
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "graph TD",
			fireflyRender: "error-fallback",
			diagnostic: "Firefly keeps the source in an escaped fallback code block.",
		},
		sourceEvidence: "src/plugins/rehype-mermaid.mjs:95-127 and pinned-processor probe",
	},
	{
		id: "init-directive-falls-back",
		source:
			'```mermaid\n%%{init: {"theme": "dark", "securityLevel": "loose"}}%%\ngraph TD\n    A --> B\n```\n',
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "%%{init:",
			fireflyRender: "error-fallback",
			diagnostic: "The pinned Merman pipeline rejects this initialization directive.",
		},
		sourceEvidence: "pinned @mermanjs/web 0.8.0-alpha.3 processor probe",
	},
	{
		id: "javascript-click-does-not-survive-svg",
		source:
			'```mermaid\ngraph TD\n    A[点击] --> B[结束]\n    click A "javascript:alert(1)"\n```\n',
		expected: {
			recognized: true,
			fence: "backtick",
			diagramKind: "graph TD",
			fireflyRender: "static-svg",
			diagnostic: "Pinned output contains no script element or javascript URL.",
		},
		sourceEvidence: "assertSafeSvgForDom plus pinned-processor probe",
	},
];
