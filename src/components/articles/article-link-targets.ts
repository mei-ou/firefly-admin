import { z } from "zod";

const articleHeadingTargetSchema = z
	.object({
		depth: z.number().int().min(1).max(6),
		text: z.string().trim().min(1).max(500),
		id: z.string().trim().min(1).max(500),
	})
	.strict();

const articleLinkTargetSchema = z
	.object({
		storageSlug: z.string().trim().min(1).max(200),
		slug: z.string().trim().min(1).max(200),
		title: z.string().trim().min(1).max(500),
		href: z.string().trim().min(1).max(2_000),
		description: z.string().max(2_000),
		category: z.string().max(200).nullable(),
		tags: z.array(z.string().max(200)).max(100),
		headings: z.array(articleHeadingTargetSchema).max(500),
	})
	.strict();

const articleLinkTargetsPayloadSchema = z
	.object({
		targets: z
			.object({
				items: z.array(articleLinkTargetSchema).max(50),
				truncated: z.boolean(),
			})
			.strict(),
	})
	.strict();

export type ArticleHeadingTarget = z.infer<typeof articleHeadingTargetSchema>;
export type ArticleLinkTarget = z.infer<typeof articleLinkTargetSchema>;

/** 浏览器不信任网络响应；选择器仅消费完整通过边界校验的文章链接索引。 */
export function parseArticleLinkTargetsPayload(value: unknown): {
	items: ArticleLinkTarget[];
	truncated: boolean;
} {
	return articleLinkTargetsPayloadSchema.parse(value).targets;
}
