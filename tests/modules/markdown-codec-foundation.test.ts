import { describe, expect, it } from "vitest";
import {
	createMarkdownCodecDocument,
	serializeUntouchedMarkdownNodes,
} from "../../src/modules/markdown-codec/document";
import { recognizeMarkdownCallout } from "../../src/modules/markdown-codec/callout";
import { recognizeMarkdownDetails } from "../../src/modules/markdown-codec/details";
import { createMarkdownOpaqueFallback } from "../../src/modules/markdown-codec/opaque-fallback";
import {
	getMarkdownCodecNodeDefinition,
	MARKDOWN_CODEC_NODE_DEFINITIONS,
} from "../../src/modules/markdown-codec/node-registry";
import {
	getMarkdownSourceLocation,
	isMarkdownCrlfInteriorOffset,
	readMarkdownSourceSlice,
	validateMarkdownSourceRange,
} from "../../src/modules/markdown-codec/source-range";
import type {
	MarkdownCodecNode,
	MarkdownSourcePlaceholderKind,
	MarkdownStructuredNodeKind,
} from "../../src/modules/markdown-codec/types";
import { FIREFLY_CALLOUT_FIXTURES } from "../fixtures/markdown-codec/firefly-callout-fixtures";
import { FIREFLY_DETAILS_FIXTURES } from "../fixtures/markdown-codec/firefly-details-fixtures";
import { FIREFLY_INLINE_STYLE_FIXTURES } from "../fixtures/markdown-codec/firefly-inline-style-fixtures";
import { FIREFLY_MATH_FIXTURES } from "../fixtures/markdown-codec/firefly-math-fixtures";
import { FIREFLY_MERMAID_FIXTURES } from "../fixtures/markdown-codec/firefly-mermaid-fixtures";
import { FIREFLY_VIDEO_FIXTURES } from "../fixtures/markdown-codec/firefly-video-fixtures";

const ALL_REAL_SYNTAX_SOURCES = [
	...FIREFLY_CALLOUT_FIXTURES.map((fixture) => fixture.source),
	...FIREFLY_DETAILS_FIXTURES.map((fixture) => fixture.source),
	...FIREFLY_MATH_FIXTURES.map((fixture) => fixture.source),
	...FIREFLY_MERMAID_FIXTURES.map((fixture) => fixture.source),
	...FIREFLY_VIDEO_FIXTURES.map((fixture) => fixture.source),
	...FIREFLY_INLINE_STYLE_FIXTURES.map((fixture) => fixture.source),
] as const;

const ALL_STRUCTURED_KINDS = [
	"blockquote",
	"code-block",
	"emphasis",
	"heading",
	"inline-code",
	"link",
	"list",
	"paragraph",
	"strikethrough",
	"strong",
	"text",
	"thematic-break",
] as const satisfies readonly MarkdownStructuredNodeKind[];

const ALL_PLACEHOLDER_KINDS = [
	"callout",
	"details",
	"math-block",
	"math-inline",
	"mermaid",
	"video",
] as const satisfies readonly MarkdownSourcePlaceholderKind[];

type MissingStructuredKind = Exclude<
	MarkdownStructuredNodeKind,
	(typeof ALL_STRUCTURED_KINDS)[number]
>;
type MissingPlaceholderKind = Exclude<
	MarkdownSourcePlaceholderKind,
	(typeof ALL_PLACEHOLDER_KINDS)[number]
>;
const STRUCTURED_KINDS_ARE_EXHAUSTIVE: MissingStructuredKind extends never ? true : false = true;
const PLACEHOLDER_KINDS_ARE_EXHAUSTIVE: MissingPlaceholderKind extends never ? true : false = true;

function createOpaqueDocument(source: string) {
	const fallback = createMarkdownOpaqueFallback(
		source,
		{ from: 0, to: source.length },
		"Foundation skeleton has no syntax recognizers yet.",
	);
	return createMarkdownCodecDocument(source, [fallback.node], [fallback.diagnostic]);
}

describe("隔离 Markdown codec 基础骨架", () => {
	it("节点注册项完整、唯一、运行时不可变且全部禁止网络和用户 HTML", () => {
		expect(STRUCTURED_KINDS_ARE_EXHAUSTIVE).toBe(true);
		expect(PLACEHOLDER_KINDS_ARE_EXHAUSTIVE).toBe(true);
		const kinds = MARKDOWN_CODEC_NODE_DEFINITIONS.map((definition) => definition.kind);
		expect(kinds).toHaveLength(ALL_STRUCTURED_KINDS.length + ALL_PLACEHOLDER_KINDS.length + 1);
		expect(new Set(kinds)).toEqual(
			new Set([...ALL_STRUCTURED_KINDS, ...ALL_PLACEHOLDER_KINDS, "opaque"]),
		);
		expect(new Set(kinds).size).toBe(kinds.length);
		expect(Object.isFrozen(MARKDOWN_CODEC_NODE_DEFINITIONS)).toBe(true);
		expect(MARKDOWN_CODEC_NODE_DEFINITIONS.every((definition) => Object.isFrozen(definition))).toBe(
			true,
		);
		expect(
			MARKDOWN_CODEC_NODE_DEFINITIONS.every((definition) => definition.allowsNetwork === false),
		).toBe(true);
		expect(
			MARKDOWN_CODEC_NODE_DEFINITIONS.every((definition) => definition.allowsUserHtml === false),
		).toBe(true);
		expect(
			MARKDOWN_CODEC_NODE_DEFINITIONS.every(
				(definition) => definition.preserveUntouchedSource === true,
			),
		).toBe(true);
	});

	it("注册六个真实特殊块节点为 inert placeholder", () => {
		for (const kind of ALL_PLACEHOLDER_KINDS) {
			expect(getMarkdownCodecNodeDefinition(kind)).toMatchObject({
				category: "source-placeholder",
				status: "placeholder",
				allowsNetwork: false,
				allowsUserHtml: false,
			});
		}
	});

	it("不注册证据不足的颜色、字号、下划线和高亮节点", () => {
		const kinds = new Set<string>(
			MARKDOWN_CODEC_NODE_DEFINITIONS.map((definition) => definition.kind),
		);
		for (const blocked of ["color", "font-size", "underline", "highlight"]) {
			expect(kinds.has(blocked)).toBe(false);
		}
	});

	it("使用 UTF-16 半开范围读取 astral Unicode，并将 CRLF 作为单一逻辑换行", () => {
		const source = "😀开头\r\n第二行";
		expect(source.length).toBe(9);
		expect(readMarkdownSourceSlice(source, { from: 0, to: 2 })).toBe("😀");
		expect(readMarkdownSourceSlice(source, { from: 2, to: 4 })).toBe("开头");
		expect(getMarkdownSourceLocation(source, 2)).toEqual({ line: 1, column: 3 });
		expect(getMarkdownSourceLocation(source, 6)).toEqual({ line: 2, column: 1 });
		expect(isMarkdownCrlfInteriorOffset(source, 5)).toBe(true);
		expect(validateMarkdownSourceRange(source, { from: 0, to: 5 })).toEqual({
			valid: false,
			reason: "crlf-split",
		});
		expect(validateMarkdownSourceRange(source, { from: 5, to: 6 })).toEqual({
			valid: false,
			reason: "crlf-split",
		});
	});

	it("拒绝非整数、NaN、双向越界、空或逆序范围", () => {
		const source = "正文";
		for (const range of [
			{ from: 0.5, to: 1 },
			{ from: Number.NaN, to: 1 },
			{ from: 0, to: Number.NaN },
		]) {
			expect(validateMarkdownSourceRange(source, range)).toEqual({
				valid: false,
				reason: "non-integer",
			});
		}
		for (const range of [
			{ from: -1, to: 1 },
			{ from: 0, to: -1 },
			{ from: source.length + 1, to: source.length + 2 },
			{ from: 0, to: source.length + 1 },
		]) {
			expect(validateMarkdownSourceRange(source, range)).toEqual({
				valid: false,
				reason: "out-of-bounds",
			});
		}
		expect(validateMarkdownSourceRange(source, { from: 1, to: 1 })).toEqual({
			valid: false,
			reason: "empty-or-reversed",
		});
		expect(() => readMarkdownSourceSlice(source, { from: 2, to: 1 })).toThrow(TypeError);
	});

	it("opaque fallback 保留完整危险源码且生成定位诊断", () => {
		const source = '第一行\r\n<iframe src="javascript:alert(1)" onload="alert(2)"></iframe>\n';
		const start = source.indexOf("<iframe");
		const fallback = createMarkdownOpaqueFallback(
			source,
			{ from: start, to: source.length },
			"Unsafe raw HTML remains opaque.",
		);

		expect(fallback.node).toMatchObject({
			category: "opaque",
			kind: "opaque",
			dirty: false,
			sourceSlice: source.slice(start),
		});
		expect(fallback.diagnostic).toMatchObject({
			code: "opaque-fallback",
			severity: "warning",
			location: { line: 2, column: 1 },
		});
	});

	it("空源码与空节点构成唯一合法的空文档", () => {
		const empty = createMarkdownCodecDocument("", []);
		expect(empty.valid).toBe(true);
		expect(empty.document.diagnostics).toEqual([]);
		expect(serializeUntouchedMarkdownNodes(empty.document.nodes)).toBe("");

		const uncovered = createMarkdownCodecDocument("正文", []);
		expect(uncovered.valid).toBe(false);
		expect(uncovered.document.diagnostics).toEqual([
			expect.objectContaining({ code: "source-gap", severity: "fatal" }),
		]);
	});

	it("完整覆盖的 untouched 节点按 source slice 原样序列化", () => {
		const source = "😀 **粗体**\r\n<mark>opaque</mark>\n";
		const split = source.indexOf("<mark>");
		const nodes: readonly MarkdownCodecNode[] = [
			{
				category: "structured",
				kind: "paragraph",
				dirty: false,
				range: { from: 0, to: split },
				sourceSlice: source.slice(0, split),
			},
			createMarkdownOpaqueFallback(
				source,
				{ from: split, to: source.length },
				"Unsupported highlight remains opaque.",
			).node,
		];
		const result = createMarkdownCodecDocument(source, nodes);

		expect(result.valid).toBe(true);
		expect(result.document.sourceLength).toBe(source.length);
		expect(serializeUntouchedMarkdownNodes(result.document.nodes)).toBe(source);
	});

	it("untouched serializer 拒绝 dirty 节点并保留 canonical serializer 边界", () => {
		const dirtyNode: MarkdownCodecNode = {
			category: "structured",
			kind: "text",
			dirty: true,
			range: { from: 0, to: 1 },
			sourceSlice: "a",
		};
		expect(() => serializeUntouchedMarkdownNodes([dirtyNode])).toThrow(TypeError);
	});

	it("未排序节点明确 fatal 且 untouched serializer 不静默重排", () => {
		const source = "abcdef";
		const nodes: readonly MarkdownCodecNode[] = [
			{
				category: "structured",
				kind: "text",
				dirty: false,
				range: { from: 3, to: 6 },
				sourceSlice: "def",
			},
			{
				category: "structured",
				kind: "text",
				dirty: false,
				range: { from: 0, to: 3 },
				sourceSlice: "abc",
			},
		];
		const result = createMarkdownCodecDocument(source, nodes);

		expect(result.valid).toBe(false);
		expect(result.document.diagnostics).toEqual([
			expect.objectContaining({ code: "unsorted-source-range", severity: "fatal" }),
		]);
		expect(() => serializeUntouchedMarkdownNodes(nodes)).toThrow(TypeError);
	});

	it("文档级非法范围只报告 invalid-source-range，且不污染覆盖游标", () => {
		const source = "abcdef";
		for (const range of [
			{ from: Number.NaN, to: 1 },
			{ from: -1, to: 2 },
			{ from: 2, to: 2 },
			{ from: 4, to: 3 },
			{ from: 0, to: source.length + 1 },
		]) {
			const result = createMarkdownCodecDocument(source, [
				{
					category: "structured",
					kind: "text",
					dirty: false,
					range,
					sourceSlice: "invalid",
				},
			]);
			expect(result.valid).toBe(false);
			expect(result.document.diagnostics).toEqual([
				expect.objectContaining({ code: "invalid-source-range", severity: "fatal" }),
			]);
		}
	});

	it("范围缺口、重叠和 source slice 不匹配均 fatal 失败关闭", () => {
		const source = "abcdef";
		const nodes: readonly MarkdownCodecNode[] = [
			{
				category: "structured",
				kind: "text",
				dirty: false,
				range: { from: 0, to: 2 },
				sourceSlice: "ab",
			},
			{
				category: "structured",
				kind: "text",
				dirty: false,
				range: { from: 1, to: 3 },
				sourceSlice: "wrong",
			},
			{
				category: "structured",
				kind: "text",
				dirty: false,
				range: { from: 4, to: 6 },
				sourceSlice: "ef",
			},
		];
		const result = createMarkdownCodecDocument(source, nodes);

		expect(result.valid).toBe(false);
		expect(result.document.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining(["overlapping-source-range", "source-gap", "source-slice-mismatch"]),
		);
		expect(result.document.diagnostics.every((diagnostic) => diagnostic.severity === "fatal")).toBe(
			true,
		);
	});

	it("Callout recognizer 只识别五种真实类型并保留 source slice", () => {
		for (const fixture of FIREFLY_CALLOUT_FIXTURES) {
			const result = recognizeMarkdownCallout(fixture.source);
			expect(result.recognized).toBe(fixture.expected.recognized);
			expect(result.node.sourceSlice).toBe(fixture.source);
			if (fixture.expected.recognized) {
				expect(result.node).toMatchObject({
					category: "source-placeholder",
					kind: "callout",
					dirty: false,
					metadata: {
						type: fixture.expected.type,
						...(fixture.expected.title === undefined ? {} : { title: fixture.expected.title }),
					},
				});
				expect(result.diagnostic.code).toBe("recognized-placeholder");
			} else {
				expect(result.node).toMatchObject({ category: "opaque", kind: "opaque", dirty: false });
				expect(result.diagnostic.code).toBe("opaque-fallback");
			}
		}
	});

	it("Callout recognizer 拒绝未完整包裹的 blockquote 和 CRLF 内部切片", () => {
		const malformed = "> [!NOTE] 标题\n\n不是引用行\n";
		const result = recognizeMarkdownCallout(malformed);
		expect(result.recognized).toBe(false);
		expect(result.node.kind).toBe("opaque");

		const source = "> [!NOTE] 标题\r\n> 正文\r\n";
		expect(() => recognizeMarkdownCallout(source, { from: 0, to: source.length - 1 })).toThrow(
			TypeError,
		);
	});

	it("Callout placeholder 可经过 untouched serializer 原样往返", () => {
		for (const fixture of FIREFLY_CALLOUT_FIXTURES.filter((item) => item.expected.recognized)) {
			const result = recognizeMarkdownCallout(fixture.source);
			const document = createMarkdownCodecDocument(fixture.source, [result.node]);
			expect(document.valid).toBe(true);
			expect(serializeUntouchedMarkdownNodes(document.document.nodes)).toBe(fixture.source);
		}
	});

	it("Details recognizer 严格匹配 fixtures 的 structured 与 opaque 判定", () => {
		for (const fixture of FIREFLY_DETAILS_FIXTURES) {
			const result = recognizeMarkdownDetails(fixture.source);
			const shouldRecognize = fixture.expected.disposition === "structured";
			expect(result.recognized).toBe(shouldRecognize);
			expect(result.node.sourceSlice).toBe(fixture.source);
			if (shouldRecognize) {
				expect(result.node).toMatchObject({
					category: "source-placeholder",
					kind: "details",
					dirty: false,
					metadata: {
						bodyMarkdown: fixture.expected.bodyMarkdown,
						open: fixture.expected.open,
						summary: fixture.expected.summary,
					},
				});
				expect(result.diagnostic.code).toBe("recognized-placeholder");
			} else {
				expect(result.node).toMatchObject({ category: "opaque", kind: "opaque", dirty: false });
				expect(result.diagnostic.code).toBe("opaque-fallback");
			}
		}
	});

	it("Details recognizer 接受 CRLF 但保留原始 source slice 与 UTF-16 range", () => {
		const source =
			"前缀😀\r\n<details open>\r\n<summary>标题 **字面量**</summary>\r\n\r\n正文\r\n</details>\r\n后缀";
		const from = source.indexOf("<details");
		const to = source.indexOf("后缀");
		const result = recognizeMarkdownDetails(source, { from, to });
		expect(result.recognized).toBe(true);
		expect(result.node).toMatchObject({
			kind: "details",
			range: { from, to },
			sourceSlice: source.slice(from, to),
			metadata: {
				bodyMarkdown: "正文\n",
				open: true,
				summary: "标题 **字面量**",
			},
		});
	});

	it("Details recognizer 对嵌套原始 HTML、重复 summary 和歧义边界失败关闭", () => {
		for (const source of [
			"<details>\n<summary>标题</summary>\n\n正文 <span>HTML</span>\n</details>\n",
			"<details>\n<summary>一</summary>\n\n<summary>二</summary>\n</details>\n",
			"<details>\n<summary>标题</summary>\n\n正文\n</details>\n尾部",
		]) {
			const result = recognizeMarkdownDetails(source);
			expect(result.recognized).toBe(false);
			expect(result.node.kind).toBe("opaque");
		}
	});

	it("Details placeholder 可经过 untouched serializer 原样往返", () => {
		for (const fixture of FIREFLY_DETAILS_FIXTURES.filter(
			(item) => item.expected.disposition === "structured",
		)) {
			const result = recognizeMarkdownDetails(fixture.source);
			const document = createMarkdownCodecDocument(fixture.source, [result.node]);
			expect(document.valid).toBe(true);
			expect(serializeUntouchedMarkdownNodes(document.document.nodes)).toBe(fixture.source);
		}
	});

	it("全部真实语法 fixture source 在 recognizer 前通过 opaque 保真 smoke test", () => {
		const expectedSourceCount =
			FIREFLY_CALLOUT_FIXTURES.length +
			FIREFLY_DETAILS_FIXTURES.length +
			FIREFLY_MATH_FIXTURES.length +
			FIREFLY_MERMAID_FIXTURES.length +
			FIREFLY_VIDEO_FIXTURES.length +
			FIREFLY_INLINE_STYLE_FIXTURES.length;
		expect(ALL_REAL_SYNTAX_SOURCES).toHaveLength(expectedSourceCount);
		expect(ALL_REAL_SYNTAX_SOURCES.length).toBeGreaterThan(70);
		for (const source of ALL_REAL_SYNTAX_SOURCES) {
			const result = createOpaqueDocument(source);
			expect(result.valid).toBe(true);
			expect(result.document.nodes).toHaveLength(1);
			expect(serializeUntouchedMarkdownNodes(result.document.nodes)).toBe(source);
		}
	});
});
