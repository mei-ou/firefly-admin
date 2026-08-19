import type { APIRoute } from "astro";
import { z } from "zod";
import { guardModule } from "../../../core/config/feature-flags";
import { jsonResponse } from "../../../core/http/response";
import { getModule } from "../../../modules/registry";

const moduleIdSchema = z.enum(["dashboard", "articles", "media", "deployments", "settings"]);

export const prerender = false;

export const GET: APIRoute = ({ params }) => {
	const result = moduleIdSchema.safeParse(params.module);
	if (!result.success) {
		return jsonResponse({ error: { code: "NOT_FOUND", message: "资源不存在。" } }, 404);
	}

	guardModule(result.data);
	const module = getModule(result.data);
	if (!module) {
		return jsonResponse({ error: { code: "NOT_FOUND", message: "资源不存在。" } }, 404);
	}
	return jsonResponse({
		module: {
			id: module.id,
			label: module.navigation.label,
			status: "p0-shell",
		},
	});
};
