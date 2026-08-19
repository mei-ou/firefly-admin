import { describe, expect, it } from "vitest";
import {
	articleEditorInputSchema,
	articleFrontmatterSchema,
	parseArticleEditorInput,
} from "../../src/modules/articles/article-schema";

const minimalFrontmatter = {
	title: "第一篇文章",
	published: "2026-08-12T00:00:00.000Z",
};

describe("文章 Frontmatter 数据边界", () => {
	it("只用 title 和 published 构造 Firefly 兼容默认值", () => {
		const result = articleFrontmatterSchema.parse(minimalFrontmatter);

		expect(result).toMatchObject({
			title: "第一篇文章",
			draft: true,
			description: "",
			image: "",
			tags: [],
			category: null,
			lang: "zh_CN",
			pinned: false,
			comment: true,
			password: "",
			passwordHint: "",
		});
		expect(result.published).toBeInstanceOf(Date);
	});

	it("接受完整且合法的可写 Frontmatter", () => {
		const result = articleFrontmatterSchema.parse({
			...minimalFrontmatter,
			updated: "2026-08-12T01:00:00.000Z",
			draft: false,
			description: "摘要",
			image: "https://images.example.com/cover.webp",
			tags: ["Astro", "Cloudflare"],
			category: "开发",
			lang: "zh_CN",
			pinned: true,
			author: "Firefly",
			sourceLink: "https://example.com/source",
			licenseName: "CC BY-NC-SA 4.0",
			licenseUrl: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
			comment: false,
			password: "article-password",
			passwordHint: "提示",
		});

		expect(result.updated).toBeInstanceOf(Date);
		expect(result.tags).toEqual(["Astro", "Cloudflare"]);
		expect(result.category).toBe("开发");
	});

	it("封面接受 HTTPS 或当前 Page Bundle 的直接子文件", () => {
		expect(
			articleFrontmatterSchema.parse({ ...minimalFrontmatter, image: "./cover.webp" }).image,
		).toBe("./cover.webp");
		for (const image of [
			"../cover.webp",
			"./images/cover.webp",
			"./a%2Fb.webp",
			"./index.md",
			"./guide.pdf",
			"http://example.com/cover.webp",
			"https://example.com/cover.webp?token=secret",
			"https://example.com:8443/cover.webp",
		]) {
			expect(
				articleFrontmatterSchema.safeParse({ ...minimalFrontmatter, image }).success,
				image,
			).toBe(false);
		}
	});

	it("拒绝缺失真正必填字段", () => {
		expect(articleFrontmatterSchema.safeParse({ published: new Date() }).success).toBe(false);
		expect(articleFrontmatterSchema.safeParse({ title: "缺日期" }).success).toBe(false);
	});

	it("拒绝无效日期", () => {
		expect(
			articleFrontmatterSchema.safeParse({ ...minimalFrontmatter, published: "not-a-date" })
				.success,
		).toBe(false);
	});

	it("明确拒绝 Firefly 构建内部导航字段", () => {
		for (const field of ["prevTitle", "prevSlug", "nextTitle", "nextSlug"]) {
			const result = articleFrontmatterSchema.safeParse({
				...minimalFrontmatter,
				[field]: "forbidden",
			});
			expect(result.success, field).toBe(false);
		}
	});

	it("拒绝其他未知字段而不是静默剥离", () => {
		expect(
			articleFrontmatterSchema.safeParse({ ...minimalFrontmatter, repositoryPath: "../../x" })
				.success,
		).toBe(false);
	});

	it("限制标签数量和单个标签长度", () => {
		expect(
			articleFrontmatterSchema.safeParse({
				...minimalFrontmatter,
				tags: Array.from({ length: 31 }, (_, index) => `tag-${index}`),
			}).success,
		).toBe(false);
		expect(
			articleFrontmatterSchema.safeParse({
				...minimalFrontmatter,
				tags: ["x".repeat(51)],
			}).success,
		).toBe(false);
	});

	it("拒绝 Frontmatter 控制字符", () => {
		for (const title of ["标题\u0000注入", "标题\t注入", "标题\n注入"]) {
			expect(articleFrontmatterSchema.safeParse({ ...minimalFrontmatter, title }).success).toBe(
				false,
			);
		}
	});
});

describe("文章编辑输入边界", () => {
	it("默认使用 Markdown 格式", () => {
		const result = parseArticleEditorInput({
			frontmatter: minimalFrontmatter,
			markdown: "# 正文",
		});
		expect(result.format).toBe("md");
	});

	it("拒绝 MDX 和任意文件扩展名", () => {
		for (const format of ["mdx", "html", "../index.md"]) {
			expect(
				articleEditorInputSchema.safeParse({
					frontmatter: minimalFrontmatter,
					format,
					markdown: "# 正文",
				}).success,
			).toBe(false);
		}
	});

	it("拒绝客户端附带完整仓库路径", () => {
		expect(
			articleEditorInputSchema.safeParse({
				frontmatter: minimalFrontmatter,
				markdown: "# 正文",
				path: "src/content/posts/unsafe/index.md",
			}).success,
		).toBe(false);
	});

	it("限制正文体积避免单次请求消耗过多内存", () => {
		expect(
			articleEditorInputSchema.safeParse({
				frontmatter: minimalFrontmatter,
				markdown: "x".repeat(1_000_001),
			}).success,
		).toBe(false);
	});
});

describe("server-side URL safety", () => {
	it("rejects unsafe or credential-bearing URL values", () => {
		for (const field of ["image", "sourceLink", "licenseUrl"]) {
			for (const value of [
				"javascript:alert(1)",
				"http://example.com",
				"https://user:pass@example.com/a",
			]) {
				expect(
					articleFrontmatterSchema.safeParse({ ...minimalFrontmatter, [field]: value }).success,
				).toBe(false);
			}
		}
	});
});
