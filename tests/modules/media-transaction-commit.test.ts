import { describe, expect, it } from "vitest";
import {
	createMediaTransactionCommitIdempotencyKeyHash,
	createMediaTransactionCommitPlanHash,
	createMediaTransactionCommitRequestHash,
	parseMediaTransactionCommitPlan,
	parseMediaTransactionCommitRequest,
	parseMediaTransactionCommitResult,
	parseMoveMediaTransactionCommitPlan,
	parseRenameMediaTransactionCommitPlan,
} from "../../src/modules/media/media-transaction-commit";
import type { MediaTransactionPreview } from "../../src/modules/media/media-transaction-preview";

const HEAD_SHA = "a".repeat(40);
const ARTICLE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const COMMIT_SHA = "d".repeat(40);
const FILE_SHA = "e".repeat(40);

function createPreview(cover = false): MediaTransactionPreview {
	const references = cover
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
		source: {
			filename: "old.png",
			relativePath: "./old.png",
			repositoryPath: "src/content/posts/hello-world/old.png",
		},
		destination: {
			filename: "new.png",
			relativePath: "./new.png",
			repositoryPath: "src/content/posts/hello-world/new.png",
		},
		effects: [
			{
				type: "resource-reuse",
				repositoryPath: "src/content/posts/hello-world/new.png",
				from: null,
				to: BLOB_SHA,
			},
			{
				type: "resource-delete",
				repositoryPath: "src/content/posts/hello-world/old.png",
				from: BLOB_SHA,
				to: null,
			},
			...references.map((reference) => ({
				type: "reference-update" as const,
				repositoryPath: "src/content/posts/hello-world/index.md",
				from: reference.currentTarget,
				to: reference.proposedTarget,
			})),
		],
		references,
		referenceAnalysis: { complete: true, issues: [] },
		policyLevel: cover ? "L1" : "L0",
		riskLevel: cover ? "high" : "low",
		riskReasons: cover ? ["resource-reference", "cover-reference"] : [],
		confirmation: cover ? { kind: "phrase", phrase: "重命名 old.png" } : { kind: "button" },
	};
}

function createPlan(cover = false) {
	const originalContent = cover ? "image: ./old.png\n" : 'image: ""\n';
	return {
		version: 1 as const,
		operation: "rename" as const,
		previewId: "preview_1234567890abcdef",
		storageSlug: "hello-world",
		baseCommitSha: HEAD_SHA,
		source: {
			repositoryPath: "src/content/posts/hello-world/old.png",
			blobSha: BLOB_SHA,
		},
		destination: {
			repositoryPath: "src/content/posts/hello-world/new.png",
			reusedBlobSha: BLOB_SHA,
		},
		article: {
			mode: cover ? ("write" as const) : ("unchanged" as const),
			repositoryPath: "src/content/posts/hello-world/index.md",
			expectedSha: ARTICLE_SHA,
			originalContent,
			plannedContent: cover ? "image: ./new.png\n" : originalContent,
			replacements: cover
				? [
						{
							source: "frontmatter-image" as const,
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

function createResult(cover = false) {
	return {
		version: 1 as const,
		operation: "rename" as const,
		previewId: "preview_1234567890abcdef",
		commitSha: COMMIT_SHA,
		url: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
		article: { updated: cover, fileSha: cover ? FILE_SHA : ARTICLE_SHA },
		source: { deleted: true as const },
		destination: { blobSha: BLOB_SHA },
		completedAt: "2026-08-17T01:02:00.000Z",
	};
}

function createMovePreview(): MediaTransactionPreview {
	const sourceReference = {
		source: "markdown-image" as const,
		originalReference: "![源](./old.png)",
		currentTarget: "./old.png",
		proposedTarget: "../destination/new.png",
		line: 1,
		column: 1,
	};
	const destinationReference = {
		source: "markdown-link" as const,
		originalReference: "[旧资源](../source/old.png)",
		currentTarget: "../source/old.png",
		proposedTarget: "./new.png",
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
			storageSlug: "source",
			article: {
				expectedSha: ARTICLE_SHA,
				repositoryPath: "src/content/posts/source/index.md",
			},
			resource: {
				filename: "old.png",
				relativePath: "./old.png",
				repositoryPath: "src/content/posts/source/old.png",
				blobSha: BLOB_SHA,
			},
			references: [sourceReference],
		},
		destination: {
			storageSlug: "destination",
			article: {
				expectedSha: FILE_SHA,
				repositoryPath: "src/content/posts/destination/index.md",
			},
			resource: {
				filename: "new.png",
				relativePath: "./new.png",
				repositoryPath: "src/content/posts/destination/new.png",
				blobSha: BLOB_SHA,
			},
			references: [destinationReference],
		},
		referenceClosure: {
			complete: true,
			scannedArticleCount: 2,
			thirdPartyReferenceCount: 0,
		},
		effects: [
			{
				type: "resource-reuse",
				repositoryPath: "src/content/posts/destination/new.png",
				from: null,
				to: BLOB_SHA,
			},
			{
				type: "resource-delete",
				repositoryPath: "src/content/posts/source/old.png",
				from: BLOB_SHA,
				to: null,
			},
			{
				type: "reference-update",
				repositoryPath: "src/content/posts/source/index.md",
				from: "./old.png",
				to: "../destination/new.png",
			},
			{
				type: "reference-update",
				repositoryPath: "src/content/posts/destination/index.md",
				from: "../source/old.png",
				to: "./new.png",
			},
		],
		policyLevel: "L1",
		riskLevel: "high",
		riskReasons: ["cross-article-change", "resource-reference"],
		confirmation: { kind: "phrase", phrase: "移动 old.png 到 destination/new.png" },
	};
}

function createMovePlan() {
	return {
		version: 1 as const,
		operation: "move" as const,
		previewId: "preview_move_1234567890ab",
		baseCommitSha: HEAD_SHA,
		source: {
			storageSlug: "source",
			resource: {
				repositoryPath: "src/content/posts/source/old.png",
				blobSha: BLOB_SHA,
			},
			article: {
				mode: "write" as const,
				repositoryPath: "src/content/posts/source/index.md",
				expectedSha: ARTICLE_SHA,
				originalContent: "![源](./old.png)\n",
				plannedContent: "![源](../destination/new.png)\n",
				replacements: [
					{
						source: "markdown-image" as const,
						start: 5,
						end: 14,
						before: "./old.png",
						after: "../destination/new.png",
					},
				],
			},
		},
		destination: {
			storageSlug: "destination",
			resource: {
				repositoryPath: "src/content/posts/destination/new.png",
				reusedBlobSha: BLOB_SHA,
			},
			article: {
				mode: "write" as const,
				repositoryPath: "src/content/posts/destination/index.md",
				expectedSha: FILE_SHA,
				originalContent: "[旧资源](../source/old.png)\n",
				plannedContent: "[旧资源](./new.png)\n",
				replacements: [
					{
						source: "markdown-link" as const,
						start: 6,
						end: 23,
						before: "../source/old.png",
						after: "./new.png",
					},
				],
			},
		},
	};
}

function createMoveResult() {
	return {
		version: 1 as const,
		operation: "move" as const,
		previewId: "preview_move_1234567890ab",
		commitSha: COMMIT_SHA,
		url: `https://github.com/owner/repo/commit/${COMMIT_SHA}`,
		articles: {
			source: { updated: true, fileSha: "1".repeat(40) },
			destination: { updated: true, fileSha: "2".repeat(40) },
		},
		source: { deleted: true as const },
		destination: { blobSha: BLOB_SHA },
		completedAt: "2026-08-17T01:02:00.000Z",
	};
}

describe("媒体事务 Commit strict 模型", () => {
	it("body 只接受 previewId 与 confirmation，phrase 不做 trim 或 normalize", () => {
		const preview = createPreview(true);
		const request = {
			previewId: preview.previewId,
			confirmation: { kind: "phrase" as const, phrase: "重命名 old.png" },
		};
		expect(parseMediaTransactionCommitRequest(request, preview)).toEqual(request);
		for (const input of [
			{ ...request, extra: true },
			{ ...request, confirmation: { kind: "phrase", phrase: " 重命名 old.png" } },
			{ ...request, confirmation: { kind: "phrase", phrase: "重命名 old.png " } },
		]) {
			expect(() => parseMediaTransactionCommitRequest(input, preview)).toThrow();
		}
	});

	it("规范 JSON 哈希稳定且区分原始 phrase、request、key 与 plan", async () => {
		const request = {
			confirmation: { phrase: "重命名 old.png", kind: "phrase" as const },
			previewId: createPreview(true).previewId,
		};
		expect(await createMediaTransactionCommitRequestHash(request)).toBe(
			await createMediaTransactionCommitRequestHash({
				previewId: request.previewId,
				confirmation: { kind: "phrase", phrase: "重命名 old.png" },
			}),
		);
		expect(await createMediaTransactionCommitIdempotencyKeyHash("key-1234567890123456")).toMatch(
			/^[a-f0-9]{64}$/,
		);
		expect(
			await createMediaTransactionCommitPlanHash(createPlan(true), createPreview(true)),
		).toMatch(/^[a-f0-9]{64}$/);
	});

	it("Plan 重建路径并交叉验证 Preview、SHA、文章 mode 和 replacements", () => {
		expect(parseRenameMediaTransactionCommitPlan(createPlan(), createPreview())).toEqual(
			createPlan(),
		);
		expect(parseRenameMediaTransactionCommitPlan(createPlan(true), createPreview(true))).toEqual(
			createPlan(true),
		);
		for (const plan of [
			{ ...createPlan(), baseCommitSha: "f".repeat(40) },
			{ ...createPlan(), source: { ...createPlan().source, repositoryPath: "README.md" } },
			{ ...createPlan(), article: { ...createPlan().article, mode: "write" } },
			{
				...createPlan(true),
				article: { ...createPlan(true).article, plannedContent: "tampered" },
			},
		]) {
			expect(() => parseRenameMediaTransactionCommitPlan(plan, createPreview())).toThrow();
		}
	});

	it("Result 绑定 plan、candidate、article mode 和 destination blob", () => {
		expect(
			parseMediaTransactionCommitResult(
				createResult(true),
				createPlan(true),
				createPreview(true),
				COMMIT_SHA,
			),
		).toEqual(createResult(true));
		for (const result of [
			{ ...createResult(), commitSha: "f".repeat(40) },
			{ ...createResult(), destination: { blobSha: "f".repeat(40) } },
			{ ...createResult(), article: { updated: true, fileSha: FILE_SHA } },
		]) {
			expect(() =>
				parseMediaTransactionCommitResult(result, createPlan(), createPreview(), COMMIT_SHA),
			).toThrow();
		}
	});

	it("move request 精确匹配 Preview phrase 且保持 strict body", () => {
		const preview = createMovePreview();
		const request = {
			previewId: preview.previewId,
			confirmation: { kind: "phrase" as const, phrase: "移动 old.png 到 destination/new.png" },
		};
		expect(parseMediaTransactionCommitRequest(request, preview)).toEqual(request);
		for (const input of [
			{ ...request, extra: true },
			{ ...request, confirmation: { kind: "phrase", phrase: `${request.confirmation.phrase} ` } },
			{ ...request, confirmation: { kind: "phrase", phrase: "重命名 old.png" } },
		]) {
			expect(() => parseMediaTransactionCommitRequest(input, preview)).toThrow();
		}
	});

	it("move Plan 重建双文章、双资源、Blob 和两侧 replacements", async () => {
		const preview = createMovePreview();
		const plan = createMovePlan();
		expect(parseMoveMediaTransactionCommitPlan(plan, preview)).toEqual(plan);
		expect(parseMediaTransactionCommitPlan(plan, preview)).toEqual(plan);
		expect(await createMediaTransactionCommitPlanHash(plan, preview)).toMatch(/^[a-f0-9]{64}$/);
		for (const tampered of [
			{ ...plan, baseCommitSha: "f".repeat(40) },
			{
				...plan,
				source: {
					...plan.source,
					article: { ...plan.source.article, repositoryPath: "README.md" },
				},
			},
			{
				...plan,
				destination: {
					...plan.destination,
					resource: { ...plan.destination.resource, reusedBlobSha: "f".repeat(40) },
				},
			},
			{
				...plan,
				source: {
					...plan.source,
					article: { ...plan.source.article, plannedContent: "tampered" },
				},
			},
			{
				...plan,
				destination: {
					...plan.destination,
					article: {
						...plan.destination.article,
						replacements: [
							{
								...plan.destination.article.replacements[0],
								before: "./old.png",
							},
						],
					},
				},
			},
		]) {
			expect(() => parseMoveMediaTransactionCommitPlan(tampered, preview)).toThrow();
		}
	});

	it("move Result strict 绑定双 article mode、unchanged SHA、candidate 与 Blob", () => {
		const preview = createMovePreview();
		const plan = createMovePlan();
		const result = createMoveResult();
		expect(parseMediaTransactionCommitResult(result, plan, preview, COMMIT_SHA)).toEqual(result);
		for (const tampered of [
			{ ...result, commitSha: "f".repeat(40) },
			{ ...result, destination: { blobSha: "f".repeat(40) } },
			{
				...result,
				articles: {
					...result.articles,
					source: { ...result.articles.source, updated: false },
				},
			},
			{
				...result,
				articles: {
					...result.articles,
					destination: { ...result.articles.destination, updated: false },
				},
			},
		]) {
			expect(() =>
				parseMediaTransactionCommitResult(tampered, plan, preview, COMMIT_SHA),
			).toThrow();
		}

		const unchangedPlan = {
			...plan,
			destination: {
				...plan.destination,
				article: {
					...plan.destination.article,
					mode: "unchanged" as const,
					originalContent: "正文\n",
					plannedContent: "正文\n",
					replacements: [],
				},
			},
		};
		const unchangedPreview = {
			...preview,
			destination: { ...preview.destination, references: [] },
			effects: preview.effects.slice(0, 3),
		};
		const unchangedResult = {
			...result,
			articles: {
				...result.articles,
				destination: { updated: false, fileSha: FILE_SHA },
			},
		};
		expect(
			parseMediaTransactionCommitResult(
				unchangedResult,
				unchangedPlan,
				unchangedPreview,
				COMMIT_SHA,
			),
		).toEqual(unchangedResult);
		expect(() =>
			parseMediaTransactionCommitResult(
				{
					...unchangedResult,
					articles: {
						...unchangedResult.articles,
						destination: { updated: false, fileSha: "f".repeat(40) },
					},
				},
				unchangedPlan,
				unchangedPreview,
				COMMIT_SHA,
			),
		).toThrow();
	});
});
