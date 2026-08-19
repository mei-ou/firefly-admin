import type { AdminModule } from "../../types/module";

export const deploymentsModule = {
	id: "deployments",
	navigation: {
		label: "部署",
		description: "查看 Git 提交后的部署状态",
		icon: "rocket",
		order: 40,
	},
	routes: [{ path: "/deployments" }],
	permissions: ["deployments.read"],
} as const satisfies AdminModule;
