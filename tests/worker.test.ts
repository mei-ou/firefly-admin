import { describe, expect, it, vi } from "vitest";
import { runScheduledMediaCleanup } from "../src/modules/media/scheduled-cleanup";
import type { R2BucketBinding, RuntimeEnv } from "../src/types/env";

const input = {
	cron: "17 3 * * *",
	scheduledTime: Date.parse("2026-08-14T03:17:00.000Z"),
};

function createBucket(overrides: Partial<R2BucketBinding> = {}): R2BucketBinding {
	return {
		put: vi.fn(),
		get: vi.fn().mockResolvedValue(null),
		list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
		delete: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
}

describe("Cloudflare 定时媒体清理入口", () => {
	it("成功清理后写入不含敏感内容的系统审计", async () => {
		const auditWriter = vi.fn();
		await expect(
			runScheduledMediaCleanup(
				input,
				{ MEDIA_STAGING_BUCKET: createBucket() } satisfies RuntimeEnv,
				auditWriter,
			),
		).resolves.toBeUndefined();
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "media.cleanup-expired-staging",
				outcome: "success",
				subject: "system:scheduled",
				metadata: expect.objectContaining({ deleted: 0, pages: 1 }),
			}),
		);
	});

	it("缺少 R2 或清理失败时审计并重新抛出", async () => {
		const auditWriter = vi.fn();
		await expect(
			runScheduledMediaCleanup(input, {} satisfies RuntimeEnv, auditWriter),
		).rejects.toThrow("未配置");
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "failure", errorCode: "CONFIGURATION_ERROR" }),
		);

		auditWriter.mockClear();
		await expect(
			runScheduledMediaCleanup(
				input,
				{
					MEDIA_STAGING_BUCKET: createBucket({
						list: vi.fn().mockRejectedValue(new Error("R2 unavailable")),
					}),
				} satisfies RuntimeEnv,
				auditWriter,
			),
		).rejects.toThrow("R2 unavailable");
		expect(auditWriter).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "failure", errorCode: "UPSTREAM_UNAVAILABLE" }),
		);
	});
});
