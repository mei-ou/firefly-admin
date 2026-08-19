import { describe, expect, it } from "vitest";
import { applyMarkdownCodecEdit } from "../../src/modules/markdown-codec/edit";
import { serializeUntouchedMarkdownNodes } from "../../src/modules/markdown-codec/document";
import { parseMarkdownDocument } from "../../src/modules/markdown-codec/parser";
import {
	canonicalizeMarkdownSource,
	serializeMarkdownCodecDocument,
} from "../../src/modules/markdown-codec/serializer";

function expectValidRoundTrip(source: string) {
	const result = parseMarkdownDocument(source);
	expect(result.valid).toBe(true);
	expect(serializeUntouchedMarkdownNodes(result.document.nodes)).toBe(source);
	let expectedFrom = 0;
	for (const node of result.document.nodes) {
		expect(node.range.from).toBe(expectedFrom);
		expect(node.range.to).toBeGreaterThan(node.range.from);
		expect(node.sourceSlice).toBe(source.slice(node.range.from, node.range.to));
		expectedFrom = node.range.to;
	}
	expect(expectedFrom).toBe(source.length);
	return result;
}

describe("完整 Markdown 分段 parser 第一版", () => {
	it("解析空源码、普通文本、astral Unicode、CRLF 与无尾换行", () => {
		expectValidRoundTrip("");
		const source = "😀 标题\r\n普通正文\n无尾换行";
		const result = expectValidRoundTrip(source);
		expect(result.document.nodes.map((node) => node.kind)).toEqual([
			"paragraph",
			"text",
			"paragraph",
			"text",
			"paragraph",
		]);
	});

	it("组合 Callout、Details、Math、Mermaid、Video 与前后普通文本", () => {
		const source = [
			"前缀 $x+1$ 后缀\n",
			"> [!NOTE] 提示\n> 正文\n",
			"<details open>\n<summary>标题</summary>\n\n详情正文\n</details>\n",
			"$$\nE = mc^2\n$$\n",
			"```mermaid\ngraph TD\nA --> B\n```\n",
			'<iframe width="100%" height="468" src="https://www.youtube.com/embed/dQw4w9WgXcQ" title="YouTube video player" frameborder="0" allowfullscreen></iframe>\n',
			"结尾\n",
		].join("");
		const result = expectValidRoundTrip(source);
		expect(result.document.nodes.map((node) => node.kind)).toEqual(
			expect.arrayContaining([
				"text",
				"math-inline",
				"callout",
				"details",
				"math-block",
				"mermaid",
				"video",
			]),
		);
	});

	it("普通 fenced code 和大写 Mermaid 屏蔽内部特殊语法", () => {
		const source = [
			"```md\n",
			"> [!NOTE] 不识别\n",
			"$x$\n",
			'<iframe src="javascript:alert(1)"></iframe>\n',
			"```\n",
			"```Mermaid\ngraph TD\nA --> B\n```\n",
		].join("");
		const result = expectValidRoundTrip(source);
		expect(result.document.nodes).toHaveLength(2);
		expect(result.document.nodes.every((node) => node.kind === "code-block")).toBe(true);
	});

	it("inline code 屏蔽 Math，同时仍识别代码跨度之后的公式", () => {
		const source = "`$code$` 与 **普通** $real$\n";
		const result = expectValidRoundTrip(source);
		expect(result.document.nodes.filter((node) => node.kind === "math-inline")).toHaveLength(1);
		expect(result.document.nodes.find((node) => node.kind === "math-inline")?.sourceSlice).toBe(
			"$real$",
		);
	});

	it("转义美元和未闭合美元保持普通文本", () => {
		const source = "价格 \\$5 和 $unclosed\n";
		const result = expectValidRoundTrip(source);
		expect(result.document.nodes.map((node) => node.kind)).toEqual(["paragraph", "text"]);
	});

	it("未知 raw HTML、注释与 script 失败关闭，但普通 a < b 保持文本", () => {
		const source =
			'a < b\n<!--\n隐藏注释\n-->\n<script>\nalert(1)\n</script>\n<span onclick="x">危险</span>\n';
		const result = expectValidRoundTrip(source);
		expect(result.document.nodes[0]?.kind).toBe("paragraph");
		expect(
			result.document.nodes.filter((node) => node.kind === "opaque").length,
		).toBeGreaterThanOrEqual(2);
		expect(
			result.document.diagnostics.some((diagnostic) => diagnostic.code === "opaque-fallback"),
		).toBe(true);
	});

	it("畸形 Details、非模板 Video 和 Bilibili 候选均保留 opaque source", () => {
		const source = [
			"<details>\n<summary>标题</summary>\n缺少空行\n</details>\n",
			'<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1"></iframe>\n',
			'<iframe width="100%" height="468" src="https://player.bilibili.com/player.html?bvid=BV1xx411c7mD&p=1&autoplay=0" scrolling="no" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>\n',
		].join("");
		const result = expectValidRoundTrip(source);
		expect(result.document.nodes.every((node) => node.kind === "opaque")).toBe(true);
	});

	it("未闭合 fence、Details 和 Math block 把剩余安全范围整体 opaque", () => {
		for (const source of [
			"前缀\n```md\n未闭合\n",
			"前缀\n<details>\n<summary>标题</summary>\n\n正文\n",
			"前缀\n$$\nE=mc^2\n",
		]) {
			const result = expectValidRoundTrip(source);
			expect(result.document.nodes.at(-1)?.kind).toBe("opaque");
		}
	});

	it("iteration budget 耗尽时不跳字符并将剩余源码 opaque", () => {
		const source = "第一行\n第二行\n第三行\n";
		const result = parseMarkdownDocument(source, { maxIterations: 1 });
		expect(result.valid).toBe(true);
		expect(serializeUntouchedMarkdownNodes(result.document.nodes)).toBe(source);
		expect(result.document.nodes.at(-1)?.kind).toBe("opaque");
	});

	it("普通 Markdown 行进入受控结构节点并保持精确 source slice", () => {
		const result = expectValidRoundTrip("# 标题\n> 引用\n- 列表项\n---\n普通段落\n");
		expect(result.document.nodes.map((node) => node.kind)).toEqual([
			"heading",
			"text",
			"blockquote",
			"text",
			"list",
			"text",
			"thematic-break",
			"text",
			"paragraph",
			"text",
		]);
	});

	it("serializer 与 canonicalize 是幂等的，且不经过 HTML 反向转换", () => {
		const source = "__原始分隔符__\n\n<details>\n<summary>标题</summary>\n\n正文\n</details>\n";
		const result = parseMarkdownDocument(source);
		expect(serializeMarkdownCodecDocument(result.document)).toBe(source);
		expect(canonicalizeMarkdownSource(canonicalizeMarkdownSource(source))).toBe(source);
	});

	it("局部结构编辑可以重解析，但不会触及特殊块和 opaque source", () => {
		const source = "普通段落\n> [!NOTE]\n> 保留\n<script>\n危险\n</script>\n";
		const result = parseMarkdownDocument(source);
		const paragraphEnd = source.indexOf("\n") + 1;
		const edited = applyMarkdownCodecEdit(result.document, {
			range: { from: 0, to: paragraphEnd - 1 },
			replacement: "# 已编辑段落",
		});
		expect(edited).toMatchObject({
			ok: true,
			source: "# 已编辑段落\n> [!NOTE]\n> 保留\n<script>\n危险\n</script>\n",
		});

		const protectedNode = result.document.nodes.find((node) => node.category !== "structured");
		expect(protectedNode).toBeDefined();
		const blocked = applyMarkdownCodecEdit(result.document, {
			range: { from: protectedNode?.range.from ?? 0, to: protectedNode?.range.to ?? 0 },
			replacement: "被阻断",
		});
		expect(blocked).toEqual({ ok: false, reason: "protected-node" });
	});

	it("局部编辑的范围切开 CRLF 或产生无法解释的结果时失败关闭", () => {
		const source = "段落\r\n> [!NOTE]\r\n> 保留\r\n";
		const result = parseMarkdownDocument(source);
		expect(
			applyMarkdownCodecEdit(result.document, { range: { from: 3, to: 3 }, replacement: "x" }),
		).toEqual({ ok: false, reason: "invalid-range" });
	});
});
