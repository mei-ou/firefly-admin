import { describe, expect, it } from "vitest";
import type { MediaTransactionReferenceImpact } from "../../src/modules/media/media-transaction-preview";
import {
	rewriteMediaTransactionReferences,
	rewriteRenameMediaReferences,
} from "../../src/modules/media/media-transaction-rewriter";

function buildArticle(
	imageLine: string,
	markdown: string,
	newline: "\n" | "\r\n" = "\n",
	bom = "",
): string {
	return `${bom}${[
		"---",
		"# 保留注释",
		"title: 测试文章",
		"published: 2026-08-17T00:00:00.000Z",
		"draft: true",
		'description: ""',
		imageLine,
		"",
		"tags: []",
		"category: null",
		"lang: zh_CN",
		"pinned: false",
		'author: ""',
		'sourceLink: ""',
		'licenseName: ""',
		'licenseUrl: ""',
		"comment: true",
		'password: ""',
		'passwordHint: ""',
		"---",
	].join(newline)}${newline}${markdown}`;
}

function impact(
	source: MediaTransactionReferenceImpact["source"],
	originalReference: string,
	line: number | null,
	column: number | null,
	currentTarget = "./old.png",
	proposedTarget = "./renamed-cover.webp",
): MediaTransactionReferenceImpact {
	return {
		source,
		originalReference,
		currentTarget,
		proposedTarget,
		line,
		column,
	};
}

describe("资源 rename 无损引用改写", () => {
	it.each([
		["plain", "image: ./old.png", "image: ./renamed-cover.webp"],
		["single", "image: './old.png'", "image: './renamed-cover.webp'"],
		["double", 'image: "./old.png"', 'image: "./renamed-cover.webp"'],
	])("保留 %s Frontmatter image 风格和其余原文", (_style, imageLine, expectedLine) => {
		const source = buildArticle(imageLine, "正文  \n");
		const result = rewriteRenameMediaReferences({
			source,
			storageSlug: "hello-world",
			currentTarget: "./old.png",
			proposedTarget: "./renamed-cover.webp",
			expectedReferences: [impact("frontmatter-image", "./old.png", null, null)],
		});

		expect(result.content).toBe(source.replace(imageLine, expectedLine));
		expect(result.replacements).toEqual([
			expect.objectContaining({
				source: "frontmatter-image",
				before: "./old.png",
				after: "./renamed-cover.webp",
			}),
		]);
	});

	it("在 BOM、CRLF、emoji 和同一行多引用下只改写目标范围", () => {
		const markdown = "😀 ![旧图](  ./old.png  ) 与 [下载](./old.png)  \r\n结尾\r\n";
		const source = buildArticle('image: ""', markdown, "\r\n", "\uFEFF");
		const result = rewriteRenameMediaReferences({
			source,
			storageSlug: "hello-world",
			currentTarget: "./old.png",
			proposedTarget: "./renamed-cover.webp",
			expectedReferences: [
				impact("markdown-image", "![旧图](  ./old.png  )", 1, 4),
				impact("markdown-link", "[下载](./old.png)", 1, 27),
			],
		});

		expect(result.content).toBe(
			source
				.replace("![旧图](  ./old.png  )", "![旧图](  ./renamed-cover.webp  )")
				.replace("[下载](./old.png)", "[下载](./renamed-cover.webp)"),
		);
		expect(result.content.startsWith("\uFEFF---\r\n")).toBe(true);
		expect(result.content.endsWith("  \r\n结尾\r\n")).toBe(true);
	});

	it("零引用时全文逐单元保持不变且代码区同名文本不改", () => {
		const source = buildArticle('image: ""', "```md\n![示例](./old.png)\n```\n正文");
		const result = rewriteRenameMediaReferences({
			source,
			storageSlug: "hello-world",
			currentTarget: "./old.png",
			proposedTarget: "./renamed-cover.webp",
			expectedReferences: [],
		});
		expect(result).toEqual({ content: source, replacements: [] });
	});

	it("保留混合换行和无结尾换行", () => {
		const source = buildArticle('image: ""', "[附件](./old.png)\r\n下一行", "\n").replace(
			"# 保留注释\n",
			"# 保留注释\r\n",
		);
		const result = rewriteRenameMediaReferences({
			source,
			storageSlug: "hello-world",
			currentTarget: "./old.png",
			proposedTarget: "./renamed-cover.webp",
			expectedReferences: [impact("markdown-link", "[附件](./old.png)", 1, 1)],
		});
		expect(result.content).toBe(
			source.replace("[附件](./old.png)", "[附件](./renamed-cover.webp)"),
		);
		expect(result.content.endsWith("下一行")).toBe(true);
	});

	it.each(["image: |\n  ./old.png", "image: &cover ./old.png", "image: !custom ./old.png"])(
		"复杂 Frontmatter image 失败关闭：%s",
		(imageLine) => {
			const source = buildArticle(imageLine, "正文\n");
			expect(() =>
				rewriteRenameMediaReferences({
					source,
					storageSlug: "hello-world",
					currentTarget: "./old.png",
					proposedTarget: "./renamed-cover.webp",
					expectedReferences: [impact("frontmatter-image", "./old.png", null, null)],
				}),
			).toThrow();
		},
	);

	it("expectedReferences 漂移时失败关闭", () => {
		const source = buildArticle('image: ""', "![旧图](./old.png)\n");
		expect(() =>
			rewriteRenameMediaReferences({
				source,
				storageSlug: "hello-world",
				currentTarget: "./old.png",
				proposedTarget: "./renamed-cover.webp",
				expectedReferences: [impact("markdown-link", "![旧图](./old.png)", 1, 1)],
			}),
		).toThrow("expectedReferences");
	});

	it("不支持的本地引用语法失败关闭", () => {
		const source = buildArticle('image: ""', "[下载][old]\n[old]: ./old.png\n");
		expect(() =>
			rewriteRenameMediaReferences({
				source,
				storageSlug: "hello-world",
				currentTarget: "./old.png",
				proposedTarget: "./renamed-cover.webp",
				expectedReferences: [],
			}),
		).toThrow("引用分析不完整");
	});

	it("move source 跨 Bundle 改写保留 emoji、CRLF 和非目标文本", () => {
		const markdown = "😀 ![源](  ./old.png  ) 与 [同名远端](../other/old.png)  \r\n结尾\r\n";
		const source = buildArticle("image: ./old.png", markdown, "\r\n", "\uFEFF");
		const result = rewriteMediaTransactionReferences({
			source,
			storageSlug: "source",
			currentTarget: "./old.png",
			proposedTarget: "../destination/new.png",
			expectedReferences: [
				impact("frontmatter-image", "./old.png", null, null, "./old.png", "../destination/new.png"),
				impact(
					"markdown-image",
					"![源](  ./old.png  )",
					1,
					4,
					"./old.png",
					"../destination/new.png",
				),
			],
		});
		expect(result.content).toBe(
			source
				.replace("image: ./old.png", "image: ../destination/new.png")
				.replace("![源](  ./old.png  )", "![源](  ../destination/new.png  )"),
		);
		expect(result.content).toContain("[同名远端](../other/old.png)");
		expect(result.content.startsWith("\uFEFF---\r\n")).toBe(true);
		expect(result.content.endsWith("  \r\n结尾\r\n")).toBe(true);
	});

	it("move destination 将跨 Bundle 引用改为本地且保持原始格式", () => {
		const source = buildArticle(
			"image: '../source/old.png'",
			"[资源](  ../source/old.png  ) 和 `../source/old.png`\n",
		);
		const result = rewriteMediaTransactionReferences({
			source,
			storageSlug: "destination",
			currentTarget: "../source/old.png",
			proposedTarget: "./new.png",
			expectedReferences: [
				impact(
					"frontmatter-image",
					"../source/old.png",
					null,
					null,
					"../source/old.png",
					"./new.png",
				),
				impact(
					"markdown-link",
					"[资源](  ../source/old.png  )",
					1,
					1,
					"../source/old.png",
					"./new.png",
				),
			],
		});
		expect(result.content).toBe(
			source
				.replace("image: '../source/old.png'", "image: './new.png'")
				.replace("[资源](  ../source/old.png  )", "[资源](  ./new.png  )"),
		);
		expect(result.content).toContain("`../source/old.png`");
	});

	it.each([
		"../../source/old.png",
		"../destination/../source/old.png",
		"../source/old.png?raw=1",
		"../source%2Fold.png",
		"..\\source\\old.png",
	])("非法 controlled path 失败关闭：%s", (currentTarget) => {
		const source = buildArticle('image: ""', "正文\n");
		expect(() =>
			rewriteMediaTransactionReferences({
				source,
				storageSlug: "destination",
				currentTarget,
				proposedTarget: "./new.png",
				expectedReferences: [],
			}),
		).toThrow();
	});
});
