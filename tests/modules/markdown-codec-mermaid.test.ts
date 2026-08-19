import { describe, expect, it } from "vitest";
import {
	createMarkdownCodecDocument,
	serializeUntouchedMarkdownNodes,
} from "../../src/modules/markdown-codec/document";
import { recognizeMarkdownMermaid } from "../../src/modules/markdown-codec/mermaid";
import { FIREFLY_MERMAID_FIXTURES } from "../fixtures/markdown-codec/firefly-mermaid-fixtures";

describe("隔离 Markdown codec Mermaid recognizer", () => {
	it("按真实 fixture 识别小写 Mermaid fence，并保留完整 source slice", () => {
		for (const fixture of FIREFLY_MERMAID_FIXTURES) {
			const result = recognizeMarkdownMermaid(fixture.source);
			expect(result.recognized).toBe(fixture.expected.recognized);
			expect(result.node.sourceSlice).toBe(fixture.source);
			if (fixture.expected.recognized) {
				expect(result.node).toMatchObject({
					category: "source-placeholder",
					kind: "mermaid",
					dirty: false,
					metadata: {
						diagramKind: fixture.expected.diagramKind,
						fence: fixture.expected.fence,
					},
				});
				expect(result.diagnostic.code).toBe("recognized-placeholder");
			} else {
				expect(result.node).toMatchObject({ category: "opaque", kind: "opaque", dirty: false });
				expect(result.diagnostic.code).toBe("opaque-fallback");
			}
		}
	});

	it("大写语言标签保持 opaque ordinary code，不因图表正文相似而误识别", () => {
		const source = "```Mermaid\ngraph TD\n    A --> B\n```\n";
		const result = recognizeMarkdownMermaid(source);
		expect(result.recognized).toBe(false);
		expect(result.node).toMatchObject({ category: "opaque", sourceSlice: source });
	});

	it("波浪围栏按兼容证据识别，但保留 fence 类型和诊断边界", () => {
		const source = "~~~mermaid\ngraph TD\n    A --> B\n~~~\n";
		const result = recognizeMarkdownMermaid(source);
		expect(result.recognized).toBe(true);
		expect(result.node).toMatchObject({
			kind: "mermaid",
			metadata: { fence: "tilde", diagramKind: "graph TD" },
		});
	});

	it("非法图表、init 指令和 javascript click 只生成 inert placeholder 与诊断", () => {
		const cases = [
			{
				source: "```mermaid\ngraph TD\n    A -->\n```\n",
				message: "malformed",
			},
			{
				source:
					'```mermaid\n%%{init: {"theme": "dark", "securityLevel": "loose"}}%%\ngraph TD\n    A --> B\n```\n',
				message: "init",
			},
			{
				source: '```mermaid\ngraph TD\n    A --> B\n    click A "javascript:alert(1)"\n```\n',
				message: "javascript",
			},
		];
		for (const item of cases) {
			const result = recognizeMarkdownMermaid(item.source);
			expect(result.recognized).toBe(true);
			expect(result.node).toMatchObject({
				kind: "mermaid",
				dirty: false,
				sourceSlice: item.source,
			});
			expect(result.diagnostic).toMatchObject({ code: "recognized-placeholder" });
			expect(result.diagnostic.message.toLowerCase()).toContain(item.message);
		}
	});

	it("拒绝未闭合、错误语言和缺少完整 fence 的源码", () => {
		for (const source of [
			"```mermaid\ngraph TD\n    A --> B\n",
			"```mermaid graph TD\n    A --> B\n```\n",
			"``mermaid\ngraph TD\n    A --> B\n```\n",
		]) {
			const result = recognizeMarkdownMermaid(source);
			expect(result.recognized).toBe(false);
			expect(result.node.kind).toBe("opaque");
		}
	});

	it("CRLF 子范围保留原始围栏与正文，并记录 UTF-16 range", () => {
		const source = "前缀😀\r\n```mermaid\r\ngraph TD\r\n    A --> B\r\n```\r\n后缀";
		const from = source.indexOf("```mermaid");
		const to = source.indexOf("后缀");
		const result = recognizeMarkdownMermaid(source, { from, to });
		expect(result.recognized).toBe(true);
		expect(result.node).toMatchObject({
			range: { from, to },
			sourceSlice: source.slice(from, to),
			metadata: { diagramKind: "graph TD", fence: "backtick" },
		});
	});

	it("Mermaid placeholder 可通过文档校验并 untouched round-trip", () => {
		const source = "```mermaid\ngraph TD\n    A --> B\n```\n";
		const result = recognizeMarkdownMermaid(source);
		const document = createMarkdownCodecDocument(source, [result.node]);
		expect(document.valid).toBe(true);
		expect(serializeUntouchedMarkdownNodes(document.document.nodes)).toBe(source);
	});
});
