import type { APIRoute } from "astro";
import { jsonResponse } from "../../core/http/response";

export const prerender = false;

export const GET: APIRoute = () =>
	jsonResponse({
		ok: true,
	});
