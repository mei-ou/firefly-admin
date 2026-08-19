import { describe, expect, it, vi } from "vitest";
import { previewMediaTransaction } from "../../src/modules/media/services/preview-media-transaction";
import type { GitProvider } from "../../src/providers/git/types";

const HEAD_SHA = "a".repeat(40);
const ARTICLE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const pathConfig = {
	contentRoot: "src/content/posts",
	entryFilename: "index.md",
	usePageBundle: true,
};
const bundlePath = "src/content/posts/hello-world";
const articlePath = `${bundlePath}/index.md`;
const sourcePath = `${bundlePath}/old-guide.pdf`;
const destinationPath = `${bundlePath}/new-guide.pdf`;
const MOVE_DESTINATION_SHA = "d".repeat(40);
const moveSourceBundlePath = "src/content/posts/source-post";
const moveDestinationBundlePath = "src/content/posts/destination-post";
const moveSourceArticlePath = `${moveSourceBundlePath}/index.md`;
const moveDestinationArticlePath = `${moveDestinationBundlePath}/index.md`;

function buildArticle(image = "", markdown = "正文\n") {
	return `---
title: 测试文章
published: 2026-08-17T00:00:00.000Z
draft: true
description: ""
image: "${image}"
tags: []
category: null
lang: zh_CN
pinned: false
author: ""
sourceLink: ""
licenseName: ""
licenseUrl: ""
comment: true
password: ""
passwordHint: ""
---
${markdown}`;
}

function createRequest() {
	return {
		version: 1,
		operation: "rename",
		storageSlug: "hello-world",
		sourceFilename: "old-guide.pdf",
		destinationFilename: "new-guide.pdf",
		expectedHeadSha: HEAD_SHA,
		expectedArticleSha: ARTICLE_SHA,
		expectedBlobSha: BLOB_SHA,
	};
}

function createProvider(options: {
	article?: string;
	headSha?: string;
	articleSha?: string;
	blobSha?: string;
	includeDestination?: boolean;
}) {
	const getHead = vi.fn<GitProvider["getHead"]>().mockResolvedValue({
		commitSha: options.headSha ?? HEAD_SHA,
		commitUrl: `https://github.com/owner/repo/commit/${HEAD_SHA}`,
		treeSha: "d".repeat(40),
	});
	const getFileAtCommit = vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
		path: articlePath,
		sha: options.articleSha ?? ARTICLE_SHA,
		content: options.article ?? buildArticle(),
		encoding: "utf-8",
	});
	const listDirectoryAtCommit = vi.fn<GitProvider["listDirectoryAtCommit"]>().mockResolvedValue([
		{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file", size: 100 },
		{
			name: "old-guide.pdf",
			path: sourcePath,
			sha: options.blobSha ?? BLOB_SHA,
			type: "file",
			size: 1024,
		},
		...(options.includeDestination
			? [
					{
						name: "new-guide.pdf",
						path: destinationPath,
						sha: "e".repeat(40),
						type: "file" as const,
						size: 2048,
					},
				]
			: []),
	]);
	return { getHead, getFileAtCommit, listDirectoryAtCommit };
}

const dependencies = (provider: ReturnType<typeof createProvider>) => ({
	gitProvider: provider,
	pathConfig,
	now: () => Date.parse("2026-08-17T01:00:00.000Z"),
	createPreviewId: () => "preview_1234567890abcdef",
});

function createMoveRequest(filename = "guide.png") {
	return {
		version: 1,
		operation: "move",
		expectedHeadSha: HEAD_SHA,
		source: {
			storageSlug: "source-post",
			filename,
			expectedArticleSha: ARTICLE_SHA,
			expectedBlobSha: BLOB_SHA,
		},
		destination: {
			storageSlug: "destination-post",
			filename: `moved-${filename}`,
			expectedArticleSha: MOVE_DESTINATION_SHA,
		},
	};
}

function createMoveProvider(options: {
	sourceArticle?: string;
	destinationArticle?: string;
	sourceArticleSha?: string;
	destinationArticleSha?: string;
	blobSha?: string;
	filename?: string;
	includeDestination?: boolean;
	sourceEntryType?: "file" | "directory";
	destinationEntryType?: "file" | "directory";
}) {
	const filename = options.filename ?? "guide.png";
	const destinationFilename = `moved-${filename}`;
	const sourceArticle = options.sourceArticle ?? buildArticle();
	const destinationArticle = options.destinationArticle ?? buildArticle();
	const getHead = vi.fn<GitProvider["getHead"]>().mockResolvedValue({
		commitSha: HEAD_SHA,
		treeSha: "e".repeat(40),
	});
	const getFileAtCommit = vi
		.fn<GitProvider["getFileAtCommit"]>()
		.mockImplementation(async (path, commitSha) => {
			expect(commitSha).toBe(HEAD_SHA);
			const source = path === moveSourceArticlePath;
			return {
				path,
				sha: source
					? (options.sourceArticleSha ?? ARTICLE_SHA)
					: (options.destinationArticleSha ?? MOVE_DESTINATION_SHA),
				content: source ? sourceArticle : destinationArticle,
				encoding: "utf-8",
			};
		});
	const listDirectoryAtCommit = vi
		.fn<GitProvider["listDirectoryAtCommit"]>()
		.mockImplementation(async (path, commitSha) => {
			expect(commitSha).toBe(HEAD_SHA);
			if (path === moveSourceBundlePath) {
				return [
					{
						name: "index.md",
						path: moveSourceArticlePath,
						sha: options.sourceArticleSha ?? ARTICLE_SHA,
						type: "file",
						size: 100,
					},
					{
						name: filename,
						path: `${moveSourceBundlePath}/${filename}`,
						sha: options.blobSha ?? BLOB_SHA,
						type: options.sourceEntryType ?? "file",
						size: options.sourceEntryType === "directory" ? null : 1024,
					},
				];
			}
			return [
				{
					name: "index.md",
					path: moveDestinationArticlePath,
					sha: options.destinationArticleSha ?? MOVE_DESTINATION_SHA,
					type: "file",
					size: 100,
				},
				...(options.includeDestination
					? [
							{
								name: destinationFilename,
								path: `${moveDestinationBundlePath}/${destinationFilename}`,
								sha: "f".repeat(40),
								type: options.destinationEntryType ?? ("file" as const),
								size: options.destinationEntryType === "directory" ? null : 256,
							},
						]
					: []),
			];
		});
	return { getHead, getFileAtCommit, listDirectoryAtCommit };
}

function moveDependencies(
	provider: ReturnType<typeof createMoveProvider>,
	references: {
		source?: readonly {
			storageSlug: string;
			source: "frontmatter-image" | "markdown-image" | "markdown-link";
			originalReference: string;
			target: string;
			targetStorageSlug: string;
			targetFilename: string;
			line: number | null;
			column: number | null;
		}[];
		destination?: readonly {
			storageSlug: string;
			source: "frontmatter-image" | "markdown-image" | "markdown-link";
			originalReference: string;
			target: string;
			targetStorageSlug: string;
			targetFilename: string;
			line: number | null;
			column: number | null;
		}[];
	} = {},
) {
	return {
		gitProvider: provider,
		pathConfig,
		now: () => Date.parse("2026-08-17T01:00:00.000Z"),
		createPreviewId: () => "preview_1234567890abcdef",
		scanReferenceClosure: vi.fn().mockResolvedValue({
			baseCommitSha: HEAD_SHA,
			source: {
				storageSlug: "source-post",
				articleSha: ARTICLE_SHA,
				references: references.source ?? [],
			},
			destination: {
				storageSlug: "destination-post",
				articleSha: MOVE_DESTINATION_SHA,
				references: references.destination ?? [],
			},
			scannedArticleCount: 3,
		}),
	};
}

describe("媒体事务 Preview 服务", () => {
	it("从同一 HEAD 快照生成未引用资源的确定性 rename effects", async () => {
		const provider = createProvider({});
		const preview = await previewMediaTransaction(createRequest(), dependencies(provider));
		expect(provider.getFileAtCommit).toHaveBeenCalledWith(articlePath, HEAD_SHA);
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledWith(bundlePath, HEAD_SHA);
		expect(preview).toMatchObject({
			previewId: "preview_1234567890abcdef",
			baseCommitSha: HEAD_SHA,
			policyLevel: "L0",
			riskLevel: "low",
			confirmation: { kind: "button" },
			source: { repositoryPath: sourcePath },
			destination: { repositoryPath: destinationPath },
		});
		expect(preview.effects).toEqual([
			{ type: "resource-reuse", repositoryPath: destinationPath, from: null, to: BLOB_SHA },
			{ type: "resource-delete", repositoryPath: sourcePath, from: BLOB_SHA, to: null },
		]);
	});

	it("正文引用生成中风险引用影响，封面生成高风险短语", async () => {
		const markdownPreview = await previewMediaTransaction(
			createRequest(),
			dependencies(createProvider({ article: buildArticle("", "[下载](./old-guide.pdf)\n") })),
		);
		expect(markdownPreview).toMatchObject({
			policyLevel: "L1",
			riskLevel: "medium",
			riskReasons: ["resource-reference"],
		});
		expect(markdownPreview.operation).toBe("rename");
		if (markdownPreview.operation !== "rename") throw new Error("预期 rename Preview");
		expect(markdownPreview.references[0]).toMatchObject({
			source: "markdown-link",
			currentTarget: "./old-guide.pdf",
			proposedTarget: "./new-guide.pdf",
			line: 1,
			column: 1,
		});

		const coverProvider = createProvider({ article: buildArticle("./old-cover.png") });
		coverProvider.listDirectoryAtCommit.mockResolvedValue([
			{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file", size: 100 },
			{
				name: "old-cover.png",
				path: `${bundlePath}/old-cover.png`,
				sha: BLOB_SHA,
				type: "file",
				size: 1024,
			},
		]);
		const coverPreview = await previewMediaTransaction(
			{
				...createRequest(),
				sourceFilename: "old-cover.png",
				destinationFilename: "new-cover.png",
			},
			dependencies(coverProvider),
		);
		expect(coverPreview).toMatchObject({
			riskLevel: "high",
			riskReasons: ["resource-reference", "cover-reference"],
			confirmation: { kind: "phrase", phrase: "重命名 old-cover.png" },
		});
	});

	it("HEAD、文章 Blob、资源 Blob 和目标冲突均失败关闭", async () => {
		for (const provider of [
			createProvider({ headSha: "f".repeat(40) }),
			createProvider({ articleSha: "f".repeat(40) }),
			createProvider({ blobSha: "f".repeat(40) }),
			createProvider({ includeDestination: true }),
		]) {
			await expect(
				previewMediaTransaction(createRequest(), dependencies(provider)),
			).rejects.toMatchObject({ status: 409, code: "MEDIA_PREVIEW_CONFLICT" });
		}
	});

	it("生成固定 high move Preview，验证双 article/blob、closure、effects 和全流程只读", async () => {
		const provider = createMoveProvider({});
		const moveDeps = moveDependencies(provider);
		const preview = await previewMediaTransaction(createMoveRequest(), moveDeps);
		expect(moveDeps.scanReferenceClosure).toHaveBeenCalledWith(
			expect.objectContaining({
				baseCommitSha: HEAD_SHA,
				source: expect.objectContaining({ articleSha: ARTICLE_SHA, filename: "guide.png" }),
				destination: expect.objectContaining({ articleSha: MOVE_DESTINATION_SHA }),
			}),
			expect.objectContaining({ gitProvider: provider }),
		);
		expect(provider.getFileAtCommit).toHaveBeenCalledWith(moveSourceArticlePath, HEAD_SHA);
		expect(provider.getFileAtCommit).toHaveBeenCalledWith(moveDestinationArticlePath, HEAD_SHA);
		expect(preview).toMatchObject({
			operation: "move",
			baseCommitSha: HEAD_SHA,
			policyLevel: "L1",
			riskLevel: "high",
			riskReasons: ["cross-article-change"],
			confirmation: {
				kind: "phrase",
				phrase: "移动 guide.png 到 destination-post/moved-guide.png",
			},
			referenceClosure: {
				complete: true,
				scannedArticleCount: 3,
				thirdPartyReferenceCount: 0,
			},
		});
		expect(preview.effects).toEqual([
			{
				type: "resource-reuse",
				repositoryPath: "src/content/posts/destination-post/moved-guide.png",
				from: null,
				to: BLOB_SHA,
			},
			{
				type: "resource-delete",
				repositoryPath: "src/content/posts/source-post/guide.png",
				from: BLOB_SHA,
				to: null,
			},
		]);
		expect(Object.keys(provider)).toEqual(["getHead", "getFileAtCommit", "listDirectoryAtCommit"]);
	});

	it("move 对 HEAD、双 article SHA、Blob、目标冲突、目录和 L2 失败关闭", async () => {
		const cases = [
			{
				provider: createMoveProvider({ sourceArticleSha: "f".repeat(40) }),
				code: "MEDIA_PREVIEW_CONFLICT",
			},
			{
				provider: createMoveProvider({ destinationArticleSha: "f".repeat(40) }),
				code: "MEDIA_PREVIEW_CONFLICT",
			},
			{ provider: createMoveProvider({ blobSha: "f".repeat(40) }), code: "MEDIA_PREVIEW_CONFLICT" },
			{
				provider: createMoveProvider({ includeDestination: true }),
				code: "MEDIA_PREVIEW_CONFLICT",
			},
			{
				provider: createMoveProvider({ sourceEntryType: "directory" }),
				code: "MEDIA_RESOURCE_BLOCKED",
			},
		];
		for (const testCase of cases) {
			await expect(
				previewMediaTransaction(createMoveRequest(), moveDependencies(testCase.provider)),
			).rejects.toMatchObject({ code: testCase.code });
		}
		const hidden = createMoveProvider({});
		hidden.listDirectoryAtCommit.mockImplementation(async (path) =>
			path === moveSourceBundlePath
				? [
						{
							name: "index.md",
							path: moveSourceArticlePath,
							sha: ARTICLE_SHA,
							type: "file",
							size: 100,
						},
						{
							name: ".hidden.png",
							path: `${moveSourceBundlePath}/.hidden.png`,
							sha: BLOB_SHA,
							type: "file",
							size: 100,
						},
					]
				: [
						{
							name: "index.md",
							path: moveDestinationArticlePath,
							sha: MOVE_DESTINATION_SHA,
							type: "file",
							size: 100,
						},
					],
		);
		await expect(
			previewMediaTransaction(createMoveRequest("hidden.png"), moveDependencies(hidden)),
		).rejects.toBeDefined();
	});

	it("PDF 任一侧有引用、GIF 任一侧 cover 时阻止 move", async () => {
		const pdfReference = {
			storageSlug: "source-post",
			source: "markdown-link" as const,
			originalReference: "[下载](./guide.pdf)",
			target: "./guide.pdf",
			targetStorageSlug: "source-post",
			targetFilename: "guide.pdf",
			line: 1,
			column: 1,
		};
		await expect(
			previewMediaTransaction(
				createMoveRequest("guide.pdf"),
				moveDependencies(createMoveProvider({ filename: "guide.pdf" }), {
					source: [pdfReference],
				}),
			),
		).rejects.toMatchObject({ status: 422, code: "MEDIA_RESOURCE_BLOCKED" });

		const gifCover = {
			storageSlug: "destination-post",
			source: "frontmatter-image" as const,
			originalReference: "../source-post/guide.gif",
			target: "../source-post/guide.gif",
			targetStorageSlug: "source-post",
			targetFilename: "guide.gif",
			line: null,
			column: null,
		};
		await expect(
			previewMediaTransaction(
				createMoveRequest("guide.gif"),
				moveDependencies(createMoveProvider({ filename: "guide.gif" }), {
					destination: [gifCover],
				}),
			),
		).rejects.toMatchObject({ status: 422, code: "MEDIA_RESOURCE_BLOCKED" });
	});

	it("未知本地引用语法和禁止类型资源不能生成 Preview", async () => {
		await expect(
			previewMediaTransaction(
				createRequest(),
				dependencies(createProvider({ article: buildArticle("", "[下载]: ./old-guide.pdf\n") })),
			),
		).rejects.toMatchObject({
			status: 422,
			code: "MEDIA_REFERENCE_ANALYSIS_INCOMPLETE",
		});

		const provider = createProvider({});
		provider.listDirectoryAtCommit.mockResolvedValue([
			{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file", size: 100 },
			{
				name: "old-guide.exe",
				path: `${bundlePath}/old-guide.exe`,
				sha: BLOB_SHA,
				type: "file",
				size: 1024,
			},
		]);
		await expect(
			previewMediaTransaction(
				{
					...createRequest(),
					sourceFilename: "old-guide.exe",
					destinationFilename: "new-guide.exe",
				},
				dependencies(provider),
			),
		).rejects.toMatchObject({ status: 422, code: "MEDIA_RESOURCE_BLOCKED" });
	});
});
