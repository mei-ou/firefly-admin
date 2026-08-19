import { z } from "zod";

const articleSummarySchema = z
	.object({
		storageSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
		slug: z
			.string()
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
			.optional(),
		title: z.string().min(1).max(200),
		published: z.iso.datetime({ offset: true }),
		updated: z.iso.datetime({ offset: true }).optional(),
		draft: z.boolean(),
		description: z.string().max(500),
		tags: z.array(z.string().min(1).max(50)).max(30),
		category: z.string().min(1).max(100).nullable(),
		pinned: z.boolean(),
	})
	.strict();

const articleListPayloadSchema = z
	.object({
		articles: z
			.object({
				items: z.array(articleSummarySchema),
				page: z.number().int().min(1),
				pageSize: z.number().int().min(1).max(50),
				total: z.number().int().nonnegative(),
				totalPages: z.number().int().nonnegative(),
				candidateCount: z.number().int().nonnegative(),
				scanned: z.number().int().nonnegative().max(100),
				skipped: z.number().int().nonnegative(),
				truncated: z.boolean(),
			})
			.strict(),
	})
	.strict();

const apiErrorPayloadSchema = z
	.object({
		error: z
			.object({
				code: z.string(),
				message: z.string(),
				requestId: z.string().optional(),
			})
			.strict(),
	})
	.strict();

export type ArticleListPayload = z.infer<typeof articleListPayloadSchema>["articles"];
export type ArticleListItem = ArticleListPayload["items"][number];

export interface ArticleListSearchState {
	page: number;
	pageSize: number;
	query: string;
}

export const DEFAULT_ARTICLE_LIST_SEARCH: ArticleListSearchState = {
	page: 1,
	pageSize: 20,
	query: "",
};

export function buildArticleListApiUrl(state: ArticleListSearchState): string {
	const parameters = new URLSearchParams({
		page: String(state.page),
		pageSize: String(state.pageSize),
	});
	const query = state.query.trim();
	if (query.length > 0) {
		parameters.set("query", query);
	}
	return `/api/articles?${parameters.toString()}`;
}

/** 浏览器同样把 API 当作不可信边界；格式异常时拒绝渲染，而不是凭字段猜测继续执行。 */
export function parseArticleListPayload(input: unknown): ArticleListPayload {
	return articleListPayloadSchema.parse(input).articles;
}

export function parseArticleListError(input: unknown, status: number): string {
	const result = apiErrorPayloadSchema.safeParse(input);
	if (result.success) {
		return result.data.error.message;
	}
	return status === 401 || status === 403
		? "登录状态已失效，请刷新页面后重试。"
		: "文章列表暂时无法加载，请稍后重试。";
}

export function formatArticleDate(value: string): string {
	const date = new Date(value);
	return new Intl.DateTimeFormat("zh-CN", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}
