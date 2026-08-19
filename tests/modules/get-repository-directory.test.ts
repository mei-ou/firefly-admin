import { describe, expect, it, vi } from "vitest";
import { handleGetRepositoryDirectory } from "../../src/modules/repository/api/get-repository-directory";
import type { RuntimeEnv } from "../../src/types/env";

const principal = { sub: "subject-1", email: "admin@example.com" };

/** 未发布的仓库浏览必须在认证、query、限流和 Provider 初始化之前失败关闭。 */
describe("仓库目录 API 能力硬锁", () => {
	it("默认返回 404 且不执行任何下游副作用", async () => {
		const limiter = { limit: vi.fn() };
		const createRepositoryFactory = vi.fn();
		const env: RuntimeEnv = { RATE_LIMITER: limiter };

		await expect(
			handleGetRepositoryDirectory(
				{
					request: new Request(
						"https://admin.example.com/api/repository/tree?path=src%2F..%2Fsecret",
					),
					principal,
					env,
				},
				{ createRepositoryFactory },
			),
		).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
		expect(limiter.limit).not.toHaveBeenCalled();
		expect(createRepositoryFactory).not.toHaveBeenCalled();
	});

	it("环境变量不能解锁 unreleased 能力", async () => {
		const createRepositoryFactory = vi.fn();
		await expect(
			handleGetRepositoryDirectory(
				{
					request: new Request("https://admin.example.com/api/repository/tree"),
					principal: undefined,
					env: { FEATURE_REPOSITORY_BROWSER: "true" } as RuntimeEnv,
				},
				{ createRepositoryFactory },
			),
		).rejects.toMatchObject({ status: 404, code: "NOT_FOUND" });
		expect(createRepositoryFactory).not.toHaveBeenCalled();
	});
});
