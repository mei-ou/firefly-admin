import { describe, expect, it, vi } from "vitest";
import {
	listRepositoryDirectory,
	parseRepositoryDirectoryPath,
} from "../../src/modules/repository/services/list-repository-directory";
import type { GitProvider } from "../../src/providers/git/types";

const SHA = "a".repeat(40);

describe("只读仓库目录服务", () => {
	it("接受根目录并将目录排在文件前面", async () => {
		const listDirectory = vi.fn<GitProvider["listDirectory"]>().mockResolvedValue([
			{ name: "README.md", path: "README.md", sha: SHA, type: "file", size: 1_024 },
			{ name: "src", path: "src", sha: SHA, type: "directory", size: null },
		]);
		await expect(listRepositoryDirectory("", { gitProvider: { listDirectory } })).resolves.toEqual({
			path: "",
			parentPath: null,
			entries: [
				{ name: "src", path: "src", sha: SHA, type: "directory", size: null },
				{ name: "README.md", path: "README.md", sha: SHA, type: "file", size: 1_024 },
			],
		});
	});

	it("计算父目录并拒绝穿越、编码和绝对路径", async () => {
		expect(parseRepositoryDirectoryPath("src/content/posts")).toBe("src/content/posts");
		for (const path of ["/src", "src/../secret", "src%2Fsecret", "src\\secret", "src/"]) {
			expect(() => parseRepositoryDirectoryPath(path)).toThrow();
		}
		const listDirectory = vi.fn<GitProvider["listDirectory"]>().mockResolvedValue([]);
		await expect(
			listRepositoryDirectory("src/content/posts", { gitProvider: { listDirectory } }),
		).resolves.toMatchObject({ parentPath: "src/content" });
	});
});
