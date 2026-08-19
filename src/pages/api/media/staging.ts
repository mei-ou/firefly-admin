import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleStageMediaAsset } from "../../../modules/media/api/stage-media-asset";

export const prerender = false;

export const POST: APIRoute = ({ request, locals }) =>
	handleStageMediaAsset({
		request,
		requestId: locals.requestId,
		principal: locals.principal,
		env,
	});
