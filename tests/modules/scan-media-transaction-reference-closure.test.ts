import { describe, expect, it, vi } from "vitest";
import {
	type ScanMediaTransactionReferenceClosureDependencies,
	scanMediaTransactionReferenceClosure,
} from "../../src/modules/media/services/scan-media-transaction-reference-closure";
import type { GitProvider } from "../../src/providers/git/types";
import { buildMarkdownDocument } from "../../src/utils/frontmatter-utils";

const COMMIT_SHA = "a".repeat(40);
const SOURCE_SHA = "b".repeat(40);
const DESTINATION_SHA = "c".repeat(40);
const THIRD_SHA = "d".repeat(40);
const contentRoot = "src/content/posts";
const pathConfig = { contentRoot, entryFilename: "index.md", usePageBundle: true };
const slugs = ["destination-post", "source-post", "third-post"];

function article(markdown = "正文\n", image = "") {
	return buildMarkdownDocument(
		{ title: "测试文章", published: new Date("2026-08-17T00:00:00.000Z"), image },
		markdown,
	);
}

function createDependencies(contents: Partial<Record<string, string>> = {}) {
	const listDirectoryAtCommit = vi.fn<GitProvider["listDirectoryAtCommit"]>().mockResolvedValue(
		slugs.map((storageSlug) => ({
			name: storageSlug,
			path: `${contentRoot}/${storageSlug}`,
			sha: "e".repeat(40),
			type: "directory" as const,
			size: null,
		})),
	);
	const getFileAtCommit = vi
		.fn<GitProvider["getFileAtCommit"]>()
		.mockImplementation(async (path, commitSha) => {
			expect(commitSha).toBe(COMMIT_SHA);
			const storageSlug = path.split("/").at(-2) ?? "";
			return {
				path,
				sha:
					storageSlug === "source-post"
						? SOURCE_SHA
						: storageSlug === "destination-post"
							? DESTINATION_SHA
							: THIRD_SHA,
				content: contents[storageSlug] ?? article(),
				encoding: "utf-8",
			};
		});
	const dependencies: ScanMediaTransactionReferenceClosureDependencies = {
		gitProvider: { listDirectoryAtCommit, getFileAtCommit },
		pathConfig,
	};
	return { dependencies, listDirectoryAtCommit, getFileAtCommit };
}

const request = {
	baseCommitSha: COMMIT_SHA,
	source: { storageSlug: "source-post", articleSha: SOURCE_SHA, filename: "guide.pdf" },
	destination: { storageSlug: "destination-post", articleSha: DESTINATION_SHA },
};

describe("媒体事务受控文章引用闭包扫描", () => {
	it("在同一 Commit 扫描全部受控文章并按目标 identity 收集源/目标引用", async () => {
		const provider = createDependencies({
			"source-post": article("[本地](./guide.pdf)\n"),
			"destination-post": article("[跨 Bundle](../source-post/guide.pdf)\n"),
		});
		const closure = await scanMediaTransactionReferenceClosure(request, provider.dependencies);
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledWith(contentRoot, COMMIT_SHA);
		expect(provider.getFileAtCommit).toHaveBeenCalledTimes(3);
		expect(closure).toMatchObject({
			baseCommitSha: COMMIT_SHA,
			scannedArticleCount: 3,
			source: { storageSlug: "source-post", articleSha: SOURCE_SHA },
			destination: { storageSlug: "destination-post", articleSha: DESTINATION_SHA },
		});
		expect(closure.source.references[0]).toMatchObject({
			targetStorageSlug: "source-post",
			targetFilename: "guide.pdf",
		});
		expect(closure.destination.references[0]).toMatchObject({
			targetStorageSlug: "source-post",
			targetFilename: "guide.pdf",
		});
	});

	it("第三篇受控文章引用源资源时失败关闭", async () => {
		const provider = createDependencies({
			"third-post": article("[第三方引用](../source-post/guide.pdf)\n"),
		});
		await expect(
			scanMediaTransactionReferenceClosure(request, provider.dependencies),
		).rejects.toMatchObject({ status: 422, code: "MEDIA_REFERENCE_CLOSURE_INCOMPLETE" });
	});

	it("文章快照 SHA 漂移、分析不完整和扫描预算不足均失败关闭", async () => {
		const conflict = createDependencies();
		conflict.getFileAtCommit.mockImplementation(async (path) => ({
			path,
			sha: "f".repeat(40),
			content: article(),
			encoding: "utf-8",
		}));
		await expect(
			scanMediaTransactionReferenceClosure(request, conflict.dependencies),
		).rejects.toMatchObject({ status: 409, code: "MEDIA_PREVIEW_CONFLICT" });

		const incomplete = createDependencies({
			"third-post": article("[未知语法]: ../source-post/guide.pdf\n"),
		});
		await expect(
			scanMediaTransactionReferenceClosure(request, incomplete.dependencies),
		).rejects.toMatchObject({ status: 422, code: "MEDIA_REFERENCE_CLOSURE_INCOMPLETE" });

		const overBudget = createDependencies();
		overBudget.listDirectoryAtCommit.mockResolvedValue(
			Array.from({ length: 51 }, (_, index) => {
				const storageSlug =
					index === 0 ? "source-post" : index === 1 ? "destination-post" : `post-${index}`;
				return {
					name: storageSlug,
					path: `${contentRoot}/${storageSlug}`,
					sha: "e".repeat(40),
					type: "directory" as const,
					size: null,
				};
			}),
		);
		await expect(
			scanMediaTransactionReferenceClosure(request, overBudget.dependencies),
		).rejects.toMatchObject({ status: 422, code: "MEDIA_REFERENCE_CLOSURE_INCOMPLETE" });
		expect(overBudget.getFileAtCommit).not.toHaveBeenCalled();
	});

	it("依赖契约只有 Commit 读取能力且服务不调用写方法", async () => {
		const provider = createDependencies();
		const writes = {
			getHead: vi.fn(() => Promise.reject(new Error("不得调用"))),
			commitFilesAtomically: vi.fn(() => Promise.reject(new Error("不得调用"))),
		};
		await scanMediaTransactionReferenceClosure(request, {
			...provider.dependencies,
			gitProvider: { ...provider.dependencies.gitProvider, ...writes },
		});
		expect(writes.getHead).not.toHaveBeenCalled();
		expect(writes.commitFilesAtomically).not.toHaveBeenCalled();
	});
});
