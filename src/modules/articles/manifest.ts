import type { AdminModule } from "../../types/module";

export const articlesModule = {
	id: "articles",
	navigation: {
		label: "文章",
		description: "管理 Markdown 文章",
		icon: "file-text",
		order: 20,
	},
	routes: [{ path: "/articles" }, { path: "/articles/new" }],
	permissions: ["articles.read", "articles.create", "articles.update", "articles.publish"],
} as const satisfies AdminModule;
