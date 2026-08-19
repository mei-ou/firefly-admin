import { describe, expect, it } from "vitest";
import {
	buildArticlePath,
	buildArticleResourcePath,
	buildControlledArticleResourceReference,
	getArticleResourceFilenameConflictKey,
	parseArticleResourceFilename,
	parseArticleResourceReference,
	parseControlledArticleResourceReference,
} from "../../src/core/security/path-policy";

const validConfig = {
	contentRoot: "src/content/posts",
	usePageBundle: true,
	entryFilename: "index.md",
};

describe("文章仓库路径策略", () => {
	it("构造唯一允许的 Page Bundle Markdown 路径", () => {
		expect(buildArticlePath("firefly-admin")).toBe("src/content/posts/firefly-admin/index.md");
	});

	it("允许经过校验的自定义内容根目录", () => {
		expect(
			buildArticlePath("hello-world", {
				...validConfig,
				contentRoot: "content/blog-posts",
			}),
		).toBe("content/blog-posts/hello-world/index.md");
	});

	it("拒绝关闭 Page Bundle 后退化为任意文件模式", () => {
		expect(() => buildArticlePath("hello", { ...validConfig, usePageBundle: false })).toThrow(
			"仅支持 Page Bundle",
		);
	});

	it("拒绝客户端 slug 中的路径穿越与分隔符", () => {
		for (const slug of ["../secret", "child/path", "child\\path", "%2e%2e", "a..b"]) {
			expect(() => buildArticlePath(slug, validConfig), slug).toThrow("Slug 校验失败");
		}
	});

	it("拒绝绝对、Windows 和穿越形式的内容根目录", () => {
		for (const contentRoot of [
			"/src/content/posts",
			"C:/src/content/posts",
			"src\\content\\posts",
			"src/content/../secrets",
			"src//content/posts",
			"src/content/posts/",
		]) {
			expect(() => buildArticlePath("hello", { ...validConfig, contentRoot }), contentRoot).toThrow(
				"内容根目录配置无效",
			);
		}
	});

	it("拒绝编码、控制字符和 Unicode 混淆的内容根目录", () => {
		for (const contentRoot of [
			"src/content/%2e%2e/posts",
			"src/content/po\u0000sts",
			"ｓｒｃ/content/posts",
		]) {
			expect(() => buildArticlePath("hello", { ...validConfig, contentRoot }), contentRoot).toThrow(
				"内容根目录配置无效",
			);
		}
	});

	it("入口文件固定为安全 Markdown 文件名", () => {
		for (const entryFilename of [
			"../index.md",
			"nested/index.md",
			"index.mdx",
			"index.html",
			"C:index.md",
			"ｉｎｄｅｘ.md",
		]) {
			expect(
				() => buildArticlePath("hello", { ...validConfig, entryFilename }),
				entryFilename,
			).toThrow("入口文件配置无效");
		}
	});

	it("构造 Page Bundle 直接子资源路径和相对引用", () => {
		expect(parseArticleResourceFilename("cover-abc123.webp")).toBe("cover-abc123.webp");
		expect(parseArticleResourceReference("./cover-abc123.webp")).toBe("./cover-abc123.webp");
		expect(buildArticleResourcePath("hello", "cover-abc123.webp", validConfig)).toBe(
			"src/content/posts/hello/cover-abc123.webp",
		);
	});

	it("资源文件名拒绝目录、编码分隔符、控制字符和入口文件冲突", () => {
		for (const filename of [
			"../cover.webp",
			"images/cover.webp",
			"images\\cover.webp",
			"a%2Fb.webp",
			"C:cover.webp",
			"cover\u0000.webp",
			"ｃｏｖｅｒ.webp",
			"index.md",
			".",
			"..",
		]) {
			expect(() => buildArticleResourcePath("hello", filename, validConfig), filename).toThrow();
		}
	});

	it("资源文件名拒绝隐藏文件、Windows 保留名和双扩展伪装", () => {
		for (const filename of [
			".hidden.pdf",
			"CON.pdf",
			"prn.PNG",
			"com1.txt",
			"LPT9.zip",
			"cover.png.exe",
			"archive.tar.gz",
			"no-extension",
			"trailing.",
		]) {
			expect(() => parseArticleResourceFilename(filename), filename).toThrow("资源文件名无效");
		}
	});

	it("使用规范化大小写冲突键并拒绝入口文件大小写变体", () => {
		expect(getArticleResourceFilenameConflictKey("Cover.PNG")).toBe("cover.png");
		expect(getArticleResourceFilenameConflictKey("cover.png")).toBe("cover.png");
		expect(() => buildArticleResourcePath("hello", "INDEX.MD", validConfig)).toThrow(
			"不能覆盖入口文件",
		);
		expect(() => parseArticleResourceReference("./INDEX.MD")).toThrow("不能覆盖入口文件");
	});

	it("资源相对引用固定为当前 Page Bundle 的直接子文件", () => {
		for (const reference of [
			"cover.webp",
			"../cover.webp",
			"../other/cover.webp",
			"./images/cover.webp",
			"./a%2Fb.webp",
			"./index.md",
		]) {
			expect(() => parseArticleResourceReference(reference), reference).toThrow();
		}
	});

	it("为媒体事务构造并解析规范的跨 Page Bundle 资源引用", () => {
		expect(buildControlledArticleResourceReference("source-post", "source-post", "cover.png")).toBe(
			"./cover.png",
		);
		expect(buildControlledArticleResourceReference("source-post", "target-post", "cover.png")).toBe(
			"../target-post/cover.png",
		);
		expect(
			parseControlledArticleResourceReference(
				"source-post",
				"../target-post/cover.png",
				validConfig,
			),
		).toEqual({
			reference: "../target-post/cover.png",
			storageSlug: "target-post",
			filename: "cover.png",
			repositoryPath: "src/content/posts/target-post/cover.png",
		});
	});

	it("受控跨 Bundle 引用拒绝逃逸、子目录、编码和非规范自引用", () => {
		for (const reference of [
			"../../secret/cover.png",
			"../target-post/images/cover.png",
			"../target-post/a%2Fb.png",
			"..\\target-post\\cover.png",
			"../source-post/cover.png",
			"../target-post/index.md",
			"../target-post/cover.png?raw=1",
			"../target-post/cover.png#preview",
		]) {
			expect(
				() => parseControlledArticleResourceReference("source-post", reference, validConfig),
				reference,
			).toThrow();
		}
	});

	it("API 形态不接受客户端完整路径", () => {
		const maliciousInput = {
			slug: "hello",
			path: "../../secrets/token",
		};
		expect(() => buildArticlePath(maliciousInput, validConfig)).toThrow("Slug 校验失败");
	});

	it("错误消息不回显恶意路径", () => {
		const malicious = "../../secret-token";
		try {
			buildArticlePath(malicious, validConfig);
		} catch (error) {
			expect(String(error)).not.toContain(malicious);
		}
	});
});
