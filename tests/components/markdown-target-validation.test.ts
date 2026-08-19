import { describe, expect, it } from "vitest";
import {
	parseArticleRelativeImagePath,
	parseExternalLinkTarget,
	parseHeadingLinkTarget,
	parseInternalLinkTarget,
	parseRemoteImageUrl,
} from "../../src/components/articles/markdown-target-validation";

describe("Markdown 插入目标验证", () => {
	it("接受无凭据的 HTTPS 图床地址", () => {
		expect(parseRemoteImageUrl("https://image.example.com/a.webp")).toBe(
			"https://image.example.com/a.webp",
		);
	});

	it("拒绝危险图片协议、HTTP、凭据和异常端口 URL", () => {
		for (const value of [
			"javascript:alert(1)",
			"data:image/png;base64,AA==",
			"http://image.example.com/a.png",
			"https://user:pass@example.com/a.png",
			"https://image.example.com:8443/a.png",
		]) {
			expect(() => parseRemoteImageUrl(value)).toThrow();
		}
	});

	it("接受无凭据 HTTPS 附件链接与 mailto，拒绝协议相对地址和查询凭据", () => {
		expect(parseExternalLinkTarget("https://cdn.example.com/files/guide.pdf")).toBe(
			"https://cdn.example.com/files/guide.pdf",
		);
		expect(parseExternalLinkTarget("mailto:hello@example.com")).toBe("mailto:hello@example.com");
		expect(() => parseExternalLinkTarget("//example.com/path")).toThrow();
		expect(() =>
			parseExternalLinkTarget("https://cdn.example.com/guide.pdf?token=secret"),
		).toThrow();
	});

	it("站内链接只接受 Firefly 的 /posts/<entry-id>/ 路径与标题 hash", () => {
		expect(parseInternalLinkTarget("/posts/demo/#section")).toBe("/posts/demo/#section");
		for (const value of [
			"https://example.com/posts/demo/",
			"//example.com/posts/demo/",
			"/posts/demo",
			"/posts/demo/?preview=true",
			"/admin/",
		]) {
			expect(() => parseInternalLinkTarget(value), value).toThrow();
		}
	});

	it("段落链接必须是非空锚点", () => {
		expect(parseHeadingLinkTarget("#heading-id")).toBe("#heading-id");
		expect(() => parseHeadingLinkTarget("#")).toThrow();
		expect(() => parseHeadingLinkTarget("#bad heading")).toThrow();
	});

	it("文章相对图片只能是当前目录直接子文件", () => {
		expect(parseArticleRelativeImagePath("./cover.webp")).toBe("./cover.webp");
		for (const value of ["../cover.webp", "./images/cover.webp", "./a%2Fb.webp", "/cover.webp"]) {
			expect(() => parseArticleRelativeImagePath(value)).toThrow();
		}
	});
});
