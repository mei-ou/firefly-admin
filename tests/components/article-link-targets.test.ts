import { describe, expect, it } from "vitest";
import { parseArticleLinkTargetsPayload } from "../../src/components/articles/article-link-targets";

const validPayload = {
	targets: {
		items: [
			{
				storageSlug: "hello-firefly",
				slug: "hello-firefly",
				title: "Hello Firefly",
				href: "/posts/hello-firefly/",
				description: "简介",
				category: "Guide",
				tags: ["Firefly"],
				headings: [{ depth: 2, text: "快速开始", id: "快速开始" }],
			},
		],
		truncated: false,
	},
};

describe("文章链接索引响应边界", () => {
	it("接受完整且有界的链接目标响应", () => {
		expect(parseArticleLinkTargetsPayload(validPayload)).toEqual(validPayload.targets);
	});

	it("接受 H1，并拒绝未知字段和超出 H1-H6 的标题层级", () => {
		expect(
			parseArticleLinkTargetsPayload({
				targets: {
					...validPayload.targets,
					items: [
						{
							...validPayload.targets.items[0],
							headings: [{ depth: 1, text: "标题", id: "title" }],
						},
					],
				},
			}).items[0]?.headings,
		).toEqual([{ depth: 1, text: "标题", id: "title" }]);
		expect(() =>
			parseArticleLinkTargetsPayload({ ...validPayload, repository: "secret" }),
		).toThrow();
		for (const depth of [0, 7]) {
			expect(() =>
				parseArticleLinkTargetsPayload({
					targets: {
						...validPayload.targets,
						items: [
							{
								...validPayload.targets.items[0],
								headings: [{ depth, text: "标题", id: "title" }],
							},
						],
					},
				}),
			).toThrow();
		}
	});
});
