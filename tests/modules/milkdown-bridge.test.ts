import { describe, expect, it } from "vitest";
import {
	flushBridgeNodeViewMetadata,
	flushBridgeProjection,
	flushMilkdownMarkdown,
	projectCodecToMilkdownMarkdown,
} from "../../src/modules/editor-core/adapters/milkdown/bridge";
import { transformFireflySourceAst } from "../../src/modules/editor-core/adapters/milkdown/firefly-source-node";

describe("隔离 Milkdown bridge source transaction", () => {
	it("消费 editor-core projection 并保留原始 source metadata", () => {
		const source = "普通正文\n\n$E=mc^2$\n\n<div>opaque</div>";
		const projection = projectCodecToMilkdownMarkdown(source);

		expect(projection.source).toBe(source);
		expect(projection.visualProjection.source).toBe(source);
		expect(projection.visualProjection.nodes.some((node) => node.category === "placeholder")).toBe(
			true,
		);
		expect(projection.visualProjection.nodes.some((node) => node.category === "opaque")).toBe(true);
		expect(projection.markdown).toBe(source);
		expect(projection.markdown).not.toContain("Firefly Opaque");
	});

	it("把 codec source range 转成受控 AST 节点，而不是 fenced synthetic Markdown", () => {
		const source = "正文\n\n<div>opaque</div>";
		const projection = projectCodecToMilkdownMarkdown(source);
		const root = {
			type: "root" as const,
			children: [
				{ type: "paragraph", position: { start: { offset: 0 }, end: { offset: 2 } } },
				{ type: "html", position: { start: { offset: 4 }, end: { offset: source.length } } },
			],
		};

		transformFireflySourceAst(root, projection.visualProjection);

		expect(root.children[1]?.type).toBe("fireflySourceBlock");
		expect((root.children[1] as { data?: Record<string, unknown> }).data).toMatchObject({
			sourceRangeFrom: 4,
			sourceRangeTo: source.length,
			sourceSlice: "<div>opaque</div>",
			category: "opaque",
			editable: false,
		});
	});

	it("只把 structured 节点编辑回写到原始 Markdown", () => {
		const original = projectCodecToMilkdownMarkdown("普通正文\n\n$E=mc^2$\n\n<div>opaque</div>");
		const editedVisualProjection = {
			...original.visualProjection,
			nodes: original.visualProjection.nodes.map((node, index) =>
				index === 0 && node.category === "structured"
					? { ...node, sourceSlice: "修改后的正文" }
					: node,
			),
		};
		const edited = { ...original, visualProjection: editedVisualProjection };
		const flushed = flushBridgeProjection(original, edited);

		expect(flushed.source).toContain("修改后的正文");
		expect(flushed.source).toContain("$E=mc^2$");
		expect(flushed.source).toContain("<div>opaque</div>");
	});

	it("拒绝通过 bridge 修改 placeholder 或 opaque source slice", () => {
		const original = projectCodecToMilkdownMarkdown("正文\n\n<div>opaque</div>");
		const editedVisualProjection = {
			...original.visualProjection,
			nodes: original.visualProjection.nodes.map((node) =>
				node.category === "opaque" ? { ...node, sourceSlice: "篡改" } : node,
			),
		};

		expect(() =>
			flushBridgeProjection(original, { ...original, visualProjection: editedVisualProjection }),
		).toThrow("read-only");
	});

	it("校验真实 NodeView attrs 后仍返回原始 source", () => {
		const source = "正文\n\n<div>opaque</div>";
		const original = projectCodecToMilkdownMarkdown(source);
		const node = original.visualProjection.nodes.find((item) => item.category === "opaque");
		if (node?.category !== "opaque") throw new Error("opaque fixture missing");
		const flushed = flushBridgeNodeViewMetadata(original, [
			{
				sourceRangeFrom: node.sourceRange.from,
				sourceRangeTo: node.sourceRange.to,
				sourceSlice: node.sourceSlice,
				category: "opaque",
				kind: "opaque",
				editable: false,
			},
		]);
		expect(flushed.source).toBe(source);
	});

	it("把 Milkdown serializer 的普通结构化 Markdown 回写为新的 source projection", () => {
		const original = projectCodecToMilkdownMarkdown("# 原标题\n\n普通正文\n\n<div>opaque</div>");
		const flushed = flushMilkdownMarkdown(
			original,
			"# 新标题\n\n修改后的正文\n\n<div>opaque</div>",
		);

		expect(flushed.source).toBe("# 新标题\n\n修改后的正文\n\n<div>opaque</div>");
		expect(flushed.visualProjection.nodes.some((node) => node.category === "opaque")).toBe(true);
	});

	it("拒绝 Milkdown serializer 删除或篡改受保护 source slice", () => {
		const original = projectCodecToMilkdownMarkdown("正文\n\n<div>opaque</div>");

		expect(() => flushMilkdownMarkdown(original, "正文")).toThrow("protected source slice");
		expect(() => flushMilkdownMarkdown(original, "正文\n\n<div>tampered</div>")).toThrow(
			"protected source slice",
		);
	});

	it("生产 bridge 保持普通 Markdown 可编辑且特殊源码只读", () => {
		const original = projectCodecToMilkdownMarkdown(
			"# 标题\n\n普通正文\n\n<div>opaque</div>\n\n> [!NOTE] 提示\n> 内容",
		);
		const serialized = flushMilkdownMarkdown(
			original,
			"# 新标题\n\n更新正文\n\n<div>opaque</div>\n\n> [!NOTE] 提示\n> 内容",
		);
		expect(serialized.source).toContain("# 新标题");
		expect(serialized.source).toContain("更新正文");
		expect(serialized.source).toContain("<div>opaque</div>");
		expect(serialized.source).toContain("> [!NOTE] 提示");
	});

	it("覆盖列表和链接编辑，同时保留受保护源码", () => {
		const original = projectCodecToMilkdownMarkdown(
			"# 清单\n\n- 第一项\n- 第二项 [旧链接](https://example.com/old)\n\n<div>opaque</div>",
		);
		const flushed = flushMilkdownMarkdown(
			original,
			"# 更新清单\n\n- 第二项 [新链接](https://example.com/new)\n- 新增项目\n\n<div>opaque</div>",
		);

		expect(flushed.source).toContain("[新链接](https://example.com/new)");
		expect(flushed.source).not.toContain("第一项");
		expect(flushed.source).toContain("<div>opaque</div>");
	});

	it("允许结构化块增删和重排，但不允许新增受保护源码", () => {
		const original = projectCodecToMilkdownMarkdown("第一段\n\n<div>opaque</div>\n\n第二段");
		const reordered = flushMilkdownMarkdown(
			original,
			"新增段落\n\n第二段\n\n<div>opaque</div>\n\n第一段",
		);

		expect(reordered.source).toBe("新增段落\n\n第二段\n\n<div>opaque</div>\n\n第一段");
		expect(() =>
			flushMilkdownMarkdown(original, '第一段\n\n<div>opaque</div>\n\n<iframe src="x"></iframe>'),
		).toThrow("protected source slice");
	});
});
