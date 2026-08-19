import { handle } from "@astrojs/cloudflare/handler";
import { runScheduledMediaCleanup } from "./modules/media/scheduled-cleanup";
import type { RuntimeEnv } from "./types/env";

/**
 * 自定义 Worker 入口只增加定时清理事件；所有 HTTP 请求仍交还 Astro Cloudflare handler，
 * 避免复制或绕过现有中间件、认证、CSP 与本地预览边界。
 */
export default {
	fetch(request: Request, env: RuntimeEnv, context: ExecutionContext) {
		return handle(request, env as unknown as Env, context);
	},
	scheduled(controller: ScheduledController, env: RuntimeEnv): Promise<void> {
		return runScheduledMediaCleanup(
			{ cron: controller.cron, scheduledTime: controller.scheduledTime },
			env,
		);
	},
} satisfies ExportedHandler<RuntimeEnv>;
