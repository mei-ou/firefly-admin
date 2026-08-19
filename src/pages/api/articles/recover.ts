import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleRecoverArticleCommit } from "../../../modules/articles/api/recover-article-commit";

export const prerender = false;

/**
 * 人工恢复路由只暴露幂等状态查询和只读确认；真正的提交写入仍只能由文章写入 API 执行。
 */
export const GET: APIRoute = ({ request, locals }) =>
	handleRecoverArticleCommit({
		request,
		requestId: locals.requestId,
		principal: locals.principal,
		env,
	});

export const POST: APIRoute = ({ request, locals }) =>
	handleRecoverArticleCommit({
		request,
		requestId: locals.requestId,
		principal: locals.principal,
		env,
	});
