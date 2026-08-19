import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleGetArticleLinkTargets } from "../../../modules/articles/api/get-article-link-targets";

export const prerender = false;

export const GET: APIRoute = ({ request, locals }) =>
	handleGetArticleLinkTargets({
		request,
		principal: locals.principal,
		env,
	});
