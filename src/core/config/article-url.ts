import { z } from "zod";
import { ApiError } from "../http/errors";

const PLACEHOLDER = "{slug}";
const articleUrlTemplateSchema = z
	.string()
	.trim()
	.max(2_048)
	.refine((value) => value.split(PLACEHOLDER).length === 2)
	.refine((value) => {
		try {
			const candidate = new URL(value.replace(PLACEHOLDER, "article-slug"));
			return (
				candidate.protocol === "https:" &&
				candidate.username === "" &&
				candidate.password === "" &&
				candidate.hash === ""
			);
		} catch {
			return false;
		}
	});

/**
 * 正式文章路径规则属于部署配置，不能由后台根据 storage slug 猜测。未配置时省略预计
 * 地址；一旦提供，则必须是只含一个 `{slug}` 的 HTTPS 模板，且禁止凭据和片段。
 */
export function loadArticleUrlTemplate(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const raw = Reflect.get(input, "PUBLIC_ARTICLE_URL_TEMPLATE");
	if (raw === undefined || raw === "") return undefined;
	const result = articleUrlTemplateSchema.safeParse(raw);
	if (!result.success) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "文章公开地址尚未正确配置。");
	}
	return result.data;
}

export function buildExpectedArticleUrl(
	template: string | undefined,
	slug: string,
): string | undefined {
	if (!template) return undefined;
	const value = template.replace(PLACEHOLDER, encodeURIComponent(slug));
	const result = z
		.url()
		.refine((url) => new URL(url).protocol === "https:")
		.safeParse(value);
	if (!result.success) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "文章公开地址尚未正确配置。");
	}
	return result.data;
}
