import type { ModuleId } from "./module";

export type ModuleConfig = Readonly<Record<ModuleId, { enable: boolean }>>;

export interface AdminPublicConfig {
	name: string;
	description: string;
	modules: ModuleConfig;
}
