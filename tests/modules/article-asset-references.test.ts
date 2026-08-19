import { describe, expect, it } from "vitest";
import {
	analyzeArticleAssetReferences,
	analyzeArticleAssetReferencesWithRanges,
} from "../../src/modules/media/article-asset-references";

function analyze(markdown: string, frontmatterImage = "") {
	return analyzeArticleAssetReferences({
		storageSlug: "hello-world",
		frontmatterImage,
		markdown,
	});
}

describe("文章资源引用分析", () => {
	it("识别 Frontmatter 图片、Markdown 图片和附件链接", () => {
		const result = analyze("开头\n![封面](./cover.webp)\n[下载附件](./guide.pdf)\n", "./hero.png");

		expect(result.complete).toBe(true);
		expect(result.references).toEqual([
			{
				storageSlug: "hello-world",
				source: "frontmatter-image",
				originalReference: "./hero.png",
				target: "./hero.png",
				targetStorageSlug: "hello-world",
				targetFilename: "hero.png",
				line: null,
				column: null,
			},
			{
				storageSlug: "hello-world",
				source: "markdown-image",
				originalReference: "![封面](./cover.webp)",
				target: "./cover.webp",
				targetStorageSlug: "hello-world",
				targetFilename: "cover.webp",
				line: 2,
				column: 1,
			},
			{
				storageSlug: "hello-world",
				source: "markdown-link",
				originalReference: "[下载附件](./guide.pdf)",
				target: "./guide.pdf",
				targetStorageSlug: "hello-world",
				targetFilename: "guide.pdf",
				line: 3,
				column: 1,
			},
		]);
	});

	it("识别同级受控 Page Bundle 的图片、附件和 Frontmatter 引用", () => {
		const result = analyze(
			"![跨文章图片](../source-post/cover.png)\n[跨文章附件](../source-post/guide.pdf)",
			"../source-post/hero.webp",
		);

		expect(result).toMatchObject({ complete: true, issues: [] });
		expect(result.references).toEqual([
			expect.objectContaining({
				source: "frontmatter-image",
				target: "../source-post/hero.webp",
				targetStorageSlug: "source-post",
				targetFilename: "hero.webp",
			}),
			expect.objectContaining({
				source: "markdown-image",
				target: "../source-post/cover.png",
				targetStorageSlug: "source-post",
				targetFilename: "cover.png",
			}),
			expect.objectContaining({
				source: "markdown-link",
				target: "../source-post/guide.pdf",
				targetStorageSlug: "source-post",
				targetFilename: "guide.pdf",
			}),
		]);
	});

	it("不把围栏代码、缩进代码、行内代码和普通文本误判为引用", () => {
		const result = analyze(
			[
				"普通文本 ./cover.webp",
				"`![行内](./inline.png)`",
				"    [缩进代码](./indented.pdf)",
				"~~~md",
				"![围栏](./fenced.png)",
				"~~~",
				"[真实附件](./real.pdf)",
			].join("\n"),
		);

		expect(result).toMatchObject({ complete: true, issues: [] });
		expect(result.references).toEqual([
			expect.objectContaining({ source: "markdown-link", target: "./real.pdf", line: 7 }),
		]);
	});

	it("忽略外部、站内和锚点链接", () => {
		const result = analyze(
			"![远端](https://images.example/cover.webp)\n[站内](/posts/demo)\n[段落](#title)",
			"https://images.example/hero.webp",
		);
		expect(result).toEqual({ complete: true, references: [], issues: [] });
	});

	it("拒绝把无效本地路径记录为可操作引用", () => {
		const result = analyze("![子目录](./images/cover.webp)\n[入口](./index.md)", "./index.md");

		expect(result.complete).toBe(false);
		expect(result.references).toEqual([]);
		expect(result.issues).toEqual([
			{ code: "invalid-local-reference", line: null, column: null },
			{ code: "invalid-local-reference", line: 1, column: 1 },
			{ code: "invalid-local-reference", line: 2, column: 1 },
		]);
	});

	it("对引用式链接和 HTML 本地属性标记分析不完整", () => {
		const result = analyze(
			"[下载][guide]\n[guide]: ./guide.pdf\n<img src=\"../source-post/cover.png\">\n<a href='./other.pdf'>附件</a>",
		);

		expect(result.references).toEqual([]);
		expect(result.complete).toBe(false);
		expect(result.issues).toEqual([
			{ code: "unsupported-local-reference-syntax", line: 2, column: 1 },
			{ code: "unsupported-local-reference-syntax", line: 3, column: 6 },
			{ code: "unsupported-local-reference-syntax", line: 4, column: 4 },
		]);
	});

	it("非法跨 Bundle 路径失败关闭且不记录为可操作引用", () => {
		const result = analyze(
			"![逃逸](../../secret/cover.png)\n![子目录](../source-post/images/cover.png)\n![自引用](../hello-world/cover.png)",
			"../hello-world/hero.png",
		);
		expect(result.references).toEqual([]);
		expect(result.complete).toBe(false);
		expect(result.issues).toEqual([
			{ code: "invalid-local-reference", line: null, column: null },
			{ code: "invalid-local-reference", line: 1, column: 1 },
			{ code: "invalid-local-reference", line: 2, column: 1 },
			{ code: "invalid-local-reference", line: 3, column: 1 },
		]);
	});

	it("不分析转义的 Markdown 标记", () => {
		const result = analyze("\\![示例](./cover.png)\n\\[示例](./guide.pdf)");
		expect(result).toEqual({ complete: true, references: [], issues: [] });
	});

	it("未闭合行内代码失败关闭且不把其余内容当成引用", () => {
		const result = analyze("开头 `未闭合 ![图片](./cover.png)");
		expect(result).toEqual({
			complete: false,
			references: [],
			issues: [{ code: "ambiguous-inline-code", line: null, column: null }],
		});
	});

	it("在 astral 字符和 CRLF 下保持 UTF-16 目标范围精确", () => {
		const markdown =
			"😀 开头\r\n![😀 封面](  ./cover.webp  ) 和 [附件](./guide.pdf)\r\n`😀 [忽略](./inline.pdf)`";
		const result = analyzeArticleAssetReferencesWithRanges({
			storageSlug: "hello-world",
			frontmatterImage: "",
			markdown,
		});

		expect(result).toMatchObject({ complete: true, issues: [] });
		expect(result.references).toHaveLength(2);
		expect(result.references.map((reference) => reference.target)).toEqual([
			"./cover.webp",
			"./guide.pdf",
		]);
		for (const reference of result.references) {
			expect(reference.targetRange).not.toBeNull();
			const range = reference.targetRange;
			if (range === null) throw new TypeError("Markdown 引用必须提供目标范围。");
			expect(markdown.slice(range.start, range.end)).toBe(reference.targetInput);
		}
		expect(result.references[0]).toMatchObject({ line: 2, column: 1 });
		expect(result.references[1]).toMatchObject({ line: 2, column: 30 });
	});

	it("代码区内 astral 字符不会扰动后续同一行多引用范围", () => {
		const markdown = [
			"```md",
			"😀 ![忽略](./ignored.png)",
			"```",
			"😀 [一](./one.pdf) 与 ![二](./two.png)",
		].join("\n");
		const result = analyzeArticleAssetReferencesWithRanges({
			storageSlug: "hello-world",
			frontmatterImage: "",
			markdown,
		});

		expect(result).toMatchObject({ complete: true, issues: [] });
		expect(result.references.map((reference) => reference.targetInput)).toEqual([
			"./one.pdf",
			"./two.png",
		]);
		for (const reference of result.references) {
			const range = reference.targetRange;
			if (range === null) throw new TypeError("Markdown 引用必须提供目标范围。");
			expect(markdown.slice(range.start, range.end)).toBe(reference.targetInput);
		}
	});

	it("拒绝额外输入字段和超长正文", () => {
		expect(() =>
			analyzeArticleAssetReferences({
				storageSlug: "hello-world",
				frontmatterImage: "",
				markdown: "",
				repositoryPath: "README.md",
			}),
		).toThrow();
		expect(() => analyze("a".repeat(1_000_001))).toThrow();
	});
});
