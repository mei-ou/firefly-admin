import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handlePreviewMediaTransaction } from "../../../../modules/media/api/preview-media-transaction";

export const prerender = false;

export const POST: APIRoute = ({ request, locals }) =>
	handlePreviewMediaTransaction({
		request,
		requestId: locals.requestId,
		principal: locals.principal,
		env,
	});
