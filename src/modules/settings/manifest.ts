import type { AdminModule } from "../../types/module";

export const settingsModule = {
	id: "settings",
	navigation: {
		label: "设置",
		description: "查看可公开的后台配置",
		icon: "settings",
		order: 50,
	},
	routes: [{ path: "/settings" }],
	permissions: ["settings.read"],
} as const satisfies AdminModule;
