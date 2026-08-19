import { describe, expect, it } from "vitest";
import {
	buildArticleListApiUrl,
	formatArticleDate,
	parseArticleListError,
	parseArticleListPayload,
} from "../../src/components/articles/article-list-state";

const validPayload = {
	articles: {
		items: [
			{
				storageSlug: "hello-world",
				slug: "public-url",
				title: "Hello",
				published: "2026-08-12T00:00:00.000Z",
				draft: true,
				description: "Description",
				tags: ["Firefly"],
				category: "Guide",
				pinned: false,
			},
		],
		page: 1,
		pageSize: 20,
		total: 1,
		totalPages: 1,
		candidateCount: 1,
		scanned: 1,
		skipped: 0,
		truncated: false,
	},
};

describe("文章列表浏览器状态边界", () => {
	it("构造固定同源 API 路径并安全编码搜索词", () => {
		expect(buildArticleListApiUrl({ page: 2, pageSize: 20, query: " 安全 & Firefly " })).toBe(
			"/api/articles?page=2&pageSize=20&query=%E5%AE%89%E5%85%A8+%26+Firefly",
		);
		expect(buildArticleListApiUrl({ page: 1, pageSize: 20, query: "  " })).toBe(
			"/api/articles?page=1&pageSize=20",
		);
	});

	it("接受完整列表响应并保留安全展示字段", () => {
		const result = parseArticleListPayload(validPayload);
		expect(result.items[0]).toMatchObject({
			storageSlug: "hello-world",
			slug: "public-url",
			title: "Hello",
		});
	});

	it("拒绝未知字段、危险 slug 和越界扫描数量", () => {
		expect(() =>
			parseArticleListPayload({
				...validPayload,
				articles: { ...validPayload.articles, internalPath: "src/content/posts" },
			}),
		).toThrow();
		expect(() =>
			parseArticleListPayload({
				...validPayload,
				articles: {
					...validPayload.articles,
					items: [{ ...validPayload.articles.items[0], storageSlug: "../secret" }],
				},
			}),
		).toThrow();
		expect(() =>
			parseArticleListPayload({
				...validPayload,
				articles: { ...validPayload.articles, scanned: 101 },
			}),
		).toThrow();
	});

	it("优先展示统一 API 错误，并为非 JSON 响应提供稳定回退", () => {
		expect(
			parseArticleListError(
				{ error: { code: "RATE_LIMITED", message: "请求过于频繁。", requestId: "req-1" } },
				429,
			),
		).toBe("请求过于频繁。");
		expect(parseArticleListError(null, 401)).toBe("登录状态已失效，请刷新页面后重试。");
		expect(parseArticleListError("not-json", 503)).toBe("文章列表暂时无法加载，请稍后重试。");
	});

	it("使用中文日期格式展示 ISO 时间", () => {
		expect(formatArticleDate("2026-08-12T00:00:00.000Z")).toMatch(/2026/);
		expect(formatArticleDate("2026-08-12T00:00:00.000Z")).toMatch(/08|8/);
	});
});
