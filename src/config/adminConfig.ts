import { moduleConfig } from "./moduleConfig";

export const adminConfig = {
	name: "Firefly Admin",
	version: "0.1.0",
	description: "面向 Firefly 博客的安全无服务器管理后台",
	modules: moduleConfig,
} as const;
