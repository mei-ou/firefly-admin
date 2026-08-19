import { describe, expect, it, vi } from "vitest";
import type {
	MoveMediaTransactionCommitPlan,
	RenameMediaTransactionCommitPlan,
} from "../../src/modules/media/media-transaction-commit";
import type { MediaTransactionPreview } from "../../src/modules/media/media-transaction-preview";
import { executeMediaTransactionCommit } from "../../src/modules/media/services/execute-media-transaction-commit";
import type { GitProvider } from "../../src/providers/git/types";

const HEAD_SHA = "a".repeat(40);
const ARTICLE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const COMMIT_SHA = "d".repeat(40);
const FILE_SHA = "e".repeat(40);
const pathConfig = {
	contentRoot: "src/content/posts",
	entryFilename: "index.md",
	usePageBundle: true,
};
const articlePath = "src/content/posts/hello-world/index.md";
const sourcePath = "src/content/posts/hello-world/old.png";
const destinationPath = "src/content/posts/hello-world/new.png";
const moveSourceArticlePath = "src/content/posts/source/index.md";
const moveDestinationArticlePath = "src/content/posts/destination/index.md";
const moveSourcePath = "src/content/posts/source/old.png";
const moveDestinationPath = "src/content/posts/destination/new.png";
const MOVE_DESTINATION_ARTICLE_SHA = "1".repeat(40);
const MOVE_SOURCE_FILE_SHA = "2".repeat(40);
const MOVE_DESTINATION_FILE_SHA = "3".repeat(40);

function createPreview(write: boolean): MediaTransactionPreview {
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

function createMovePreview(
	sourceWrite: boolean,
	destinationWrite: boolean,
): MediaTransactionPreview {
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
		referenceClosure: {
			complete: true,
			scannedArticleCount: 2,
			thirdPartyReferenceCount: 0,
		},
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
	sourceWrite: boolean,
	destinationWrite: boolean,
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

function createPlan(write: boolean): RenameMediaTransactionCommitPlan {
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

describe("执行媒体事务 Commit", () => {
	it.each([true, false])(
		"用一次 atomic commit 构造 %s 模式的 3/2 项集合并透传 checkpoint",
		async (write) => {
			const checkpoint = vi.fn(async () => undefined);
			const commitFilesAtomically = vi
				.fn<GitProvider["commitFilesAtomically"]>()
				.mockImplementation(async (input) => {
					await input.checkpointCandidateCommit(COMMIT_SHA);
					return {
						commitSha: COMMIT_SHA,
						commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
						files: [
							...(write ? [{ path: articlePath, fileSha: FILE_SHA }] : []),
							{ path: destinationPath, fileSha: BLOB_SHA },
							{ path: sourcePath, fileSha: null },
						],
					};
				});
			const result = await executeMediaTransactionCommit(createPlan(write), createPreview(write), {
				gitProvider: { commitFilesAtomically },
				pathConfig,
				checkpointCandidateCommit: checkpoint,
				now: () => Date.parse("2026-08-17T01:02:00.000Z"),
			});
			expect(commitFilesAtomically).toHaveBeenCalledTimes(1);
			const input = commitFilesAtomically.mock.calls[0]?.[0];
			if (!input) throw new TypeError("缺少原子 Git 提交调用。");
			expect(input.files).toHaveLength(write ? 3 : 2);
			expect(input.files.slice(-2)).toEqual([
				{ operation: "reuse", path: destinationPath, expectedSha: null, fileSha: BLOB_SHA },
				{ operation: "delete", path: sourcePath, expectedSha: BLOB_SHA },
			]);
			expect(checkpoint).toHaveBeenCalledWith(COMMIT_SHA);
			expect(result.article).toEqual({ updated: write, fileSha: write ? FILE_SHA : ARTICLE_SHA });
		},
	);

	it.each([
		[true, true, 4],
		[false, false, 2],
		[true, false, 3],
		[false, true, 3],
	] as const)(
		"move 两侧 write=%s/%s 时只提交一次且固定为 %s 项",
		async (sourceWrite, destinationWrite, expectedLength) => {
			const checkpoint = vi.fn(async () => undefined);
			const commitFilesAtomically = vi
				.fn<GitProvider["commitFilesAtomically"]>()
				.mockImplementation(async (input) => {
					await input.checkpointCandidateCommit(COMMIT_SHA);
					return {
						commitSha: COMMIT_SHA,
						commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
						files: [
							...(sourceWrite
								? [{ path: moveSourceArticlePath, fileSha: MOVE_SOURCE_FILE_SHA }]
								: []),
							...(destinationWrite
								? [{ path: moveDestinationArticlePath, fileSha: MOVE_DESTINATION_FILE_SHA }]
								: []),
							{ path: moveDestinationPath, fileSha: BLOB_SHA },
							{ path: moveSourcePath, fileSha: null },
						],
					};
				});
			const result = await executeMediaTransactionCommit(
				createMovePlan(sourceWrite, destinationWrite),
				createMovePreview(sourceWrite, destinationWrite),
				{
					gitProvider: { commitFilesAtomically },
					pathConfig,
					checkpointCandidateCommit: checkpoint,
				},
			);
			expect(commitFilesAtomically).toHaveBeenCalledTimes(1);
			const input = commitFilesAtomically.mock.calls[0]?.[0];
			if (!input) throw new TypeError("缺少原子 Git 提交调用。");
			expect(input.files).toHaveLength(expectedLength);
			expect(input.files).toEqual([
				...(sourceWrite
					? [
							{
								operation: "write",
								path: moveSourceArticlePath,
								content: createMovePlan(true, destinationWrite).source.article.plannedContent,
								expectedSha: ARTICLE_SHA,
							},
						]
					: []),
				...(destinationWrite
					? [
							{
								operation: "write",
								path: moveDestinationArticlePath,
								content: createMovePlan(sourceWrite, true).destination.article.plannedContent,
								expectedSha: MOVE_DESTINATION_ARTICLE_SHA,
							},
						]
					: []),
				{
					operation: "reuse",
					path: moveDestinationPath,
					expectedSha: null,
					fileSha: BLOB_SHA,
				},
				{ operation: "delete", path: moveSourcePath, expectedSha: BLOB_SHA },
			]);
			expect(input.message).toBe("assets(post): move old.png to destination/new.png");
			expect(checkpoint).toHaveBeenCalledWith(COMMIT_SHA);
			expect(result).toMatchObject({
				operation: "move",
				articles: {
					source: {
						updated: sourceWrite,
						fileSha: sourceWrite ? MOVE_SOURCE_FILE_SHA : ARTICLE_SHA,
					},
					destination: {
						updated: destinationWrite,
						fileSha: destinationWrite ? MOVE_DESTINATION_FILE_SHA : MOVE_DESTINATION_ARTICLE_SHA,
					},
				},
			});
		},
	);

	it("move Provider 返回缺失、重复、未知 path、非法 null 或错误 reuse blob 时上抛", async () => {
		const valid = [
			{ path: moveSourceArticlePath, fileSha: MOVE_SOURCE_FILE_SHA },
			{ path: moveDestinationArticlePath, fileSha: MOVE_DESTINATION_FILE_SHA },
			{ path: moveDestinationPath, fileSha: BLOB_SHA },
			{ path: moveSourcePath, fileSha: null },
		];
		for (const files of [
			valid.slice(1),
			[valid[0], valid[1], valid[2], valid[2]],
			[valid[0], valid[1], valid[2], { path: "README.md", fileSha: null }],
			[{ ...valid[0], fileSha: null }, valid[1], valid[2], valid[3]],
			[valid[0], valid[1], { ...valid[2], fileSha: FILE_SHA }, valid[3]],
			[valid[0], valid[1], valid[2], { ...valid[3], fileSha: BLOB_SHA }],
		]) {
			await expect(
				executeMediaTransactionCommit(createMovePlan(true, true), createMovePreview(true, true), {
					gitProvider: {
						commitFilesAtomically: vi.fn().mockResolvedValue({
							commitSha: COMMIT_SHA,
							commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
							files,
						}),
					},
					pathConfig,
					checkpointCandidateCommit: async () => undefined,
				}),
			).rejects.toMatchObject({ status: 502, code: "UPSTREAM_ERROR" });
		}
	});

	it("Provider 返回缺失、重复、错误 path/fileSha 集合时上抛", async () => {
		for (const files of [
			[{ path: destinationPath, fileSha: BLOB_SHA }],
			[
				{ path: destinationPath, fileSha: BLOB_SHA },
				{ path: destinationPath, fileSha: null },
			],
			[
				{ path: destinationPath, fileSha: "f".repeat(40) },
				{ path: sourcePath, fileSha: null },
			],
			[
				{ path: destinationPath, fileSha: BLOB_SHA },
				{ path: "README.md", fileSha: null },
			],
		]) {
			await expect(
				executeMediaTransactionCommit(createPlan(false), createPreview(false), {
					gitProvider: {
						commitFilesAtomically: vi.fn().mockResolvedValue({
							commitSha: COMMIT_SHA,
							commitUrl: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
							files,
						}),
					},
					pathConfig,
					checkpointCandidateCommit: async () => undefined,
				}),
			).rejects.toMatchObject({ status: 502, code: "UPSTREAM_ERROR" });
		}
	});
});
