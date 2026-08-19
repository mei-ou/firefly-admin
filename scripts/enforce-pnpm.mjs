const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
	console.error("Firefly Admin 必须使用 pnpm 安装依赖。");
	process.exit(1);
}
