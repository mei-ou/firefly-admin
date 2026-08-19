import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleCheckArticleSlug } from "../../../modules/articles/api/check-article-slug";
import { handleDeleteArticle } from "../../../modules/articles/api/delete-article";
import { handleGetArticleDetail } from "../../../modules/articles/api/get-article-detail";
import { handleUpdateArticle } from "../../../modules/articles/api/update-article";

export const prerender = false;

/**
 * 动态路由只负责把 Astro/Cloudflare 上下文交给可测试编排层。认证异常、上游异常和
 * 限流错误由全局 Middleware 统一转为带 requestId 的错误响应。
 */
export const GET: APIRoute = ({ params, locals }) =>
	handleGetArticleDetail({
		slug: params.slug,
		principal: locals.principal,
		env,
	});

export const HEAD: APIRoute = ({ params, locals }) =>
	handleCheckArticleSlug({
		slug: params.slug,
		principal: locals.principal,
		env,
	});

export const PUT: APIRoute = ({ request, params, locals }) =>
	handleUpdateArticle({
		request,
		requestId: locals.requestId,
		slug: params.slug,
		principal: locals.principal,
		env,
	});

export const DELETE: APIRoute = ({ request, params, locals }) =>
	handleDeleteArticle({
		request,
		requestId: locals.requestId,
		slug: params.slug,
		principal: locals.principal,
		env,
	});
