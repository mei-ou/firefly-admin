export type ModuleId = "dashboard" | "articles" | "media" | "deployments" | "settings";

export type AdminPermission =
	| "dashboard.read"
	| "articles.read"
	| "articles.create"
	| "articles.update"
	| "articles.publish"
	| "media.read"
	| "media.upload"
	| "deployments.read"
	| "settings.read";

export interface ModuleNavigation {
	label: string;
	description: string;
	icon: string;
	order: number;
}

export interface ModuleRoute {
	path: string;
}

/**
 * 模块清单是导航、路由守卫、权限和 Provider 初始化的共同事实来源。
 * 这能避免只在前端隐藏入口，却仍然暴露服务端能力。
 */
export interface AdminModule {
	id: ModuleId;
	navigation: ModuleNavigation;
	routes: readonly ModuleRoute[];
	permissions: readonly AdminPermission[];
	/**
	 * 可选外链：当为合法 https URL 时，导航以 target="_blank" 渲染该 URL，跳过后台内链 active 判定。
	 * 空字符串 "" 表示"外部服务已声明但未配置"——导航渲染为灰态禁用入口，保留位置提示。
	 * undefined 表示该模块不适用外部跳转，按 routes[0].path 渲染内链。
	 * 失败关闭：manifest 必须把未通过校验的 URL 归一化为 ""，避免被恶意/错配 URL 利用为开放重定向。
	 */
	externalUrl?: string;
}
