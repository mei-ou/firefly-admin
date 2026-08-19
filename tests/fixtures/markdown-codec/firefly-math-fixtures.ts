import { FIREFLY_SYNTAX_BASELINE } from "./firefly-callout-fixtures";

export { FIREFLY_SYNTAX_BASELINE };

export type FireflyMathKind = "display" | "inline";
export type FireflyMathSourceSyntax = "dollar-flow" | "dollar-text" | "fenced-math";

export interface FireflyMathFixture {
	id: string;
	source: string;
	expected: {
		recognized: boolean;
		kind?: FireflyMathKind;
		syntax?: FireflyMathSourceSyntax;
		tex?: string;
		fireflyRender?: "error" | "katex" | "plain-markdown";
		diagnostic?: string;
	};
	sourceEvidence: string;
}

/**
 * Firefly renders math during its build, but Admin V0 must keep these source slices inert. The codec
 * may classify audited delimiters for a semantic placeholder; it must not load KaTeX, emit KaTeX
 * HTML, or reinterpret an untouched delimiter merely because another spelling renders similarly.
 */
export const FIREFLY_MATH_FIXTURES: readonly FireflyMathFixture[] = [
	{
		id: "inline-euler-real-article",
		source: "例如：欧拉公式 $e^{i\\pi} + 1 = 0$ 是数学中最优美的公式之一。\n",
		expected: {
			recognized: true,
			kind: "inline",
			syntax: "dollar-text",
			tex: "e^{i\\pi} + 1 = 0",
			fireflyRender: "katex",
		},
		sourceEvidence: "src/content/posts/katex-math-example.md:13-19",
	},
	{
		id: "display-integral-real-article",
		source: "$$\n\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}\n$$\n",
		expected: {
			recognized: true,
			kind: "display",
			syntax: "dollar-flow",
			tex: "\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}",
			fireflyRender: "katex",
		},
		sourceEvidence: "src/content/posts/katex-math-example.md:21-31",
	},
	{
		id: "display-aligned-real-article",
		source:
			"$$\n\\begin{aligned}\n\\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} \\\\\n\\nabla \\cdot \\mathbf{B} &= 0\n\\end{aligned}\n$$\n",
		expected: {
			recognized: true,
			kind: "display",
			syntax: "dollar-flow",
			tex: "\\begin{aligned}\n\\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} \\\\\n\\nabla \\cdot \\mathbf{B} &= 0\n\\end{aligned}",
			fireflyRender: "katex",
		},
		sourceEvidence: "src/content/posts/katex-math-example.md:62-71",
	},
	{
		id: "display-mhchem-real-article",
		source: "$$\n\\ce{CH4 + 2O2 -> CO2 + 2H2O}\n$$\n",
		expected: {
			recognized: true,
			kind: "display",
			syntax: "dollar-flow",
			tex: "\\ce{CH4 + 2O2 -> CO2 + 2H2O}",
			fireflyRender: "katex",
		},
		sourceEvidence:
			"src/content/posts/katex-math-example.md:73-77; mhchem is loaded in astro.config.mjs",
	},
	{
		id: "inline-math-inside-gfm-table",
		source:
			"| 符号 | 代码 | 渲染结果 |\n| :--- | :--- | :--- |\n| Alpha | `\\alpha` | $\\alpha$ |\n",
		expected: {
			recognized: true,
			kind: "inline",
			syntax: "dollar-text",
			tex: "\\alpha",
			fireflyRender: "katex",
		},
		sourceEvidence: "src/content/posts/katex-math-example.md:79-89",
	},
	{
		id: "same-line-double-dollar-is-inline",
		source: "$$E = mc^2$$\n",
		expected: {
			recognized: true,
			kind: "inline",
			syntax: "dollar-text",
			tex: "E = mc^2",
			fireflyRender: "katex",
			diagnostic: "Double-dollar delimiters on one line do not create Firefly display math.",
		},
		sourceEvidence: "verified against the pinned remark-math 6.0.0 processor",
	},
	{
		id: "math-code-fence-plugin-compatible",
		source: "```math\nL = \\frac{1}{2} \\rho v^2 S C_L\n```\n",
		expected: {
			recognized: true,
			kind: "display",
			syntax: "fenced-math",
			tex: "L = \\frac{1}{2} \\rho v^2 S C_L\n",
			fireflyRender: "katex",
			diagnostic: "Supported by rehype-katex, but no matching real article source was found.",
		},
		sourceEvidence: "rehype-katex 7.0.1 language-math contract and pinned-processor probe",
	},
	{
		id: "escaped-currency-followed-by-inline-math",
		source: "价格是 \\$5，公式是 $x+1$。\n",
		expected: {
			recognized: true,
			kind: "inline",
			syntax: "dollar-text",
			tex: "x+1",
			fireflyRender: "katex",
		},
		sourceEvidence: "verified against the pinned remark-math 6.0.0 processor",
	},
	{
		id: "paired-currency-is-ambiguous-inline-math",
		source: "价格从 $5 到 $10。\n",
		expected: {
			recognized: true,
			kind: "inline",
			syntax: "dollar-text",
			tex: "5 到 ",
			fireflyRender: "katex",
			diagnostic: "Single-dollar math collides with unescaped currency text.",
		},
		sourceEvidence: "remark-math 6.0.0 defaults singleDollarTextMath to true",
	},
	{
		id: "unclosed-inline-dollar",
		source: "未闭合 $x + 1。\n",
		expected: {
			recognized: false,
			fireflyRender: "plain-markdown",
		},
		sourceEvidence: "verified against the pinned remark-math 6.0.0 processor",
	},
	{
		id: "invalid-tex-with-valid-flow-delimiters",
		source: "$$\n\\frac{1}{\n$$\n",
		expected: {
			recognized: true,
			kind: "display",
			syntax: "dollar-flow",
			tex: "\\frac{1}{",
			fireflyRender: "error",
			diagnostic: "Firefly emits a KaTeX error node instead of failing the whole document.",
		},
		sourceEvidence: "rehype-katex 7.0.1 error fallback and pinned-processor probe",
	},
	{
		id: "untrusted-href-command",
		source: "$\\href{javascript:alert(1)}{危险链接}$\n",
		expected: {
			recognized: true,
			kind: "inline",
			syntax: "dollar-text",
			tex: "\\href{javascript:alert(1)}{危险链接}",
			fireflyRender: "katex",
			diagnostic:
				"KaTeX trust defaults to false; Firefly does not emit an anchor for this command.",
		},
		sourceEvidence: "KaTeX 0.18.1 default trust=false and pinned-processor probe",
	},
];
