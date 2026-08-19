import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleCreateArticle } from "../../../modules/articles/api/create-article";
import { handleGetArticleList } from "../../../modules/articles/api/get-article-list";

export const prerender = false;

/** 根路由同时承载列表读取和创建；两者共享 Middleware 认证，但在业务层保留主体纵深检查。 */
export const GET: APIRoute = ({ request, locals }) =>
	handleGetArticleList({
		request,
		principal: locals.principal,
		env,
	});

/**
 * 写请求来源与 Content-Type 已由全局 Middleware 在读取正文前校验；路由只注入已验证
 * 上下文，所有业务错误继续由 Middleware 转为带 requestId 的统一响应。
 */
export const POST: APIRoute = ({ request, locals }) =>
	handleCreateArticle({
		request,
		requestId: locals.requestId,
		principal: locals.principal,
		env,
	});
