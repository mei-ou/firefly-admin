import { describe, expect, it, vi } from "vitest";
import { handleGetMediaTransactionTargets } from "../../src/modules/media/api/get-media-transaction-targets";
import type { RuntimeEnv } from "../../src/types/env";

const HEAD_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const principal = { sub: "subject-1", email: "admin@example.com" };

function createRequest(): Request {
	return new Request(
		`https://admin.example.com/api/media/transactions/targets?expectedHeadSha=${HEAD_SHA}&sourceStorageSlug=source-post&sourceArticleSha=${SOURCE_SHA}`,
	);
}

/** 跨文章移动尚未发布，目标快照 API 必须在扫描 Git 前硬锁。 */
describe("媒体事务目标快照 API 能力硬锁", () => {
	it("默认返回 404 且不执行限流、Provider 或审计", async () => {
		const limiter = { limit: vi.fn() };
		const createRepositoryFactory = vi.fn();
		const auditWriter = vi.fn();
		await expect(
			handleGetMediaTransactionTargets(
				{
					request: createRequest(),
					requestId: "req-targets",
					principal,
					env: { RATE_LIMITER: limiter },
				},
				{ createRepositoryFactory, auditWriter },
			),
		).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
		expect(limiter.limit).not.toHaveBeenCalled();
		expect(createRepositoryFactory).not.toHaveBeenCalled();
		expect(auditWriter).not.toHaveBeenCalled();
	});

	it("伪造环境变量也不能越过 unreleased 发布状态", async () => {
		const createRepositoryFactory = vi.fn();
		await expect(
			handleGetMediaTransactionTargets(
				{
					request: createRequest(),
					requestId: "req-targets-forged",
					principal: undefined,
					env: { FEATURE_CROSS_ARTICLE_ASSET_MOVE: "true" } as RuntimeEnv,
				},
				{ createRepositoryFactory },
			),
		).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
		expect(createRepositoryFactory).not.toHaveBeenCalled();
	});
});
