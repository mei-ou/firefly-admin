import { describe, expect, it } from "vitest";
import {
	buildEditableMarkdownDocument,
	buildMarkdownDocument,
	canonicalizeMarkdownDocument,
	parseEditableFrontmatter,
	parseEditableMarkdownDocument,
	parseFrontmatter,
	parseMarkdownDocument,
	serializeEditableFrontmatter,
	serializeFrontmatter,
} from "../../src/utils/frontmatter-utils";

const minimalFrontmatter = {
	title: "文章：# YAML 与安全",
	published: new Date("2026-08-12T00:00:00.000Z"),
	tags: ["on", "yes", "Cloudflare"],
	description: "第一行；第二行",
};

describe("Frontmatter 安全序列化", () => {
	it("使用 YAML 库正确引用特殊字符并保持稳定字段顺序", () => {
		const yaml = serializeFrontmatter(minimalFrontmatter, "yaml-security");

		expect(yaml.indexOf("title:")).toBeLessThan(yaml.indexOf("slug:"));
		expect(yaml.indexOf("slug:")).toBeLessThan(yaml.indexOf("published:"));
		// 不依赖 YAML 库选择 plain 或 quoted scalar；安全标准是解析后值不被 `#` 截断。
		expect(parseFrontmatter(yaml).frontmatter.title).toBe("文章：# YAML 与安全");
		expect(yaml).toContain("published: 2026-08-12T00:00:00.000Z");
		expect(yaml).not.toContain("prevTitle");
	});

	it("序列化与解析往返保持类型和默认值", () => {
		const yaml = serializeFrontmatter(minimalFrontmatter, "yaml-security");
		const parsed = parseFrontmatter(yaml);

		expect(parsed.slug).toBe("yaml-security");
		expect(parsed.frontmatter.published).toEqual(new Date("2026-08-12T00:00:00.000Z"));
		expect(parsed.frontmatter.tags).toEqual(["on", "yes", "Cloudflare"]);
		expect(parsed.frontmatter.draft).toBe(true);
		expect(parsed.frontmatter.category).toBeNull();
	});

	it("拒绝序列化内部字段和非法 slug", () => {
		expect(() => serializeFrontmatter({ ...minimalFrontmatter, prevSlug: "secret" })).toThrow();
		expect(() => serializeFrontmatter(minimalFrontmatter, "../secret")).toThrow("Slug 校验失败");
	});
});

describe("不可信 YAML 解析", () => {
	it("拒绝重复键", () => {
		expect(() => parseFrontmatter("title: first\ntitle: second\npublished: 2026-08-12")).toThrow(
			"YAML 无效",
		);
	});

	it("拒绝 alias 和锚点展开", () => {
		expect(() =>
			parseFrontmatter("title: &title safe\npublished: 2026-08-12\ndescription: *title"),
		).toThrow();
	});

	it("拒绝 merge key 和未知字段", () => {
		expect(() =>
			parseFrontmatter(
				"title: safe\npublished: 2026-08-12\nextra: &extra\n  draft: false\n<<: *extra",
			),
		).toThrow();
	});

	it("拒绝显式危险或未知标签", () => {
		for (const yaml of [
			"title: !!js/function function() {}\npublished: 2026-08-12",
			"title: !custom value\npublished: 2026-08-12",
		]) {
			expect(() => parseFrontmatter(yaml), yaml).toThrow();
		}
	});

	it("拒绝非对象根节点和超大 Frontmatter", () => {
		expect(() => parseFrontmatter("- title\n- published")).toThrow("必须是对象");
		expect(() => parseFrontmatter("x".repeat(64 * 1024 + 1))).toThrow("内容无效");
	});

	it("单独提取并严格校验原始 slug", () => {
		const parsed = parseFrontmatter("title: 安全文章\npublished: 2026-08-12\nslug: safe-article");
		expect(parsed.slug).toBe("safe-article");
		expect(() =>
			parseFrontmatter("title: 危险文章\npublished: 2026-08-12\nslug: ../secret"),
		).toThrow("Slug 校验失败");
	});
});

describe("完整 Markdown 文档", () => {
	it("组合并拆分 Frontmatter 与正文", () => {
		const markdown = "# 标题\n\n正文\n\n---\n\n正文中的分隔线";
		const document = buildMarkdownDocument(minimalFrontmatter, markdown, "yaml-security");
		const parsed = parseMarkdownDocument(document);

		expect(document.startsWith("---\n")).toBe(true);
		expect(parsed.slug).toBe("yaml-security");
		expect(parsed.markdown).toBe(markdown);
	});

	it("规范化 BOM、CRLF 和 Frontmatter 字段顺序但保留正文内容", () => {
		const source = [
			"\uFEFF---",
			"published: 2026-08-12T00:00:00.000Z",
			"image: ./cover.webp",
			"title: Canonical Markdown",
			"slug: yaml-security",
			"---",
			"# 正文  ",
			"",
			"保留正文尾随空格与结尾。",
		].join("\r\n");
		const canonical = canonicalizeMarkdownDocument(source);

		expect(canonical.startsWith("---\ntitle: Canonical Markdown\nslug: yaml-security\n")).toBe(
			true,
		);
		expect(canonical).toContain("image: ./cover.webp\n");
		expect(canonical.endsWith("# 正文  \n\n保留正文尾随空格与结尾。")).toBe(true);
		expect(canonicalizeMarkdownDocument(canonical)).toBe(canonical);
	});

	it("兼容 UTF-8 BOM 和 CRLF", () => {
		const document = buildMarkdownDocument(minimalFrontmatter, "# 正文", "yaml-security");
		const crlfDocument = `\uFEFF${document.replaceAll("\n", "\r\n")}`;
		expect(parseMarkdownDocument(crlfDocument).markdown).toBe("# 正文");
	});

	it("拒绝缺失或未闭合的 Frontmatter", () => {
		expect(() => parseMarkdownDocument("# 没有 Frontmatter")).toThrow("缺少 Frontmatter");
		expect(() => parseMarkdownDocument("---\ntitle: 未闭合")).toThrow("未闭合");
	});

	it("限制 Markdown 文档体积", () => {
		expect(() => buildMarkdownDocument(minimalFrontmatter, "x".repeat(1_000_001))).toThrow(
			"正文无效",
		);
	});
});

describe("编辑器源码事务", () => {
	it("保留未知 Front-matter 字段并只规范化已知字段", () => {
		const source = [
			"---",
			"title: Source mode",
			"published: 2026-08-12",
			"slug: source-mode",
			"series: legacy-series",
			"customFlags:",
			"  - alpha",
			"  - beta",
			"---",
			"# 正文  ",
		].join("\n");
		const parsed = parseEditableMarkdownDocument(source);

		expect(parsed.slug).toBe("source-mode");
		expect(parsed.unknownFrontmatter).toEqual({
			series: "legacy-series",
			customFlags: ["alpha", "beta"],
		});
		expect(
			buildEditableMarkdownDocument(
				parsed.frontmatter,
				parsed.unknownFrontmatter,
				parsed.markdown,
				parsed.slug,
			),
		).toContain("series: legacy-series\ncustomFlags:\n  - alpha\n  - beta\n");
	});

	it("源码模式解析失败时不返回部分结果", () => {
		expect(() => parseEditableFrontmatter("title: [broken")).toThrow("YAML 无效");
		expect(() => parseEditableMarkdownDocument("---\ntitle: no close")).toThrow("未闭合");
	});

	it("阻止未知字段覆盖已知字段或 slug", () => {
		expect(() => serializeEditableFrontmatter(minimalFrontmatter, { title: "覆盖" })).toThrow(
			"受保护字段",
		);
		expect(() => serializeEditableFrontmatter(minimalFrontmatter, { slug: "覆盖" })).toThrow(
			"受保护字段",
		);
	});
});
