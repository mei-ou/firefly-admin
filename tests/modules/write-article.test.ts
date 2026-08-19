import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../src/core/http/errors";
import {
	createArticle,
	updateArticle,
	type WriteArticleDependencies,
} from "../../src/modules/articles/services/write-article";
import type { GitProvider } from "../../src/providers/git/types";
import { parseMarkdownDocument } from "../../src/utils/frontmatter-utils";

const HEAD_SHA = "d".repeat(40);
const FILE_SHA = "a".repeat(40);
const NEXT_FILE_SHA = "b".repeat(40);
const COMMIT_SHA = "c".repeat(40);
const repositoryPath = "src/content/posts/hello-world/index.md";
const imagePath = "src/content/posts/hello-world/cover-123e4567e89b.png";
const attachmentPath = "src/content/posts/hello-world/guide-223e4567e89b.pdf";
const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const attachmentBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const imageAsset = {
	assetId: "123e4567-e89b-12d3-a456-426614174000",
	objectKey: "staging/2026/08/123e4567-e89b-12d3-a456-426614174000.png",
	finalFilename: "cover-123e4567e89b.png",
	relativePath: "./cover-123e4567e89b.png",
	repositoryPath: imagePath,
	contentType: "image/png" as const,
	size: imageBytes.byteLength,
	role: "inline" as const,
	content: imageBytes,
};
const attachmentAsset = {
	assetId: "223e4567-e89b-12d3-a456-426614174000",
	objectKey: "staging/2026/08/223e4567-e89b-12d3-a456-426614174000.pdf",
	finalFilename: "guide-223e4567e89b.pdf",
	relativePath: "./guide-223e4567e89b.pdf",
	repositoryPath: attachmentPath,
	contentType: "application/pdf" as const,
	size: attachmentBytes.byteLength,
	role: "attachment" as const,
	content: attachmentBytes,
};
const assets = [imageAsset, attachmentAsset];
const editorInput = {
	frontmatter: {
		title: "你好，Firefly",
		published: "2026-08-12T00:00:00.000Z",
		description: "文章写入服务",
	},
	slug: "public-url",
	format: "md",
	markdown: "# 正文\n",
};

function createProvider(
	commitFilesAtomically: GitProvider["commitFilesAtomically"] = vi
		.fn<GitProvider["commitFilesAtomically"]>()
		.mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [{ path: repositoryPath, fileSha: NEXT_FILE_SHA }],
		}),
): Pick<GitProvider, "commitFilesAtomically"> {
	return { commitFilesAtomically };
}

function createCheckpoint() {
	return vi
		.fn<WriteArticleDependencies["checkpointCandidateCommit"]>()
		.mockResolvedValue(undefined);
}

describe("文章写入服务", () => {
	it("创建文章时原子提交固定路径、提交信息和安全 Markdown", async () => {
		const provider = createProvider();
		const checkpointCandidateCommit = createCheckpoint();

		const result = await createArticle("hello-world", HEAD_SHA, editorInput, {
			gitProvider: provider,
			checkpointCandidateCommit,
		});

		expect(provider.commitFilesAtomically).toHaveBeenCalledOnce();
		const call = vi.mocked(provider.commitFilesAtomically).mock.calls[0]?.[0];
		expect(call).toMatchObject({
			expectedHeadSha: HEAD_SHA,
			message: "feat(post): add hello-world",
			files: [{ path: repositoryPath, expectedSha: null }],
		});
		expect(call?.checkpointCandidateCommit).toBe(checkpointCandidateCommit);
		const firstFile = call?.files[0];
		const content = firstFile && "content" in firstFile ? firstFile.content : undefined;
		expect(typeof content).toBe("string");
		const parsed = parseMarkdownDocument(content as string);
		expect(parsed.slug).toBe("public-url");
		expect(parsed.frontmatter.title).toBe("你好，Firefly");
		expect(parsed.markdown).toBe("# 正文\n");
		expect(result).toEqual({
			storageSlug: "hello-world",
			pathAlias: "hello-world/index.md",
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			fileSha: NEXT_FILE_SHA,
		});
	});

	it("创建文章时将正文和多个已复核资源放入同一个原子提交", async () => {
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [
				{ path: repositoryPath, fileSha: NEXT_FILE_SHA },
				{ path: imagePath, fileSha: "e".repeat(40) },
				{ path: attachmentPath, fileSha: "f".repeat(40) },
			],
		});

		await createArticle("hello-world", HEAD_SHA, editorInput, {
			gitProvider: createProvider(commitFilesAtomically),
			assets,
			checkpointCandidateCommit: createCheckpoint(),
		});

		const files = commitFilesAtomically.mock.calls[0]?.[0].files;
		expect(files).toHaveLength(3);
		expect(files?.[0]).toMatchObject({ path: repositoryPath, expectedSha: null });
		expect(files?.[1]).toEqual({ path: imagePath, content: imageBytes, expectedSha: null });
		expect(files?.[2]).toEqual({
			path: attachmentPath,
			content: attachmentBytes,
			expectedSha: null,
		});
	});

	it("更新文章时原子提交读取阶段的 Head 和 Blob SHA", async () => {
		const provider = createProvider();
		const checkpointCandidateCommit = createCheckpoint();

		await updateArticle("hello-world", HEAD_SHA, FILE_SHA, editorInput, {
			gitProvider: provider,
			checkpointCandidateCommit,
		});

		expect(provider.commitFilesAtomically).toHaveBeenCalledOnce();
		const call = vi.mocked(provider.commitFilesAtomically).mock.calls[0]?.[0];
		expect(call).toMatchObject({
			expectedHeadSha: HEAD_SHA,
			message: "docs(post): update hello-world",
			files: [{ path: repositoryPath, expectedSha: FILE_SHA }],
		});
		expect(call?.checkpointCandidateCommit).toBe(checkpointCandidateCommit);
		const firstFile = call?.files[0];
		const content = firstFile && "content" in firstFile ? firstFile.content : undefined;
		expect(typeof content).toBe("string");
		const parsed = parseMarkdownDocument(content as string);
		expect(parsed.slug).toBe("public-url");
		expect(parsed.frontmatter.title).toBe("你好，Firefly");
		expect(parsed.markdown).toBe("# 正文\n");
	});

	it("封面资源与 Frontmatter image 一致时随文章进入同一次原子提交", async () => {
		const coverAsset = { ...imageAsset, role: "cover" as const };
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [
				{ path: repositoryPath, fileSha: NEXT_FILE_SHA },
				{ path: imagePath, fileSha: "e".repeat(40) },
			],
		});

		await createArticle(
			"hello-world",
			HEAD_SHA,
			{
				...editorInput,
				frontmatter: { ...editorInput.frontmatter, image: imageAsset.relativePath },
			},
			{
				gitProvider: createProvider(commitFilesAtomically),
				assets: [coverAsset],
				checkpointCandidateCommit: createCheckpoint(),
			},
		);

		expect(commitFilesAtomically.mock.calls[0]?.[0].files).toHaveLength(2);
	});

	it("封面资源与 Frontmatter image 不一致时在 Git 副作用前失败关闭", async () => {
		for (const image of ["", "https://images.example.com/cover.webp", "./other.png"]) {
			const provider = createProvider();
			await expect(
				createArticle(
					"hello-world",
					HEAD_SHA,
					{ ...editorInput, frontmatter: { ...editorInput.frontmatter, image } },
					{
						gitProvider: provider,
						assets: [{ ...imageAsset, role: "cover" as const }],
						checkpointCandidateCommit: createCheckpoint(),
					},
				),
			).rejects.toThrow("暂存封面资源与 Frontmatter image 不一致");
			expect(provider.commitFilesAtomically).not.toHaveBeenCalled();
		}
	});

	it("更新文章时保留文章 Blob 锁并将新资源作为不存在文件提交", async () => {
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [
				{ path: repositoryPath, fileSha: NEXT_FILE_SHA },
				{ path: imagePath, fileSha: "e".repeat(40) },
				{ path: attachmentPath, fileSha: "f".repeat(40) },
			],
		});

		await updateArticle("hello-world", HEAD_SHA, FILE_SHA, editorInput, {
			gitProvider: createProvider(commitFilesAtomically),
			assets,
			checkpointCandidateCommit: createCheckpoint(),
		});

		expect(commitFilesAtomically.mock.calls[0]?.[0].files).toEqual([
			expect.objectContaining({ path: repositoryPath, expectedSha: FILE_SHA }),
			{ path: imagePath, content: imageBytes, expectedSha: null },
			{ path: attachmentPath, content: attachmentBytes, expectedSha: null },
		]);
	});

	it("更新文章时把已有资源删除与入口文件放入同一次原子提交", async () => {
		const deletedPath = "src/content/posts/hello-world/old-guide.pdf";
		const deletedSha = "9".repeat(40);
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [
				{ path: repositoryPath, fileSha: NEXT_FILE_SHA },
				{ path: deletedPath, fileSha: null },
			],
		});

		await updateArticle("hello-world", HEAD_SHA, FILE_SHA, editorInput, {
			gitProvider: createProvider(commitFilesAtomically),
			resourceChanges: [
				{ operation: "delete", filename: "old-guide.pdf", expectedSha: deletedSha },
			],
			checkpointCandidateCommit: createCheckpoint(),
		});

		expect(commitFilesAtomically.mock.calls[0]?.[0].files).toEqual([
			expect.objectContaining({ path: repositoryPath, expectedSha: FILE_SHA }),
			{ operation: "delete", path: deletedPath, expectedSha: deletedSha },
		]);
	});

	it("清除已有封面只更新 Frontmatter image，不自动删除资源文件", async () => {
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [{ path: repositoryPath, fileSha: NEXT_FILE_SHA }],
		});

		await updateArticle(
			"hello-world",
			HEAD_SHA,
			FILE_SHA,
			{
				...editorInput,
				frontmatter: { ...editorInput.frontmatter, image: "" },
			},
			{
				gitProvider: createProvider(commitFilesAtomically),
				checkpointCandidateCommit: createCheckpoint(),
			},
		);

		const call = commitFilesAtomically.mock.calls[0]?.[0];
		expect(call?.files).toEqual([
			expect.objectContaining({ path: repositoryPath, expectedSha: FILE_SHA }),
		]);
		expect(call?.files.every((file) => file.operation !== "delete")).toBe(true);
		const articleFile = call?.files[0];
		const content = articleFile && "content" in articleFile ? articleFile.content : "";
		expect(content).toContain('image: ""');
	});

	it("拒绝在同次提交中删除或移动当前封面", async () => {
		for (const resourceChange of [
			{ operation: "delete" as const, filename: "cover.png", expectedSha: FILE_SHA },
			{
				operation: "move" as const,
				filename: "cover.png",
				destinationFilename: "renamed.png",
				expectedSha: FILE_SHA,
			},
		]) {
			const provider = createProvider();
			await expect(
				updateArticle(
					"hello-world",
					HEAD_SHA,
					FILE_SHA,
					{
						...editorInput,
						frontmatter: { ...editorInput.frontmatter, image: "./cover.png" },
					},
					{
						gitProvider: provider,
						resourceChanges: [resourceChange],
						checkpointCandidateCommit: createCheckpoint(),
					},
				),
			).rejects.toThrow("当前封面不能在同一次提交中删除或移动");
			expect(provider.commitFilesAtomically).not.toHaveBeenCalled();
		}
	});

	it("使用已复核 R2 字节替换旧路径，并且不把替换对象另建为新资源", async () => {
		const existingPath = "src/content/posts/hello-world/cover.png";
		const existingSha = "9".repeat(40);
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [
				{ path: repositoryPath, fileSha: NEXT_FILE_SHA },
				{ path: existingPath, fileSha: "8".repeat(40) },
			],
		});

		await updateArticle("hello-world", HEAD_SHA, FILE_SHA, editorInput, {
			gitProvider: createProvider(commitFilesAtomically),
			assets: [imageAsset],
			resourceChanges: [
				{
					operation: "replace",
					filename: "cover.png",
					expectedSha: existingSha,
					assetId: imageAsset.assetId,
				},
			],
			checkpointCandidateCommit: createCheckpoint(),
		});

		expect(commitFilesAtomically.mock.calls[0]?.[0].files).toEqual([
			expect.objectContaining({ path: repositoryPath, expectedSha: FILE_SHA }),
			{ operation: "write", path: existingPath, content: imageBytes, expectedSha: existingSha },
		]);
	});

	it("拒绝替换对象缺失或扩展名不兼容且不调用 Provider", async () => {
		for (const [filename, suppliedAssets] of [
			["cover.png", []],
			["cover.pdf", [imageAsset]],
		] as const) {
			const provider = createProvider();
			await expect(
				updateArticle("hello-world", HEAD_SHA, FILE_SHA, editorInput, {
					gitProvider: provider,
					assets: suppliedAssets,
					resourceChanges: [
						{
							operation: "replace",
							filename,
							expectedSha: FILE_SHA,
							assetId: imageAsset.assetId,
						},
					],
					checkpointCandidateCommit: createCheckpoint(),
				}),
			).rejects.toThrow();
			expect(provider.commitFilesAtomically).not.toHaveBeenCalled();
		}
	});

	it("把同 Bundle 重命名表达为目标复用和源删除两条原子变更", async () => {
		const sourcePath = "src/content/posts/hello-world/old-guide.pdf";
		const destinationPath = "src/content/posts/hello-world/new-guide.pdf";
		const sourceSha = "9".repeat(40);
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [
				{ path: repositoryPath, fileSha: NEXT_FILE_SHA },
				{ path: destinationPath, fileSha: sourceSha },
				{ path: sourcePath, fileSha: null },
			],
		});

		await updateArticle("hello-world", HEAD_SHA, FILE_SHA, editorInput, {
			gitProvider: createProvider(commitFilesAtomically),
			resourceChanges: [
				{
					operation: "move",
					filename: "old-guide.pdf",
					destinationFilename: "new-guide.pdf",
					expectedSha: sourceSha,
				},
			],
			checkpointCandidateCommit: createCheckpoint(),
		});

		expect(commitFilesAtomically.mock.calls[0]?.[0].files).toEqual([
			expect.objectContaining({ path: repositoryPath, expectedSha: FILE_SHA }),
			{ operation: "reuse", path: destinationPath, expectedSha: null, fileSha: sourceSha },
			{ operation: "delete", path: sourcePath, expectedSha: sourceSha },
		]);
	});

	it("拒绝移动到入口文件或新资源路径且不调用 Provider", async () => {
		for (const [destinationFilename, suppliedAssets] of [
			["index.md", []],
			[imageAsset.finalFilename, [imageAsset]],
		] as const) {
			const provider = createProvider();
			await expect(
				updateArticle("hello-world", HEAD_SHA, FILE_SHA, editorInput, {
					gitProvider: provider,
					assets: suppliedAssets,
					resourceChanges: [
						{
							operation: "move",
							filename: "old-guide.pdf",
							destinationFilename,
							expectedSha: FILE_SHA,
						},
					],
					checkpointCandidateCommit: createCheckpoint(),
				}),
			).rejects.toThrow();
			expect(provider.commitFilesAtomically).not.toHaveBeenCalled();
		}
	});

	it("拒绝删除入口文件或与新资源重名且不调用 Provider", async () => {
		for (const resourceChanges of [
			[{ operation: "delete" as const, filename: "index.md", expectedSha: FILE_SHA }],
			[
				{
					operation: "delete" as const,
					filename: imageAsset.finalFilename,
					expectedSha: FILE_SHA,
				},
			],
		]) {
			const provider = createProvider();
			await expect(
				updateArticle("hello-world", HEAD_SHA, FILE_SHA, editorInput, {
					gitProvider: provider,
					assets: resourceChanges[0]?.filename === imageAsset.finalFilename ? [imageAsset] : [],
					resourceChanges,
					checkpointCandidateCommit: createCheckpoint(),
				}),
			).rejects.toThrow();
			expect(provider.commitFilesAtomically).not.toHaveBeenCalled();
		}
	});

	it("拒绝缺失或无效的 Head 和 Blob SHA，且不调用 Provider", async () => {
		for (const invalidSha of [undefined, "", "not-a-sha", "A".repeat(40)]) {
			const createProviderMock = createProvider();
			await expect(
				createArticle("hello-world", invalidSha, editorInput, {
					gitProvider: createProviderMock,
					checkpointCandidateCommit: createCheckpoint(),
				}),
			).rejects.toThrow("版本 SHA 无效");
			expect(createProviderMock.commitFilesAtomically).not.toHaveBeenCalled();

			const updateProviderMock = createProvider();
			await expect(
				updateArticle("hello-world", HEAD_SHA, invalidSha, editorInput, {
					gitProvider: updateProviderMock,
					checkpointCandidateCommit: createCheckpoint(),
				}),
			).rejects.toThrow("版本 SHA 无效");
			expect(updateProviderMock.commitFilesAtomically).not.toHaveBeenCalled();
		}
	});

	it("拒绝客户端完整仓库路径和非法文章输入", async () => {
		const provider = createProvider();
		const dependencies = {
			gitProvider: provider,
			checkpointCandidateCommit: createCheckpoint(),
		};
		await expect(
			createArticle("src/content/posts/hello-world/index.md", HEAD_SHA, editorInput, dependencies),
		).rejects.toThrow("Slug 校验失败");
		await expect(
			createArticle(
				"hello-world",
				HEAD_SHA,
				{ ...editorInput, repositoryPath: "README.md" },
				dependencies,
			),
		).rejects.toThrow();
		expect(provider.commitFilesAtomically).not.toHaveBeenCalled();
	});

	it("拒绝 MDX 和构建内部字段进入仓库", async () => {
		for (const invalidInput of [
			{ ...editorInput, format: "mdx" },
			{
				...editorInput,
				frontmatter: { ...editorInput.frontmatter, prevSlug: "secret" },
			},
		]) {
			const provider = createProvider();
			await expect(
				createArticle("hello-world", HEAD_SHA, invalidInput, {
					gitProvider: provider,
					checkpointCandidateCommit: createCheckpoint(),
				}),
			).rejects.toThrow();
			expect(provider.commitFilesAtomically).not.toHaveBeenCalled();
		}
	});

	it("拒绝 Provider 返回其他仓库路径", async () => {
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [{ path: "README.md", fileSha: NEXT_FILE_SHA }],
		});

		await expect(
			createArticle("hello-world", HEAD_SHA, editorInput, {
				gitProvider: createProvider(commitFilesAtomically),
				checkpointCandidateCommit: createCheckpoint(),
			}),
		).rejects.toMatchObject({ status: 502, code: "UPSTREAM_ERROR" });
	});

	it("拒绝已复核资源内部路径不一致且不调用 Provider", async () => {
		const provider = createProvider();
		await expect(
			createArticle("hello-world", HEAD_SHA, editorInput, {
				gitProvider: provider,
				assets: [{ ...imageAsset, repositoryPath: "src/content/posts/other/cover.png" }],
				checkpointCandidateCommit: createCheckpoint(),
			}),
		).rejects.toThrow("资源仓库路径无效");
		expect(provider.commitFilesAtomically).not.toHaveBeenCalled();
	});

	it("Provider 少返回任一资源路径时失败关闭", async () => {
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [
				{ path: repositoryPath, fileSha: NEXT_FILE_SHA },
				{ path: imagePath, fileSha: "e".repeat(40) },
			],
		});

		await expect(
			createArticle("hello-world", HEAD_SHA, editorInput, {
				gitProvider: createProvider(commitFilesAtomically),
				assets,
				checkpointCandidateCommit: createCheckpoint(),
			}),
		).rejects.toMatchObject({ status: 502, code: "UPSTREAM_ERROR" });
	});

	it("保留 Provider 返回的并发冲突", async () => {
		const commitFilesAtomically = vi
			.fn<GitProvider["commitFilesAtomically"]>()
			.mockRejectedValue(new ApiError(409, "CONFLICT", "远端文件已经变化，请重新加载后再提交。"));

		await expect(
			updateArticle("hello-world", HEAD_SHA, FILE_SHA, editorInput, {
				gitProvider: createProvider(commitFilesAtomically),
				checkpointCandidateCommit: createCheckpoint(),
			}),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		expect(commitFilesAtomically).toHaveBeenCalledOnce();
	});

	it("支持受信任的自定义内容目录配置", async () => {
		const customPath = "content/blog/hello-world/post.md";
		const commitFilesAtomically = vi.fn<GitProvider["commitFilesAtomically"]>().mockResolvedValue({
			commitSha: COMMIT_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
			files: [{ path: customPath, fileSha: NEXT_FILE_SHA }],
		});

		await createArticle("hello-world", HEAD_SHA, editorInput, {
			gitProvider: createProvider(commitFilesAtomically),
			checkpointCandidateCommit: createCheckpoint(),
			pathConfig: {
				contentRoot: "content/blog",
				usePageBundle: true,
				entryFilename: "post.md",
			},
		});

		expect(commitFilesAtomically).toHaveBeenCalledWith(
			expect.objectContaining({
				expectedHeadSha: HEAD_SHA,
				files: [expect.objectContaining({ path: customPath, expectedSha: null })],
			}),
		);
	});
});
