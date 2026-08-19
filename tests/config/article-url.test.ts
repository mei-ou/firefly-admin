import { describe, expect, it } from "vitest";
import { buildExpectedArticleUrl, loadArticleUrlTemplate } from "../../src/core/config/article-url";

describe("预计文章 URL 配置", () => {
	it("未配置时省略预计地址而不猜测主站规则", () => {
		expect(loadArticleUrlTemplate({})).toBeUndefined();
		expect(loadArticleUrlTemplate({ PUBLIC_ARTICLE_URL_TEMPLATE: "" })).toBeUndefined();
		expect(buildExpectedArticleUrl(undefined, "hello-world")).toBeUndefined();
	});

	it("使用唯一 slug 占位符构造 HTTPS 地址", () => {
		const template = loadArticleUrlTemplate({
			PUBLIC_ARTICLE_URL_TEMPLATE: "https://blog.example.com/posts/{slug}/",
		});
		expect(buildExpectedArticleUrl(template, "hello-world")).toBe(
			"https://blog.example.com/posts/hello-world/",
		);
	});

	it("拒绝不安全或含糊的模板", () => {
		for (const template of [
			"http://blog.example.com/posts/{slug}/",
			"https://user:pass@blog.example.com/{slug}",
			"https://blog.example.com/posts/no-placeholder",
			"https://blog.example.com/{slug}/{slug}",
			"https://blog.example.com/{slug}#section",
		]) {
			expect(() => loadArticleUrlTemplate({ PUBLIC_ARTICLE_URL_TEMPLATE: template })).toThrow(
				expect.objectContaining({ status: 503, code: "CONFIGURATION_ERROR" }),
			);
		}
	});
});
