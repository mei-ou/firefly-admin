import type { ModuleConfig } from "../types/config";

/**
 * 第一阶段只开放已有安全外壳的模块。设置模块保持关闭，避免误导用户认为
 * 浏览器中的配置表单可以安全地修改服务端 Secret。
 */
export const moduleConfig = {
	dashboard: { enable: true },
	articles: { enable: true },
	media: { enable: true },
	deployments: { enable: true },
	settings: { enable: false },
} as const satisfies ModuleConfig;
