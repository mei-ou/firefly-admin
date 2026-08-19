import { describe, expect, it, vi } from "vitest";
import {
	renderMarkdownForSanitization,
	renderSafeMarkdown,
	type SanitizeHtml,
} from "../../src/components/articles/markdown-preview";

describe("Markdown 安全预览", () => {
	it("渲染常用 Markdown 结构", () => {
		const html = renderMarkdownForSanitization("# 标题\n\n**粗体**、`code`\n\n- one\n- two");
		expect(html).toContain("<h1>标题</h1>");
		expect(html).toContain("<strong>粗体</strong>");
		expect(html).toContain("<code>code</code>");
		expect(html).toContain("<ul>");
	});

	it("渲染工具栏生成的受控下划线、高亮、字号和颜色", () => {
		const html = renderMarkdownForSanitization(
			'<u>下划线</u> <mark>高亮</mark> <span style="font-size:1.25rem">大字</span> <span style="color:#dc2626">红字</span>',
		);
		expect(html).toContain("<u>下划线</u>");
		expect(html).toContain("<mark>高亮</mark>");
		expect(html).toContain('<span style="font-size:1.25rem">大字</span>');
		expect(html).toContain('<span style="color:#dc2626">红字</span>');
	});

	it("把非白名单原始 HTML 当作文本，不创建脚本或带事件属性的节点", () => {
		const html = renderMarkdownForSanitization(
			'<script>alert(1)</script><img src=x onerror="alert(2)"><div onclick="alert(3)">text</div>',
		);
		expect(html).not.toContain("<script>");
		expect(html).not.toContain("<img ");
		expect(html).not.toContain("<div ");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
	});

	it("拒绝 Markdown 图片和危险链接协议", () => {
		const html = renderMarkdownForSanitization(
			"![secret](https://attacker.example/pixel) [click](javascript:alert(1)) [data](data:text/html,x)",
		);
		expect(html).not.toContain("<img");
		expect(html).not.toContain("javascript:");
		expect(html).not.toContain("data:text");
		expect(html).toContain("secret");
		expect(html).toContain("click");
		expect(html).not.toContain(">click</a>");
	});

	it("外部 HTTP 链接增加隔离属性，同源相对链接保持当前页打开", () => {
		const html = renderMarkdownForSanitization(
			"[external](https://example.com) [internal](/articles)",
		);
		expect(html).toContain(
			'<a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">external</a>',
		);
		expect(html).toContain('<a href="/articles">internal</a>');
	});

	it("把严格的 DOMPurify 白名单配置交给最终清洗层", () => {
		const sanitize = vi.fn<SanitizeHtml>((html) => html);
		const html = renderSafeMarkdown("# title", sanitize);
		expect(html).toContain("<h1>title</h1>");
		expect(sanitize).toHaveBeenCalledOnce();
		expect(sanitize.mock.calls[0]?.[1]).toMatchObject({
			ALLOWED_ATTR: ["href", "title", "style"],
			ALLOWED_TAGS: expect.arrayContaining(["u", "mark", "span"]),
			ALLOW_DATA_ATTR: false,
			ALLOW_ARIA_ATTR: false,
			FORBID_TAGS: expect.arrayContaining(["form", "iframe", "img", "svg", "template"]),
			RETURN_TRUSTED_TYPE: false,
		});
	});
});
