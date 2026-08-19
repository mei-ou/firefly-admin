import { describe, expect, it, vi } from "vitest";
import { cleanupExpiredStagedMedia } from "../../src/modules/media/services/cleanup-staged-media";
import type { R2ObjectBinding } from "../../src/types/env";

const now = new Date("2026-08-14T03:17:00.000Z");

function createObject(key: string, uploaded: string): R2ObjectBinding {
	return {
		key,
		size: 8,
		etag: "etag-1",
		uploaded: new Date(uploaded),
	};
}

describe("R2 暂存图片过期清理", () => {
	it("只批量删除完整匹配且已过期的暂存图片", async () => {
		const list = vi.fn().mockResolvedValue({
			objects: [
				createObject(
					"staging/2026/08/123e4567-e89b-12d3-a456-426614174000.png",
					"2026-08-01T00:00:00.000Z",
				),
				createObject(
					"staging/2026/08/623e4567-e89b-12d3-a456-426614174000.jpg",
					"2026-08-02T00:00:00.000Z",
				),
				createObject(
					"staging/2026/08/223e4567-e89b-12d3-a456-426614174000.webp",
					"2026-08-14T00:00:00.000Z",
				),
				createObject("staging/manual-do-not-delete.txt", "2026-08-01T00:00:00.000Z"),
			],
			truncated: false,
		});
		const deleteObjects = vi.fn().mockResolvedValue(undefined);

		await expect(
			cleanupExpiredStagedMedia(
				{ list, delete: deleteObjects },
				{ now, retentionMs: 7 * 24 * 60 * 60 * 1_000 },
			),
		).resolves.toEqual({ deleted: 2, ignored: 2, pages: 1 });
		expect(list).toHaveBeenCalledWith({ prefix: "staging/", limit: 100 });
		expect(deleteObjects).toHaveBeenCalledTimes(1);
		expect(deleteObjects).toHaveBeenCalledWith([
			"staging/2026/08/123e4567-e89b-12d3-a456-426614174000.png",
			"staging/2026/08/623e4567-e89b-12d3-a456-426614174000.jpg",
		]);
	});

	it("严格按照 truncated 和 cursor 分页并清理后续页面", async () => {
		const list = vi
			.fn()
			.mockResolvedValueOnce({ objects: [], truncated: true, cursor: "cursor-2" })
			.mockResolvedValueOnce({
				objects: [
					createObject(
						"staging/2026/07/323e4567-e89b-12d3-a456-426614174000.webp",
						"2026-07-01T00:00:00.000Z",
					),
				],
				truncated: false,
			});
		const deleteObjects = vi.fn().mockResolvedValue(undefined);

		await expect(
			cleanupExpiredStagedMedia({ list, delete: deleteObjects }, { now }),
		).resolves.toEqual({ deleted: 1, ignored: 0, pages: 2 });
		expect(list).toHaveBeenNthCalledWith(2, {
			prefix: "staging/",
			limit: 100,
			cursor: "cursor-2",
		});
	});

	it("无效分页游标、配置和 R2 删除失败时失败关闭", async () => {
		const invalidCursorList = vi.fn().mockResolvedValue({
			objects: [
				createObject(
					"staging/2026/07/523e4567-e89b-12d3-a456-426614174000.png",
					"2026-07-01T00:00:00.000Z",
				),
			],
			truncated: true,
		});
		const invalidCursorDelete = vi.fn();
		await expect(
			cleanupExpiredStagedMedia({ list: invalidCursorList, delete: invalidCursorDelete }, { now }),
		).rejects.toThrow("无效分页游标");
		expect(invalidCursorDelete).not.toHaveBeenCalled();
		await expect(
			cleanupExpiredStagedMedia({ list: vi.fn(), delete: vi.fn() }, { now, batchSize: 0 }),
		).rejects.toThrow("清理批次大小");

		const deleteFailure = vi.fn().mockRejectedValue(new Error("R2 unavailable"));
		await expect(
			cleanupExpiredStagedMedia(
				{
					list: vi.fn().mockResolvedValue({
						objects: [
							createObject(
								"staging/2026/07/423e4567-e89b-12d3-a456-426614174000.jpg",
								"2026-07-01T00:00:00.000Z",
							),
						],
						truncated: false,
					}),
					delete: deleteFailure,
				},
				{ now },
			),
		).rejects.toThrow("R2 unavailable");
	});
});
