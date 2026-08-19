import type { ModuleId } from "./module";

export interface ProviderDescriptor {
	id: string;
	moduleId: ModuleId;
}

/**
 * 外部服务的延迟工厂契约。
 * create 只能由 Provider registry 在模块开关校验通过后调用，避免提前读取 Secret。
 */
export interface ProviderFactory<TProvider> extends ProviderDescriptor {
	create(): TProvider;
}
