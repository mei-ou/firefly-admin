import { describe, expect, it, vi } from "vitest";
import type {
	MoveMediaTransactionPreview,
	RenameMediaTransactionPreview,
} from "../../src/modules/media/media-transaction-preview";
import { prepareMediaTransactionCommit } from "../../src/modules/media/services/prepare-media-transaction-commit";
import type { MediaTransactionReferenceClosure } from "../../src/modules/media/services/scan-media-transaction-reference-closure";
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
const article = `---
title: 测试文章
published: 2026-08-17T00:00:00.000Z
draft: true
description: ""
image: ""
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
[下载](./old-guide.pdf)\n`;

function createPreview(): RenameMediaTransactionPreview {
	const reference = {
		source: "markdown-link" as const,
		originalReference: "[下载](./old-guide.pdf)",
		currentTarget: "./old-guide.pdf",
		proposedTarget: "./new-guide.pdf",
		line: 1,
		column: 1,
	};
	return {
		version: 1,
		previewId: "preview_1234567890abcdef",
		operation: "rename",
		storageSlug: "hello-world",
		createdAt: "2026-08-17T01:00:00.000Z",
		expiresAt: "2026-08-17T01:10:00.000Z",
		baseCommitSha: HEAD_SHA,
		expectedArticleSha: ARTICLE_SHA,
		expectedBlobSha: BLOB_SHA,
		source: {
			filename: "old-guide.pdf",
			relativePath: "./old-guide.pdf",
			repositoryPath: sourcePath,
		},
		destination: {
			filename: "new-guide.pdf",
			relativePath: "./new-guide.pdf",
			repositoryPath: destinationPath,
		},
		effects: [
			{ type: "resource-reuse", repositoryPath: destinationPath, from: null, to: BLOB_SHA },
			{ type: "resource-delete", repositoryPath: sourcePath, from: BLOB_SHA, to: null },
			{
				type: "reference-update",
				repositoryPath: articlePath,
				from: "./old-guide.pdf",
				to: "./new-guide.pdf",
			},
		],
		references: [reference],
		referenceAnalysis: { complete: true, issues: [] },
		policyLevel: "L1",
		riskLevel: "medium",
		riskReasons: ["resource-reference"],
		confirmation: { kind: "button" },
	};
}

function createProvider(
	overrides: {
		headSha?: string;
		articleSha?: string;
		articleContent?: string;
		entries?: Awaited<ReturnType<GitProvider["listDirectoryAtCommit"]>>;
	} = {},
) {
	return {
		getHead: vi.fn<GitProvider["getHead"]>().mockResolvedValue({
			commitSha: overrides.headSha ?? HEAD_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${HEAD_SHA}`,
			treeSha: "d".repeat(40),
		}),
		getFileAtCommit: vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
			path: articlePath,
			sha: overrides.articleSha ?? ARTICLE_SHA,
			content: overrides.articleContent ?? article,
			encoding: "utf-8",
		}),
		listDirectoryAtCommit: vi.fn<GitProvider["listDirectoryAtCommit"]>().mockResolvedValue(
			overrides.entries ?? [
				{ name: "index.md", path: articlePath, sha: ARTICLE_SHA, type: "file", size: 400 },
				{ name: "old-guide.pdf", path: sourcePath, sha: BLOB_SHA, type: "file", size: 1024 },
			],
		),
	};
}

const MOVE_DESTINATION_ARTICLE_SHA = "d".repeat(40);
const moveSourceBundlePath = "src/content/posts/source-post";
const moveDestinationBundlePath = "src/content/posts/destination-post";
const moveSourceArticlePath = `${moveSourceBundlePath}/index.md`;
const moveDestinationArticlePath = `${moveDestinationBundlePath}/index.md`;
const moveSourceResourcePath = `${moveSourceBundlePath}/guide.png`;
const moveDestinationResourcePath = `${moveDestinationBundlePath}/moved-guide.png`;
const moveSourceArticle = article.replace("[下载](./old-guide.pdf)", "![源](./guide.png)");
const moveDestinationArticle = article.replace(
	"[下载](./old-guide.pdf)",
	"[旧资源](../source-post/guide.png)",
);

function createMovePreview(): MoveMediaTransactionPreview {
	const sourceReference = {
		source: "markdown-image" as const,
		originalReference: "![源](./guide.png)",
		currentTarget: "./guide.png",
		proposedTarget: "../destination-post/moved-guide.png",
		line: 1,
		column: 1,
	};
	const destinationReference = {
		source: "markdown-link" as const,
		originalReference: "[旧资源](../source-post/guide.png)",
		currentTarget: "../source-post/guide.png",
		proposedTarget: "./moved-guide.png",
		line: 1,
		column: 1,
	};
	return {
		version: 1,
		previewId: "preview_move_1234567890ab",
		operation: "move",
		createdAt: "2026-08-17T01:00:00.000Z",
		expiresAt: "2026-08-17T01:10:00.000Z",
		baseCommitSha: HEAD_SHA,
		source: {
			storageSlug: "source-post",
			article: { expectedSha: ARTICLE_SHA, repositoryPath: moveSourceArticlePath },
			resource: {
				filename: "guide.png",
				relativePath: "./guide.png",
				repositoryPath: moveSourceResourcePath,
				blobSha: BLOB_SHA,
			},
			references: [sourceReference],
		},
		destination: {
			storageSlug: "destination-post",
			article: {
				expectedSha: MOVE_DESTINATION_ARTICLE_SHA,
				repositoryPath: moveDestinationArticlePath,
			},
			resource: {
				filename: "moved-guide.png",
				relativePath: "./moved-guide.png",
				repositoryPath: moveDestinationResourcePath,
				blobSha: BLOB_SHA,
			},
			references: [destinationReference],
		},
		referenceClosure: {
			complete: true,
			scannedArticleCount: 3,
			thirdPartyReferenceCount: 0,
		},
		effects: [
			{
				type: "resource-reuse",
				repositoryPath: moveDestinationResourcePath,
				from: null,
				to: BLOB_SHA,
			},
			{
				type: "resource-delete",
				repositoryPath: moveSourceResourcePath,
				from: BLOB_SHA,
				to: null,
			},
			{
				type: "reference-update",
				repositoryPath: moveSourceArticlePath,
				from: "./guide.png",
				to: "../destination-post/moved-guide.png",
			},
			{
				type: "reference-update",
				repositoryPath: moveDestinationArticlePath,
				from: "../source-post/guide.png",
				to: "./moved-guide.png",
			},
		],
		policyLevel: "L1",
		riskLevel: "high",
		riskReasons: ["cross-article-change", "resource-reference"],
		confirmation: {
			kind: "phrase",
			phrase: "移动 guide.png 到 destination-post/moved-guide.png",
		},
	};
}

function createMoveClosure(): MediaTransactionReferenceClosure {
	return {
		baseCommitSha: HEAD_SHA,
		source: {
			storageSlug: "source-post",
			articleSha: ARTICLE_SHA,
			references: [
				{
					storageSlug: "source-post",
					source: "markdown-image",
					originalReference: "![源](./guide.png)",
					target: "./guide.png",
					targetStorageSlug: "source-post",
					targetFilename: "guide.png",
					line: 1,
					column: 1,
				},
			],
		},
		destination: {
			storageSlug: "destination-post",
			articleSha: MOVE_DESTINATION_ARTICLE_SHA,
			references: [
				{
					storageSlug: "destination-post",
					source: "markdown-link",
					originalReference: "[旧资源](../source-post/guide.png)",
					target: "../source-post/guide.png",
					targetStorageSlug: "source-post",
					targetFilename: "guide.png",
					line: 1,
					column: 1,
				},
			],
		},
		scannedArticleCount: 3,
	};
}

function createMoveProvider(
	overrides: {
		sourceArticleSha?: string;
		destinationArticleSha?: string;
		sourceArticleContent?: string;
		destinationArticleContent?: string;
		sourceEntries?: Awaited<ReturnType<GitProvider["listDirectoryAtCommit"]>>;
		destinationEntries?: Awaited<ReturnType<GitProvider["listDirectoryAtCommit"]>>;
	} = {},
) {
	const sourceEntries = overrides.sourceEntries ?? [
		{
			name: "index.md",
			path: moveSourceArticlePath,
			sha: ARTICLE_SHA,
			type: "file" as const,
			size: 400,
		},
		{
			name: "guide.png",
			path: moveSourceResourcePath,
			sha: BLOB_SHA,
			type: "file" as const,
			size: 1024,
		},
	];
	const destinationEntries = overrides.destinationEntries ?? [
		{
			name: "index.md",
			path: moveDestinationArticlePath,
			sha: MOVE_DESTINATION_ARTICLE_SHA,
			type: "file" as const,
			size: 400,
		},
	];
	return {
		getHead: vi.fn<GitProvider["getHead"]>().mockResolvedValue({
			commitSha: HEAD_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${HEAD_SHA}`,
			treeSha: "e".repeat(40),
		}),
		getFileAtCommit: vi.fn<GitProvider["getFileAtCommit"]>().mockImplementation(async (path) => {
			if (path === moveSourceArticlePath) {
				return {
					path,
					sha: overrides.sourceArticleSha ?? ARTICLE_SHA,
					content: overrides.sourceArticleContent ?? moveSourceArticle,
					encoding: "utf-8",
				};
			}
			return {
				path,
				sha: overrides.destinationArticleSha ?? MOVE_DESTINATION_ARTICLE_SHA,
				content: overrides.destinationArticleContent ?? moveDestinationArticle,
				encoding: "utf-8",
			};
		}),
		listDirectoryAtCommit: vi
			.fn<GitProvider["listDirectoryAtCommit"]>()
			.mockImplementation(async (path) =>
				path === moveSourceBundlePath ? sourceEntries : destinationEntries,
			),
	};
}

function createMoveDependencies(
	provider = createMoveProvider(),
	closure: MediaTransactionReferenceClosure = createMoveClosure(),
) {
	return {
		gitProvider: provider,
		pathConfig,
		scanReferenceClosure: vi.fn().mockResolvedValue(closure),
	};
}

describe("准备媒体事务 Commit", () => {
	it("只从同一 HEAD 读取 article 与 bundle，核对引用并生成 strict write plan", async () => {
		const provider = createProvider();
		const plan = await prepareMediaTransactionCommit(createPreview(), {
			gitProvider: provider,
			pathConfig,
		});
		expect(provider.getFileAtCommit).toHaveBeenCalledWith(articlePath, HEAD_SHA);
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledWith(bundlePath, HEAD_SHA);
		expect(plan).toMatchObject({
			baseCommitSha: HEAD_SHA,
			source: { repositoryPath: sourcePath, blobSha: BLOB_SHA },
			destination: { repositoryPath: destinationPath, reusedBlobSha: BLOB_SHA },
			article: { mode: "write", expectedSha: ARTICLE_SHA },
		});
		if (plan.operation !== "rename") throw new TypeError("预期 rename Commit Plan。");
		expect(plan.article.plannedContent).toContain("[下载](./new-guide.pdf)");
		expect(Object.keys(provider)).toEqual(["getHead", "getFileAtCommit", "listDirectoryAtCommit"]);
	});

	it("无引用时生成 unchanged plan", async () => {
		const preview = createPreview();
		preview.references = [];
		preview.effects = preview.effects.slice(0, 2);
		preview.policyLevel = "L0";
		preview.riskLevel = "low";
		preview.riskReasons = [];
		const content = article.replace("[下载](./old-guide.pdf)", "正文");
		const plan = await prepareMediaTransactionCommit(preview, {
			gitProvider: createProvider({ articleContent: content }),
			pathConfig,
		});
		if (plan.operation !== "rename") throw new TypeError("预期 rename Commit Plan。");
		expect(plan.article).toMatchObject({
			mode: "unchanged",
			originalContent: content,
			plannedContent: content,
		});
	});

	it("拒绝 HEAD/article/source 漂移、目标冲突、大小和大小写/NFKC 冲突", async () => {
		const articleEntry = {
			name: "index.md",
			path: articlePath,
			sha: ARTICLE_SHA,
			type: "file" as const,
			size: 400,
		};
		const sourceEntry = {
			name: "old-guide.pdf",
			path: sourcePath,
			sha: BLOB_SHA,
			type: "file" as const,
			size: 1024,
		};
		const baseEntries = [articleEntry, sourceEntry];
		for (const provider of [
			createProvider({ headSha: "f".repeat(40) }),
			createProvider({ articleSha: "f".repeat(40) }),
			createProvider({ entries: [articleEntry, { ...sourceEntry, sha: "f".repeat(40) }] }),
			createProvider({ entries: [articleEntry, { ...sourceEntry, size: 5 * 1024 * 1024 }] }),
			createProvider({
				entries: [
					...baseEntries,
					{
						name: "new-guide.pdf",
						path: destinationPath,
						sha: "e".repeat(40),
						type: "file",
						size: 1,
					},
				],
			}),
			createProvider({
				entries: [
					...baseEntries,
					{
						name: "OLD-GUIDE.PDF",
						path: `${bundlePath}/OLD-GUIDE.PDF`,
						sha: "e".repeat(40),
						type: "file",
						size: 1,
					},
				],
			}),
		]) {
			await expect(
				prepareMediaTransactionCommit(createPreview(), { gitProvider: provider, pathConfig }),
			).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		}
	});

	it("Preview references 与当前无损分析不一致时失败关闭", async () => {
		const preview = createPreview();
		const [reference] = preview.references;
		if (!reference) throw new TypeError("测试 Preview 缺少引用。");
		preview.references = [{ ...reference, line: 2 }];
		await expect(
			prepareMediaTransactionCommit(preview, { gitProvider: createProvider(), pathConfig }),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
	});

	it("Move 从同一 HEAD 读取两篇文章和两个 Bundle，并生成两侧 write plan", async () => {
		const provider = createMoveProvider();
		const dependencies = createMoveDependencies(provider);
		const plan = await prepareMediaTransactionCommit(createMovePreview(), dependencies);
		if (plan.operation !== "move") throw new TypeError("预期 Move Commit Plan。");
		expect(provider.getFileAtCommit).toHaveBeenCalledWith(moveSourceArticlePath, HEAD_SHA);
		expect(provider.getFileAtCommit).toHaveBeenCalledWith(moveDestinationArticlePath, HEAD_SHA);
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledWith(moveSourceBundlePath, HEAD_SHA);
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledWith(
			moveDestinationBundlePath,
			HEAD_SHA,
		);
		expect(dependencies.scanReferenceClosure).toHaveBeenCalledWith(
			{
				baseCommitSha: HEAD_SHA,
				source: {
					storageSlug: "source-post",
					articleSha: ARTICLE_SHA,
					filename: "guide.png",
				},
				destination: {
					storageSlug: "destination-post",
					articleSha: MOVE_DESTINATION_ARTICLE_SHA,
				},
			},
			expect.objectContaining({ gitProvider: provider, pathConfig }),
		);
		expect(plan).toMatchObject({
			operation: "move",
			baseCommitSha: HEAD_SHA,
			source: {
				resource: { repositoryPath: moveSourceResourcePath, blobSha: BLOB_SHA },
				article: { mode: "write", expectedSha: ARTICLE_SHA },
			},
			destination: {
				resource: { repositoryPath: moveDestinationResourcePath, reusedBlobSha: BLOB_SHA },
				article: { mode: "write", expectedSha: MOVE_DESTINATION_ARTICLE_SHA },
			},
		});
		expect(plan.source.article.plannedContent).toContain(
			"![源](../destination-post/moved-guide.png)",
		);
		expect(plan.destination.article.plannedContent).toContain("[旧资源](./moved-guide.png)");
		expect(Object.keys(provider)).toEqual(["getHead", "getFileAtCommit", "listDirectoryAtCommit"]);
	});

	it("Move 无引用时两侧都保存 unchanged 的原文、计划正文和空 replacements", async () => {
		const preview = createMovePreview();
		preview.source.references = [];
		preview.destination.references = [];
		preview.effects = preview.effects.slice(0, 2);
		preview.riskReasons = ["cross-article-change"];
		const sourceContent = moveSourceArticle.replace("![源](./guide.png)", "源正文");
		const destinationContent = moveDestinationArticle.replace(
			"[旧资源](../source-post/guide.png)",
			"目标正文",
		);
		const closure = createMoveClosure();
		closure.source.references = [];
		closure.destination.references = [];
		const plan = await prepareMediaTransactionCommit(
			preview,
			createMoveDependencies(
				createMoveProvider({
					sourceArticleContent: sourceContent,
					destinationArticleContent: destinationContent,
				}),
				closure,
			),
		);
		if (plan.operation !== "move") throw new TypeError("预期 Move Commit Plan。");
		expect(plan.source.article).toMatchObject({
			mode: "unchanged",
			originalContent: sourceContent,
			plannedContent: sourceContent,
			replacements: [],
		});
		expect(plan.destination.article).toMatchObject({
			mode: "unchanged",
			originalContent: destinationContent,
			plannedContent: destinationContent,
			replacements: [],
		});
	});

	it("Move 拒绝任一 article SHA、源 blob 和目标文件冲突", async () => {
		const sourceArticleEntry = {
			name: "index.md",
			path: moveSourceArticlePath,
			sha: ARTICLE_SHA,
			type: "file" as const,
			size: 400,
		};
		const destinationArticleEntry = {
			name: "index.md",
			path: moveDestinationArticlePath,
			sha: MOVE_DESTINATION_ARTICLE_SHA,
			type: "file" as const,
			size: 400,
		};
		const sourceResourceEntry = {
			name: "guide.png",
			path: moveSourceResourcePath,
			sha: BLOB_SHA,
			type: "file" as const,
			size: 1024,
		};
		for (const provider of [
			createMoveProvider({ sourceArticleSha: "f".repeat(40) }),
			createMoveProvider({ destinationArticleSha: "f".repeat(40) }),
			createMoveProvider({
				sourceEntries: [sourceArticleEntry, { ...sourceResourceEntry, sha: "f".repeat(40) }],
			}),
			createMoveProvider({
				destinationEntries: [
					destinationArticleEntry,
					{
						name: "moved-guide.png",
						path: moveDestinationResourcePath,
						sha: "f".repeat(40),
						type: "file",
						size: 100,
					},
				],
			}),
		]) {
			await expect(
				prepareMediaTransactionCommit(createMovePreview(), createMoveDependencies(provider)),
			).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		}
	});

	it("Move 拒绝任一 Bundle 的目录、非法路径及大小写或 Unicode 冲突", async () => {
		const sourceArticleEntry = {
			name: "index.md",
			path: moveSourceArticlePath,
			sha: ARTICLE_SHA,
			type: "file" as const,
			size: 400,
		};
		const sourceResourceEntry = {
			name: "guide.png",
			path: moveSourceResourcePath,
			sha: BLOB_SHA,
			type: "file" as const,
			size: 1024,
		};
		const destinationArticleEntry = {
			name: "index.md",
			path: moveDestinationArticlePath,
			sha: MOVE_DESTINATION_ARTICLE_SHA,
			type: "file" as const,
			size: 400,
		};
		for (const provider of [
			createMoveProvider({
				sourceEntries: [
					sourceArticleEntry,
					sourceResourceEntry,
					{
						name: "nested",
						path: `${moveSourceBundlePath}/nested`,
						sha: "f".repeat(40),
						type: "directory",
						size: null,
					},
				],
			}),
			createMoveProvider({
				destinationEntries: [
					destinationArticleEntry,
					{
						name: "ｇuide.png",
						path: `${moveDestinationBundlePath}/ｇuide.png`,
						sha: "f".repeat(40),
						type: "file",
						size: 100,
					},
				],
			}),
			createMoveProvider({
				destinationEntries: [
					destinationArticleEntry,
					{
						name: "Cover.PNG",
						path: `${moveDestinationBundlePath}/Cover.PNG`,
						sha: "e".repeat(40),
						type: "file",
						size: 100,
					},
					{
						name: "cover.png",
						path: `${moveDestinationBundlePath}/cover.png`,
						sha: "f".repeat(40),
						type: "file",
						size: 100,
					},
				],
			}),
		]) {
			await expect(
				prepareMediaTransactionCommit(createMovePreview(), createMoveDependencies(provider)),
			).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		}
	});

	it("Move closure 的 HEAD、文章身份、计数、引用或第三方声明漂移时失败关闭", async () => {
		const previewWithThirdParty = createMovePreview();
		previewWithThirdParty.referenceClosure.thirdPartyReferenceCount = 1;
		const closures = [
			{ ...createMoveClosure(), baseCommitSha: "f".repeat(40) },
			{ ...createMoveClosure(), scannedArticleCount: 4 },
			{
				...createMoveClosure(),
				source: { ...createMoveClosure().source, articleSha: "f".repeat(40) },
			},
			{
				...createMoveClosure(),
				destination: { ...createMoveClosure().destination, references: [] },
			},
		];
		for (const closure of closures) {
			await expect(
				prepareMediaTransactionCommit(
					createMovePreview(),
					createMoveDependencies(createMoveProvider(), closure),
				),
			).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
		}
		await expect(
			prepareMediaTransactionCommit(
				previewWithThirdParty,
				createMoveDependencies(createMoveProvider()),
			),
		).rejects.toThrow();
		const dependencies = createMoveDependencies();
		dependencies.scanReferenceClosure.mockRejectedValue(new TypeError("分析失败"));
		await expect(
			prepareMediaTransactionCommit(createMovePreview(), dependencies),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
	});

	it("Move rewriter 发现 article 引用位置漂移时失败关闭", async () => {
		const originalClosure = createMoveClosure();
		const closureSourceReference = originalClosure.source.references[0];
		if (!closureSourceReference) throw new TypeError("测试夹具缺少源文章引用。");
		const closure: MediaTransactionReferenceClosure = {
			...originalClosure,
			source: {
				...originalClosure.source,
				references: [{ ...closureSourceReference, line: 2 }],
			},
		};
		const preview = createMovePreview();
		const previewSourceReference = preview.source.references[0];
		if (!previewSourceReference) throw new TypeError("测试夹具缺少 Preview 源文章引用。");
		preview.source.references = [{ ...previewSourceReference, line: 2 }];
		await expect(
			prepareMediaTransactionCommit(preview, createMoveDependencies(createMoveProvider(), closure)),
		).rejects.toMatchObject({ status: 409, code: "CONFLICT" });
	});
});
