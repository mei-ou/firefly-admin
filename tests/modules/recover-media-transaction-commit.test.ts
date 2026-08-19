import { describe, expect, it, vi } from "vitest";
import type {
	MoveMediaTransactionCommitPlan,
	RenameMediaTransactionCommitPlan,
} from "../../src/modules/media/media-transaction-commit";
import type { MediaTransactionPreview } from "../../src/modules/media/media-transaction-preview";
import { recoverMediaTransactionCommit } from "../../src/modules/media/services/recover-media-transaction-commit";
import type { GitProvider } from "../../src/providers/git/types";

const HEAD_SHA = "a".repeat(40);
const ARTICLE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const CANDIDATE_SHA = "d".repeat(40);
const FILE_SHA = "e".repeat(40);
const pathConfig = {
	contentRoot: "src/content/posts",
	entryFilename: "index.md",
	usePageBundle: true,
};
const bundlePath = "src/content/posts/hello-world";
const articlePath = `${bundlePath}/index.md`;
const sourcePath = `${bundlePath}/old.png`;
const destinationPath = `${bundlePath}/new.png`;
const moveSourceBundlePath = "src/content/posts/source";
const moveDestinationBundlePath = "src/content/posts/destination";
const moveSourceArticlePath = `${moveSourceBundlePath}/index.md`;
const moveDestinationArticlePath = `${moveDestinationBundlePath}/index.md`;
const moveSourcePath = `${moveSourceBundlePath}/old.png`;
const moveDestinationPath = `${moveDestinationBundlePath}/new.png`;
const MOVE_DESTINATION_ARTICLE_SHA = "1".repeat(40);
const MOVE_SOURCE_FILE_SHA = "2".repeat(40);
const MOVE_DESTINATION_FILE_SHA = "3".repeat(40);

function createPreview(write = true): MediaTransactionPreview {
	const references = write
		? [
				{
					source: "frontmatter-image" as const,
					originalReference: "./old.png",
					currentTarget: "./old.png",
					proposedTarget: "./new.png",
					line: null,
					column: null,
				},
			]
		: [];
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
		source: { filename: "old.png", relativePath: "./old.png", repositoryPath: sourcePath },
		destination: {
			filename: "new.png",
			relativePath: "./new.png",
			repositoryPath: destinationPath,
		},
		effects: [
			{ type: "resource-reuse", repositoryPath: destinationPath, from: null, to: BLOB_SHA },
			{ type: "resource-delete", repositoryPath: sourcePath, from: BLOB_SHA, to: null },
			...references.map((reference) => ({
				type: "reference-update" as const,
				repositoryPath: articlePath,
				from: reference.currentTarget,
				to: reference.proposedTarget,
			})),
		],
		references,
		referenceAnalysis: { complete: true, issues: [] },
		policyLevel: write ? "L1" : "L0",
		riskLevel: write ? "high" : "low",
		riskReasons: write ? ["resource-reference", "cover-reference"] : [],
		confirmation: write ? { kind: "phrase", phrase: "重命名 old.png" } : { kind: "button" },
	};
}

function createMovePreview(sourceWrite = true, destinationWrite = true): MediaTransactionPreview {
	const sourceReferences = sourceWrite
		? [
				{
					source: "markdown-image" as const,
					originalReference: "![源](./old.png)",
					currentTarget: "./old.png",
					proposedTarget: "../destination/new.png",
					line: 1,
					column: 5,
				},
			]
		: [];
	const destinationReferences = destinationWrite
		? [
				{
					source: "markdown-link" as const,
					originalReference: "[源](../source/old.png)",
					currentTarget: "../source/old.png",
					proposedTarget: "./new.png",
					line: 1,
					column: 4,
				},
			]
		: [];
	return {
		version: 1,
		previewId: "preview_move_1234567890ab",
		operation: "move",
		createdAt: "2026-08-17T01:00:00.000Z",
		expiresAt: "2026-08-17T01:10:00.000Z",
		baseCommitSha: HEAD_SHA,
		source: {
			storageSlug: "source",
			article: { expectedSha: ARTICLE_SHA, repositoryPath: moveSourceArticlePath },
			resource: {
				filename: "old.png",
				relativePath: "./old.png",
				repositoryPath: moveSourcePath,
				blobSha: BLOB_SHA,
			},
			references: sourceReferences,
		},
		destination: {
			storageSlug: "destination",
			article: {
				expectedSha: MOVE_DESTINATION_ARTICLE_SHA,
				repositoryPath: moveDestinationArticlePath,
			},
			resource: {
				filename: "new.png",
				relativePath: "./new.png",
				repositoryPath: moveDestinationPath,
				blobSha: BLOB_SHA,
			},
			references: destinationReferences,
		},
		referenceClosure: { complete: true, scannedArticleCount: 2, thirdPartyReferenceCount: 0 },
		effects: [
			{ type: "resource-reuse", repositoryPath: moveDestinationPath, from: null, to: BLOB_SHA },
			{ type: "resource-delete", repositoryPath: moveSourcePath, from: BLOB_SHA, to: null },
			...sourceReferences.map((reference) => ({
				type: "reference-update" as const,
				repositoryPath: moveSourceArticlePath,
				from: reference.currentTarget,
				to: reference.proposedTarget,
			})),
			...destinationReferences.map((reference) => ({
				type: "reference-update" as const,
				repositoryPath: moveDestinationArticlePath,
				from: reference.currentTarget,
				to: reference.proposedTarget,
			})),
		],
		policyLevel: "L1",
		riskLevel: "high",
		riskReasons: [
			"cross-article-change",
			...(sourceWrite || destinationWrite ? (["resource-reference"] as const) : []),
		],
		confirmation: { kind: "phrase", phrase: "移动 old.png 到 destination/new.png" },
	};
}

function createMoveArticlePlan(
	side: "source" | "destination",
	write: boolean,
): MoveMediaTransactionCommitPlan["source"]["article"] {
	const source = side === "source";
	const originalContent = source ? "![源](./old.png)\n" : "[源](../source/old.png)\n";
	const before = source ? "./old.png" : "../source/old.png";
	const after = source ? "../destination/new.png" : "./new.png";
	const start = source ? 5 : 4;
	return {
		mode: write ? "write" : "unchanged",
		repositoryPath: source ? moveSourceArticlePath : moveDestinationArticlePath,
		expectedSha: source ? ARTICLE_SHA : MOVE_DESTINATION_ARTICLE_SHA,
		originalContent: write ? originalContent : `${side} unchanged\n`,
		plannedContent: write
			? `${originalContent.slice(0, start)}${after}${originalContent.slice(start + before.length)}`
			: `${side} unchanged\n`,
		replacements: write
			? [
					{
						source: source ? "markdown-image" : "markdown-link",
						start,
						end: start + before.length,
						before,
						after,
					},
				]
			: [],
	};
}

function createMovePlan(
	sourceWrite = true,
	destinationWrite = true,
): MoveMediaTransactionCommitPlan {
	return {
		version: 1,
		operation: "move",
		previewId: "preview_move_1234567890ab",
		baseCommitSha: HEAD_SHA,
		source: {
			storageSlug: "source",
			resource: { repositoryPath: moveSourcePath, blobSha: BLOB_SHA },
			article: createMoveArticlePlan("source", sourceWrite),
		},
		destination: {
			storageSlug: "destination",
			resource: { repositoryPath: moveDestinationPath, reusedBlobSha: BLOB_SHA },
			article: createMoveArticlePlan("destination", destinationWrite),
		},
	};
}

function createPlan(write = true): RenameMediaTransactionCommitPlan {
	const originalContent = write ? "image: ./old.png\n" : 'image: ""\n';
	return {
		version: 1,
		operation: "rename",
		previewId: "preview_1234567890abcdef",
		storageSlug: "hello-world",
		baseCommitSha: HEAD_SHA,
		source: { repositoryPath: sourcePath, blobSha: BLOB_SHA },
		destination: { repositoryPath: destinationPath, reusedBlobSha: BLOB_SHA },
		article: {
			mode: write ? "write" : "unchanged",
			repositoryPath: articlePath,
			expectedSha: ARTICLE_SHA,
			originalContent,
			plannedContent: write ? "image: ./new.png\n" : originalContent,
			replacements: write
				? [
						{
							source: "frontmatter-image",
							start: 7,
							end: 16,
							before: "./old.png",
							after: "./new.png",
						},
					]
				: [],
		},
	};
}

function createProvider(
	options: {
		headSha?: string;
		articleContent?: string;
		articleSha?: string;
		entries?: Awaited<ReturnType<GitProvider["listDirectoryAtCommit"]>>;
	} = {},
) {
	return {
		getHead: vi.fn<GitProvider["getHead"]>().mockResolvedValue({
			commitSha: options.headSha ?? CANDIDATE_SHA,
			commitUrl: `https://github.com/owner/repo/commit/${CANDIDATE_SHA}`,
			treeSha: "f".repeat(40),
		}),
		getFileAtCommit: vi.fn<GitProvider["getFileAtCommit"]>().mockResolvedValue({
			path: articlePath,
			sha: options.articleSha ?? FILE_SHA,
			content: options.articleContent ?? createPlan().article.plannedContent,
			encoding: "utf-8",
		}),
		listDirectoryAtCommit: vi.fn<GitProvider["listDirectoryAtCommit"]>().mockResolvedValue(
			options.entries ?? [
				{ name: "index.md", path: articlePath, sha: FILE_SHA, type: "file", size: 100 },
				{ name: "new.png", path: destinationPath, sha: BLOB_SHA, type: "file", size: 1024 },
			],
		),
	};
}

function moveArticleEntry(
	side: "source" | "destination",
	sha = side === "source" ? MOVE_SOURCE_FILE_SHA : MOVE_DESTINATION_FILE_SHA,
) {
	return {
		name: "index.md",
		path: side === "source" ? moveSourceArticlePath : moveDestinationArticlePath,
		sha,
		type: "file" as const,
		size: 100,
	};
}

function createMoveProvider(
	options: {
		headSha?: string;
		commitUrl?: string;
		sourceContent?: string;
		destinationContent?: string;
		sourceSha?: string;
		destinationSha?: string;
		sourceEntries?: Awaited<ReturnType<GitProvider["listDirectoryAtCommit"]>>;
		destinationEntries?: Awaited<ReturnType<GitProvider["listDirectoryAtCommit"]>>;
	} = {},
) {
	const plan = createMovePlan();
	const sourceSha = options.sourceSha ?? MOVE_SOURCE_FILE_SHA;
	const destinationSha = options.destinationSha ?? MOVE_DESTINATION_FILE_SHA;
	const sourceEntries = options.sourceEntries ?? [moveArticleEntry("source", sourceSha)];
	const destinationEntries = options.destinationEntries ?? [
		moveArticleEntry("destination", destinationSha),
		{ name: "new.png", path: moveDestinationPath, sha: BLOB_SHA, type: "file", size: 1024 },
	];
	const commitUrl =
		options.commitUrl === undefined
			? `https://github.com/owner/repo/commit/${CANDIDATE_SHA}`
			: options.commitUrl;
	return {
		getHead: vi.fn<GitProvider["getHead"]>().mockResolvedValue({
			commitSha: options.headSha ?? CANDIDATE_SHA,
			...(commitUrl ? { commitUrl } : {}),
			treeSha: "f".repeat(40),
		}),
		getFileAtCommit: vi.fn<GitProvider["getFileAtCommit"]>().mockImplementation(async (path) =>
			path === moveSourceArticlePath
				? {
						path,
						sha: sourceSha,
						content: options.sourceContent ?? plan.source.article.plannedContent,
						encoding: "utf-8",
					}
				: {
						path,
						sha: destinationSha,
						content: options.destinationContent ?? plan.destination.article.plannedContent,
						encoding: "utf-8",
					},
		),
		listDirectoryAtCommit: vi
			.fn<GitProvider["listDirectoryAtCommit"]>()
			.mockImplementation(async (path) =>
				path === moveSourceBundlePath ? sourceEntries : destinationEntries,
			),
	};
}

describe("只读恢复媒体事务 Commit", () => {
	it("candidate 等于 HEAD 且同快照满足全部不变量时重建 strict result", async () => {
		const provider = createProvider();
		const result = await recoverMediaTransactionCommit(
			createPlan(),
			createPreview(),
			CANDIDATE_SHA,
			{
				gitProvider: provider,
				pathConfig,
				now: () => Date.parse("2026-08-17T01:03:00.000Z"),
			},
		);
		expect(result).toMatchObject({
			commitSha: CANDIDATE_SHA,
			article: { updated: true, fileSha: FILE_SHA },
			destination: { blobSha: BLOB_SHA },
		});
		expect(provider.getFileAtCommit).toHaveBeenCalledWith(articlePath, CANDIDATE_SHA);
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledWith(bundlePath, CANDIDATE_SHA);
		expect(Object.keys(provider)).toEqual(["getHead", "getFileAtCommit", "listDirectoryAtCommit"]);
	});

	it("unchanged 还要求 article SHA 不变", async () => {
		const preview = createPreview(false);
		const plan = createPlan(false);
		const good = await recoverMediaTransactionCommit(plan, preview, CANDIDATE_SHA, {
			gitProvider: createProvider({
				articleContent: plan.article.plannedContent,
				articleSha: ARTICLE_SHA,
			}),
			pathConfig,
		});
		expect(good?.article).toEqual({ updated: false, fileSha: ARTICLE_SHA });
		const bad = await recoverMediaTransactionCommit(plan, preview, CANDIDATE_SHA, {
			gitProvider: createProvider({
				articleContent: plan.article.plannedContent,
				articleSha: FILE_SHA,
			}),
			pathConfig,
		});
		expect(bad).toBeUndefined();
	});

	it("HEAD、正文精确值、目标 blob、源不存在和冲突任一无法证明均返回 undefined", async () => {
		const articleEntry = {
			name: "index.md",
			path: articlePath,
			sha: FILE_SHA,
			type: "file" as const,
			size: 100,
		};
		const destinationEntry = {
			name: "new.png",
			path: destinationPath,
			sha: BLOB_SHA,
			type: "file" as const,
			size: 1024,
		};
		const validEntries = [articleEntry, destinationEntry];
		for (const provider of [
			createProvider({ headSha: "f".repeat(40) }),
			createProvider({ articleContent: `${createPlan().article.plannedContent} ` }),
			createProvider({ entries: [articleEntry, { ...destinationEntry, sha: "f".repeat(40) }] }),
			createProvider({
				entries: [
					...validEntries,
					{ name: "old.png", path: sourcePath, sha: BLOB_SHA, type: "file", size: 1 },
				],
			}),
			createProvider({
				entries: [
					...validEntries,
					{ name: "NEW.PNG", path: `${bundlePath}/NEW.PNG`, sha: BLOB_SHA, type: "file", size: 1 },
				],
			}),
			createProvider({ entries: [articleEntry] }),
		]) {
			expect(
				await recoverMediaTransactionCommit(createPlan(), createPreview(), CANDIDATE_SHA, {
					gitProvider: provider,
					pathConfig,
				}),
			).toBeUndefined();
		}
	});

	it("move 在同一 candidate 快照证明双文章和双目录后重建 strict result", async () => {
		const provider = createMoveProvider();
		const result = await recoverMediaTransactionCommit(
			createMovePlan(),
			createMovePreview(),
			CANDIDATE_SHA,
			{ gitProvider: provider, pathConfig },
		);
		expect(result).toMatchObject({
			operation: "move",
			articles: {
				source: { updated: true, fileSha: MOVE_SOURCE_FILE_SHA },
				destination: { updated: true, fileSha: MOVE_DESTINATION_FILE_SHA },
			},
			source: { deleted: true },
			destination: { blobSha: BLOB_SHA },
		});
		expect(provider.getFileAtCommit).toHaveBeenCalledTimes(2);
		expect(provider.getFileAtCommit).toHaveBeenCalledWith(moveSourceArticlePath, CANDIDATE_SHA);
		expect(provider.getFileAtCommit).toHaveBeenCalledWith(
			moveDestinationArticlePath,
			CANDIDATE_SHA,
		);
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledTimes(2);
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledWith(
			moveSourceBundlePath,
			CANDIDATE_SHA,
		);
		expect(provider.listDirectoryAtCommit).toHaveBeenCalledWith(
			moveDestinationBundlePath,
			CANDIDATE_SHA,
		);
		expect(Object.keys(provider)).toEqual(["getHead", "getFileAtCommit", "listDirectoryAtCommit"]);
	});

	it("move 两侧 unchanged 分别要求正文和 expected SHA 精确一致", async () => {
		const plan = createMovePlan(false, false);
		const preview = createMovePreview(false, false);
		const goodProvider = createMoveProvider({
			sourceContent: plan.source.article.plannedContent,
			destinationContent: plan.destination.article.plannedContent,
			sourceSha: ARTICLE_SHA,
			destinationSha: MOVE_DESTINATION_ARTICLE_SHA,
		});
		const good = await recoverMediaTransactionCommit(plan, preview, CANDIDATE_SHA, {
			gitProvider: goodProvider,
			pathConfig,
		});
		expect(good?.operation === "move" && good.articles).toEqual({
			source: { updated: false, fileSha: ARTICLE_SHA },
			destination: { updated: false, fileSha: MOVE_DESTINATION_ARTICLE_SHA },
		});
		for (const provider of [
			createMoveProvider({
				sourceContent: `${plan.source.article.plannedContent} `,
				destinationContent: plan.destination.article.plannedContent,
				sourceSha: ARTICLE_SHA,
				destinationSha: MOVE_DESTINATION_ARTICLE_SHA,
			}),
			createMoveProvider({
				sourceContent: plan.source.article.plannedContent,
				destinationContent: plan.destination.article.plannedContent,
				sourceSha: MOVE_SOURCE_FILE_SHA,
				destinationSha: MOVE_DESTINATION_ARTICLE_SHA,
			}),
			createMoveProvider({
				sourceContent: plan.source.article.plannedContent,
				destinationContent: plan.destination.article.plannedContent,
				sourceSha: ARTICLE_SHA,
				destinationSha: MOVE_DESTINATION_FILE_SHA,
			}),
		]) {
			expect(
				await recoverMediaTransactionCommit(plan, preview, CANDIDATE_SHA, {
					gitProvider: provider,
					pathConfig,
				}),
			).toBeUndefined();
		}
	});

	it("move 对 source 残留、destination 缺失/blob 错和目录冲突失败关闭", async () => {
		const sourceArticle = moveArticleEntry("source");
		const destinationArticle = moveArticleEntry("destination");
		const destinationResource = {
			name: "new.png",
			path: moveDestinationPath,
			sha: BLOB_SHA,
			type: "file" as const,
			size: 1024,
		};
		for (const provider of [
			createMoveProvider({
				sourceEntries: [
					sourceArticle,
					{ name: "old.png", path: moveSourcePath, sha: BLOB_SHA, type: "file", size: 1 },
				],
			}),
			createMoveProvider({ destinationEntries: [destinationArticle] }),
			createMoveProvider({
				destinationEntries: [destinationArticle, { ...destinationResource, sha: FILE_SHA }],
			}),
			createMoveProvider({
				sourceEntries: [
					sourceArticle,
					{
						name: "nested",
						path: `${moveSourceBundlePath}/nested`,
						sha: FILE_SHA,
						type: "directory",
						size: null,
					},
				],
			}),
			createMoveProvider({
				destinationEntries: [
					destinationArticle,
					destinationResource,
					{
						name: "NEW.PNG",
						path: `${moveDestinationBundlePath}/NEW.PNG`,
						sha: BLOB_SHA,
						type: "file",
						size: 1,
					},
				],
			}),
			createMoveProvider({
				destinationEntries: [
					destinationArticle,
					destinationResource,
					{
						name: "bad name.png",
						path: `${moveDestinationBundlePath}/bad name.png`,
						sha: FILE_SHA,
						type: "file",
						size: 1,
					},
				],
			}),
			createMoveProvider({
				destinationEntries: [
					{ ...destinationArticle, path: `${moveDestinationBundlePath}/wrong.md` },
					destinationResource,
				],
			}),
		]) {
			expect(
				await recoverMediaTransactionCommit(createMovePlan(), createMovePreview(), CANDIDATE_SHA, {
					gitProvider: provider,
					pathConfig,
				}),
			).toBeUndefined();
		}
	});

	it("move 缺少 candidate HEAD/commitUrl 或任一读取异常时不尝试 Git 写入", async () => {
		for (const provider of [
			createMoveProvider({ headSha: HEAD_SHA }),
			createMoveProvider({ commitUrl: "" }),
		]) {
			expect(
				await recoverMediaTransactionCommit(createMovePlan(), createMovePreview(), CANDIDATE_SHA, {
					gitProvider: provider,
					pathConfig,
				}),
			).toBeUndefined();
			expect(provider.getFileAtCommit).not.toHaveBeenCalled();
			expect(provider.listDirectoryAtCommit).not.toHaveBeenCalled();
		}
		const provider = createMoveProvider();
		provider.listDirectoryAtCommit.mockImplementation(async () => {
			throw new Error("network");
		});
		expect(
			await recoverMediaTransactionCommit(createMovePlan(), createMovePreview(), CANDIDATE_SHA, {
				gitProvider: provider,
				pathConfig,
			}),
		).toBeUndefined();
		expect("commitFilesAtomically" in provider).toBe(false);
	});

	it("读取异常也只返回 undefined，不尝试 Git 写入", async () => {
		const provider = createProvider();
		provider.getHead.mockRejectedValue(new Error("network"));
		expect(
			await recoverMediaTransactionCommit(createPlan(), createPreview(), CANDIDATE_SHA, {
				gitProvider: provider,
				pathConfig,
			}),
		).toBeUndefined();
	});
});
