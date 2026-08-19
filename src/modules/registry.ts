import { moduleConfig } from "../config/moduleConfig";
import type { AdminModule, ModuleId } from "../types/module";
import { articlesModule } from "./articles/manifest";
import { dashboardModule } from "./dashboard/manifest";
import { deploymentsModule } from "./deployments/manifest";
import { mediaModule } from "./media/manifest";
import { settingsModule } from "./settings/manifest";

/**
 * 所有后台模块的静态注册表，是导航、路由守卫和 Provider 开关的共同来源。
 * Astro 文件路由会存在于构建产物中，但禁用模块仍会在服务端守卫处返回 404。
 */
export const moduleRegistry = [
	dashboardModule,
	articlesModule,
	mediaModule,
	deploymentsModule,
	settingsModule,
] as const satisfies readonly AdminModule[];

export function isModuleEnabled(moduleId: ModuleId): boolean {
	return moduleConfig[moduleId].enable;
}

export function getEnabledModules(): AdminModule[] {
	return moduleRegistry
		.filter((module) => isModuleEnabled(module.id))
		.slice()
		.sort((left, right) => left.navigation.order - right.navigation.order);
}

export function getModule(moduleId: ModuleId): AdminModule | undefined {
	return moduleRegistry.find((module) => module.id === moduleId);
}
