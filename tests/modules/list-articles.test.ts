import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import {
	ARTICLE_LIST_MAX_SCAN,
	listArticles,
} from "../../src/modules/articles/services/list-articles";
import type { GitDirectoryEntry, GitProvider } from "../../src/providers/git/types";
import { buildMarkdownDocument } from "../../src/utils/frontmatter-utils";

const FILE_SHA = "a".repeat(40);
const contentRoot = "src/content/posts";

function directoryEntry(storageSlug: string): GitDirectoryEntry {
	return {
		name: storageSlug,
		path: `${contentRoot}/${storageSlug}`,
		sha: FILE_SHA,
		type: "directory",
		size: null,
	};
}

function articleDocument(
	title: string,
	published: string,
	overrides: Record<string, unknown> = {},
): string {
	return buildMarkdownDocument(
		{
			title,
			published: new Date(published),
			description: `${title} description`,
			tags: [title],
			...overrides,
		},
		"正文",
	);
}

function createProvider(
	entries: GitDirectoryEntry[],
	contentBySlug: Record<string, string>,
): Pick<GitProvider, "listDirectory" | "getFile"> & {
	listDirectory: ReturnType<typeof vi.fn<GitProvider["listDirectory"]>>;
	getFile: ReturnType<typeof vi.fn<GitProvider["getFile"]>>;
} {
	const listDirectory = vi.fn<GitProvider["listDirectory"]>().mockResolvedValue(entries);
	const getFile = vi.fn<GitProvider["getFile"]>().mockImplementation(async (path) => {
		const segments = path.split("/");
		const storageSlug = segments.at(-2) ?? "";
		const content = contentBySlug[storageSlug];
		if (content === undefined) {
			throw new ApiError(404, "NOT_FOUND", "远端文件不存在。");
		}
		return { path, sha: FILE_SHA, encoding: "utf-8", content };
	});
	return { listDirectory, getFile };
}

describe("文章列表服务", () => {
	it("只扫描合法直接子目录，并按置顶和发布日期排序", async () => {
		const provider = createProvider(
			[
				directoryEntry("older-post"),
				directoryEntry("newer-post"),
				directoryEntry("pinned-post"),
				{
					name: "README.md",
					path: `${contentRoot}/README.md`,
					sha: FILE_SHA,
					type: "file",
					size: 1_024,
				},
				{
					name: "Invalid_Slug",
					path: `${contentRoot}/Invalid_Slug`,
					sha: FILE_SHA,
					type: "directory",
					size: null,
				},
			],
			{
				"older-post": articleDocument("Older", "2026-01-01T00:00:00.000Z"),
				"newer-post": articleDocument("Newer", "2026-03-01T00:00:00.000Z"),
				"pinned-post": articleDocument("Pinned", "2025-01-01T00:00:00.000Z", { pinned: true }),
			},
		);

		const result = await listArticles({}, { gitProvider: provider });

		expect(provider.listDirectory).toHaveBeenCalledWith(contentRoot);
		expect(provider.getFile).toHaveBeenCalledTimes(3);
		expect(result.items.map((article) => article.storageSlug)).toEqual([
			"pinned-post",
			"newer-post",
			"older-post",
		]);
		expect(result).toMatchObject({
			total: 3,
			candidateCount: 3,
			scanned: 3,
			skipped: 0,
			truncated: false,
		});
	});

	it("隔离单篇缺失或格式损坏的文章", async () => {
		const provider = createProvider(
			[directoryEntry("good-post"), directoryEntry("broken-post"), directoryEntry("missing-post")],
			{
				"good-post": articleDocument("Good", "2026-01-01T00:00:00.000Z"),
				"broken-post": "---\ntitle: broken\n---\n正文",
			},
		);

		const result = await listArticles({}, { gitProvider: provider });

		expect(result.items.map((article) => article.storageSlug)).toEqual(["good-post"]);
		expect(result).toMatchObject({ scanned: 3, skipped: 2, total: 1 });
	});

	it("在受限扫描结果上执行不区分大小写的搜索和分页", async () => {
		const provider = createProvider(
			[directoryEntry("alpha-post"), directoryEntry("beta-post"), directoryEntry("gamma-post")],
			{
				"alpha-post": articleDocument("Alpha Guide", "2026-03-01T00:00:00.000Z", {
					tags: ["SECURITY"],
				}),
				"beta-post": articleDocument("Beta Guide", "2026-02-01T00:00:00.000Z", {
					tags: ["security"],
				}),
				"gamma-post": articleDocument("Gamma", "2026-01-01T00:00:00.000Z"),
			},
		);

		const result = await listArticles(
			{ query: "Security", page: "2", pageSize: "1" },
			{ gitProvider: provider },
		);

		expect(result.items.map((article) => article.storageSlug)).toEqual(["beta-post"]);
		expect(result).toMatchObject({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
	});

	it("在读取前应用固定扫描上限并明确返回截断状态", async () => {
		const entries = Array.from({ length: ARTICLE_LIST_MAX_SCAN + 1 }, (_, index) =>
			directoryEntry(`post-${index}`),
		);
		const contentBySlug = Object.fromEntries(
			entries.map((entry, index) => [
				entry.name,
				articleDocument(
					entry.name,
					`2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
				),
			]),
		);
		const provider = createProvider(entries, contentBySlug);

		const result = await listArticles({}, { gitProvider: provider });

		expect(provider.getFile).toHaveBeenCalledTimes(ARTICLE_LIST_MAX_SCAN);
		expect(result).toMatchObject({
			candidateCount: ARTICLE_LIST_MAX_SCAN + 1,
			scanned: ARTICLE_LIST_MAX_SCAN,
			truncated: true,
		});
	});

	it("将并发读取限制在固定上限内", async () => {
		const entries = Array.from({ length: 12 }, (_, index) => directoryEntry(`post-${index}`));
		const listDirectory = vi.fn<GitProvider["listDirectory"]>().mockResolvedValue(entries);
		let activeReads = 0;
		let maximumActiveReads = 0;
		const getFile = vi.fn<GitProvider["getFile"]>().mockImplementation(async (path) => {
			activeReads += 1;
			maximumActiveReads = Math.max(maximumActiveReads, activeReads);
			await Promise.resolve();
			await Promise.resolve();
			activeReads -= 1;
			const storageSlug = path.split("/").at(-2) ?? "";
			return {
				path,
				sha: FILE_SHA,
				encoding: "utf-8",
				content: articleDocument(storageSlug, "2026-01-01T00:00:00.000Z"),
			};
		});

		await listArticles({}, { gitProvider: { listDirectory, getFile } });

		expect(maximumActiveReads).toBe(5);
	});

	it("拒绝放大扫描和并发上限的服务配置", async () => {
		const provider = createProvider([], {});

		await expect(
			listArticles({}, { gitProvider: provider, maxScan: ARTICLE_LIST_MAX_SCAN + 1 }),
		).rejects.toThrow("文章列表服务配置无效");
		await expect(listArticles({}, { gitProvider: provider, readConcurrency: 6 })).rejects.toThrow(
			"文章列表服务配置无效",
		);
		expect(provider.listDirectory).not.toHaveBeenCalled();
	});

	it("根目录列表失败时保持失败关闭", async () => {
		const listDirectory = vi
			.fn<GitProvider["listDirectory"]>()
			.mockRejectedValue(new ApiError(503, "UPSTREAM_UNAVAILABLE", "Git 服务暂时不可用。"));
		const getFile = vi.fn<GitProvider["getFile"]>();

		await expect(
			listArticles({}, { gitProvider: { listDirectory, getFile } }),
		).rejects.toMatchObject({
			status: 503,
			code: "UPSTREAM_UNAVAILABLE",
		});
		expect(getFile).not.toHaveBeenCalled();
	});
});
