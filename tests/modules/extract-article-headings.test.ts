import { describe, expect, it } from "vitest";
import { extractArticleHeadings } from "../../src/modules/articles/services/extract-article-headings";

describe("文章标题锚点提取", () => {
	it("返回 H1-H6，并按全文顺序使用主站有状态 Slugger", () => {
		expect(
			extractArticleHeadings(
				"# Hello World\n\n## Hello World\n\n### Hello World\n\n###### 中文 标题",
			),
		).toEqual([
			{ depth: 1, text: "Hello World", id: "hello-world" },
			{ depth: 2, text: "Hello World", id: "hello-world-1" },
			{ depth: 3, text: "Hello World", id: "hello-world-2" },
			{ depth: 6, text: "中文 标题", id: "中文-标题" },
		]);
	});

	it("保留标题中的可见内联文本", () => {
		expect(extractArticleHeadings("## **粗体** 与 `代码` [链接](https://example.com)")).toEqual([
			{ depth: 2, text: "粗体 与 代码 链接", id: "粗体-与-代码-链接" },
		]);
	});

	it("使用 GitHub Slugger 的标点和重复序号语义", () => {
		expect(extractArticleHeadings("## Hello, World!\n\n## hello-world\n\n## C++ & C#")).toEqual([
			{ depth: 2, text: "Hello, World!", id: "hello-world" },
			{ depth: 2, text: "hello-world", id: "hello-world-1" },
			{ depth: 2, text: "C++ & C#", id: "c--c" },
		]);
	});

	it("处理标题本身带序号时的占位碰撞，避免生成重复 hash", () => {
		expect(extractArticleHeadings("## foo\n\n## foo-1\n\n## foo\n\n## foo")).toEqual([
			{ depth: 2, text: "foo", id: "foo" },
			{ depth: 2, text: "foo-1", id: "foo-1" },
			{ depth: 2, text: "foo", id: "foo-2" },
			{ depth: 2, text: "foo", id: "foo-3" },
		]);
	});

	it("限制标题数量和字段长度以匹配浏览器响应边界", () => {
		const longHeading = "长".repeat(490);
		const markdown = Array.from({ length: 510 }, () => `## ${longHeading}`).join("\n\n");
		const headings = extractArticleHeadings(markdown);

		expect(headings).toHaveLength(500);
		expect(headings[0]?.text).toHaveLength(490);
		expect(headings[0]?.id).toHaveLength(490);
		expect(headings[1]?.id).toHaveLength(492);
		expect(headings[1]?.id.endsWith("-1")).toBe(true);
	});
});
