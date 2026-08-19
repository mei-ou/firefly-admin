import { type AuditWriter, writeAuditEvent } from "../../core/audit/audit-log";
import type { RuntimeEnv } from "../../types/env";
import { cleanupExpiredStagedMedia } from "./services/cleanup-staged-media";

export interface ScheduledCleanupInput {
	cron: string;
	scheduledTime: number;
}

/** 定时入口保持为薄编排层，便于在 Node 测试中验证失败关闭和审计，不依赖 Worker loader。 */
export async function runScheduledMediaCleanup(
	input: ScheduledCleanupInput,
	env: RuntimeEnv,
	auditWriter?: AuditWriter,
): Promise<void> {
	const timestamp = new Date(input.scheduledTime).toISOString();
	if (!env.MEDIA_STAGING_BUCKET) {
		writeAuditEvent(
			{
				requestId: `scheduled:${input.scheduledTime}`,
				subject: "system:scheduled",
				action: "media.cleanup-expired-staging",
				outcome: "failure",
				timestamp,
				errorCode: "CONFIGURATION_ERROR",
				metadata: { cron: input.cron },
			},
			auditWriter,
		);
		throw new Error("媒体暂存服务未配置，定时清理失败关闭。");
	}

	try {
		const result = await cleanupExpiredStagedMedia(env.MEDIA_STAGING_BUCKET, {
			now: new Date(input.scheduledTime),
		});
		writeAuditEvent(
			{
				requestId: `scheduled:${input.scheduledTime}`,
				subject: "system:scheduled",
				action: "media.cleanup-expired-staging",
				outcome: "success",
				timestamp,
				metadata: { cron: input.cron, ...result },
			},
			auditWriter,
		);
	} catch (error) {
		writeAuditEvent(
			{
				requestId: `scheduled:${input.scheduledTime}`,
				subject: "system:scheduled",
				action: "media.cleanup-expired-staging",
				outcome: "failure",
				timestamp,
				errorCode: "UPSTREAM_UNAVAILABLE",
				metadata: {
					cron: input.cron,
					errorName: error instanceof Error ? error.name : "UnknownError",
				},
			},
			auditWriter,
		);
		throw error;
	}
}
