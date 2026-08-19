import { describe, expect, it } from "vitest";
import {
	createMarkdownCodecDocument,
	serializeUntouchedMarkdownNodes,
} from "../../src/modules/markdown-codec/document";
import { recognizeMarkdownMath } from "../../src/modules/markdown-codec/math";
import type { MarkdownCodecNode } from "../../src/modules/markdown-codec/types";
import { FIREFLY_MATH_FIXTURES } from "../fixtures/markdown-codec/firefly-math-fixtures";

function createTextNode(source: string, from: number, to: number): MarkdownCodecNode | null {
	if (from === to) return null;
	return {
		category: "structured",
		kind: "text",
		dirty: false,
		range: { from, to },
		sourceSlice: source.slice(from, to),
	};
}

describe("隔离 Markdown codec Math recognizer", () => {
	it("识别真实 dollar math fixtures，并保持 fenced math 为 opaque", () => {
		for (const fixture of FIREFLY_MATH_FIXTURES) {
			const result = recognizeMarkdownMath(fixture.source);
			const shouldRecognize =
				fixture.expected.recognized && fixture.expected.syntax !== "fenced-math";
			expect(result.recognized).toBe(shouldRecognize);
			if (shouldRecognize) {
				expect(result.node).toMatchObject({
					category: "source-placeholder",
					dirty: false,
					kind: fixture.expected.kind === "display" ? "math-block" : "math-inline",
					metadata: {
						mathKind: fixture.expected.kind,
						syntax: fixture.expected.syntax,
						tex: fixture.expected.tex,
					},
				});
				expect(result.node.sourceSlice).toBe(
					fixture.expected.kind === "display"
						? fixture.source
						: fixture.source.slice(result.node.range.from, result.node.range.to),
				);
				expect(result.diagnostic.code).toBe("recognized-placeholder");
			} else {
				expect(result.node).toMatchObject({ category: "opaque", kind: "opaque", dirty: false });
				expect(result.node.sourceSlice).toBe(fixture.source);
				expect(result.diagnostic.code).toBe("opaque-fallback");
			}
		}
	});

	it("行内公式只占据公式 source range，前后普通文本由文档 parser 补齐", () => {
		const source = "前缀😀 $e^{i\\pi} + 1 = 0$ 后缀\n";
		const result = recognizeMarkdownMath(source);
		expect(result.recognized).toBe(true);
		expect(result.node).toMatchObject({
			kind: "math-inline",
			metadata: { mathKind: "inline", syntax: "dollar-text", tex: "e^{i\\pi} + 1 = 0" },
		});
		expect(result.node.sourceSlice).toBe("$e^{i\\pi} + 1 = 0$");
		expect(result.node.range.from).toBe(source.indexOf("$"));
	});

	it("跳过转义美元和反引号代码跨度", () => {
		const source = "价格 \\$5，代码 `$not-math$`，公式 $x+1$。\n";
		const result = recognizeMarkdownMath(source);
		expect(result.recognized).toBe(true);
		expect(result.node).toMatchObject({
			kind: "math-inline",
			sourceSlice: "$x+1$",
			metadata: { tex: "x+1" },
		});
	});

	it("同一行双美元按 Firefly 真实行为识别为 inline", () => {
		const source = "$$E = mc^2$$\n";
		const result = recognizeMarkdownMath(source);
		expect(result.recognized).toBe(true);
		expect(result.node).toMatchObject({
			kind: "math-inline",
			sourceSlice: "$$E = mc^2$$",
			metadata: { mathKind: "inline", syntax: "dollar-text", tex: "E = mc^2" },
		});
	});

	it("独立行双美元接受 CRLF，保留原始 slice 并规范化内部 TeX 换行", () => {
		const source = "前缀\r\n$$\r\n\\begin{aligned}\r\nx &= 1\r\n\\end{aligned}\r\n$$\r\n后缀";
		const from = source.indexOf("$$");
		const to = source.lastIndexOf("$$") + 4;
		const result = recognizeMarkdownMath(source, { from, to });
		expect(result.recognized).toBe(true);
		expect(result.node).toMatchObject({
			kind: "math-block",
			range: { from, to },
			sourceSlice: source.slice(from, to),
			metadata: {
				mathKind: "display",
				syntax: "dollar-flow",
				tex: "\\begin{aligned}\nx &= 1\n\\end{aligned}",
			},
		});
	});

	it("金额歧义遵循单美元 math，而未闭合和空公式保持 opaque", () => {
		const ambiguous = recognizeMarkdownMath("价格从 $5 到 $10。\n");
		expect(ambiguous.recognized).toBe(true);
		expect(ambiguous.node).toMatchObject({ metadata: { tex: "5 到 " }, sourceSlice: "$5 到 $" });

		for (const source of ["未闭合 $x + 1。\n", "空公式 $$。\n", "$$\n\n$$\n"]) {
			const result = recognizeMarkdownMath(source);
			expect(result.recognized).toBe(false);
			expect(result.node.kind).toBe("opaque");
		}
	});

	it("Math placeholder 与前后文本组合后完整覆盖并 untouched round-trip", () => {
		const source = "公式 $x+1$ 完成。\n";
		const result = recognizeMarkdownMath(source);
		const before = createTextNode(source, 0, result.node.range.from);
		const after = createTextNode(source, result.node.range.to, source.length);
		const nodes = [before, result.node, after].filter((node) => node !== null);
		const document = createMarkdownCodecDocument(source, nodes);
		expect(document.valid).toBe(true);
		expect(serializeUntouchedMarkdownNodes(document.document.nodes)).toBe(source);
	});
});
