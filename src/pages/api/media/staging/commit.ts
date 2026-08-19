import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleCommitStagedMedia } from "../../../../modules/media/api/commit-staged-media";

export const prerender = false;

export const POST: APIRoute = ({ request, locals }) =>
	handleCommitStagedMedia({
		request,
		requestId: locals.requestId,
		principal: locals.principal,
		env,
	});
