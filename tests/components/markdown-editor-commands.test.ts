import { describe, expect, it } from "vitest";
import {
	createBlockMarkdownReplacement,
	createInlineMarkdownReplacement,
	createMarkdownImage,
	createMarkdownLink,
} from "../../src/components/articles/editor-commands";

describe("Markdown 编辑器命令", () => {
	it("包裹选区并保留内部选中范围", () => {
		const result = createInlineMarkdownReplacement("bold", { from: 2, to: 4, text: "文字" });
		expect(result).toEqual({ text: "**文字**", selectionFrom: 2, selectionTo: 4 });
	});

	it("不提供没有 Firefly canonical 语法的样式命令", () => {
		const supported = ["bold", "italic", "strikethrough", "inline-code"] as const;
		for (const command of supported) {
			expect(
				createInlineMarkdownReplacement(command, { from: 0, to: 0, text: "" }).text,
			).not.toContain("style=");
		}
	});

	it("生成列表、表格和代码块模板", () => {
		expect(
			createBlockMarkdownReplacement("ordered-list", { from: 0, to: 3, text: "一\n二" }).text,
		).toBe("1. 一\n2. 二");
		expect(createBlockMarkdownReplacement("table", { from: 0, to: 0, text: "" }).text).toContain(
			"| --- | --- |",
		);
		expect(
			createBlockMarkdownReplacement("code-block", { from: 0, to: 2, text: "代码" }).text,
		).toBe("```\n代码\n```");
	});

	it("生成 H1 到 H6 标题模板", () => {
		for (const level of [1, 2, 3, 4, 5, 6] as const) {
			expect(
				createBlockMarkdownReplacement(`heading-${level}`, { from: 0, to: 0, text: "标题" }).text,
			).toBe(`${"#".repeat(level)} 标题`);
		}
	});

	it("安全转义链接和图片的标签、标题及目标", () => {
		expect(createMarkdownLink({ text: "[文章]", href: "/posts/a b", title: '说"明' })).toBe(
			'[\\[文章\\]](/posts/a%20b "说\\"明")',
		);
		expect(createMarkdownImage({ alt: "封面", src: "./cover image.webp" })).toBe(
			"![封面](./cover%20image.webp)",
		);
	});
});
