import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleCommitMediaTransaction } from "../../../../modules/media/api/commit-media-transaction";

export const prerender = false;

export const POST: APIRoute = ({ request, locals }) =>
	handleCommitMediaTransaction({
		request,
		requestId: locals.requestId,
		principal: locals.principal,
		env,
	});
