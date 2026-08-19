import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { handleGetRepositoryDirectory } from "../../../modules/repository/api/get-repository-directory";

export const prerender = false;

export const GET: APIRoute = ({ request, locals }) =>
	handleGetRepositoryDirectory({
		request,
		principal: locals.principal,
		env,
	});
