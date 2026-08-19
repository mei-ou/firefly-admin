import type { AdminModule } from "../../types/module";

export const dashboardModule = {
	id: "dashboard",
	navigation: {
		label: "概览",
		description: "查看后台安全状态与模块入口",
		icon: "layout-dashboard",
		order: 10,
	},
	routes: [{ path: "/" }],
	permissions: ["dashboard.read"],
} as const satisfies AdminModule;
