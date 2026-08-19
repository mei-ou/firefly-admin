import { isModuleEnabled } from "../modules/registry";
import type { ModuleId } from "../types/module";
import type { ProviderFactory } from "../types/provider";

/**
 * 仅在所属模块启用时创建外部服务 Provider。
 *
 * Provider 工厂可能读取 GitHub、图床或 Cloudflare Secret，所以开关检查必须发生在
 * create 调用之前，而不能只在 UI 层隐藏模块入口。
 */
export function initializeProvider<TProvider>(
	moduleId: ModuleId,
	factory: ProviderFactory<TProvider>,
): TProvider | undefined {
	if (factory.moduleId !== moduleId || !isModuleEnabled(moduleId)) {
		// 先检查功能开关，再调用工厂。工厂因此不会读取已关闭模块的 Secret。
		return undefined;
	}

	return factory.create();
}
