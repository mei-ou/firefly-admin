import { getEnabledModules, isModuleEnabled } from "../../modules/registry";
import type { AdminModule, ModuleId } from "../../types/module";
import { ApiError } from "../http/errors";

export function listNavigationModules(): AdminModule[] {
	return getEnabledModules();
}

/**
 * 在页面和 API 执行业务逻辑前强制检查模块状态。
 * 关闭时统一返回 404，既阻止能力执行，也减少对未启用功能的外部枚举。
 */
export function requireEnabledModule(moduleId: ModuleId): void {
	if (!isModuleEnabled(moduleId)) {
		// 返回 404 而不是 403，避免向调用方暴露已关闭能力的存在。
		throw new ApiError(404, "NOT_FOUND", "资源不存在。");
	}
}

export const guardModule = requireEnabledModule;
