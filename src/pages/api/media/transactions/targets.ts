import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleGetMediaTransactionTargets } from "../../../../modules/media/api/get-media-transaction-targets";

export const prerender = false;

export const GET: APIRoute = ({ request, locals }) =>
	handleGetMediaTransactionTargets({
		request,
		requestId: locals.requestId,
		principal: locals.principal,
		env,
	});
