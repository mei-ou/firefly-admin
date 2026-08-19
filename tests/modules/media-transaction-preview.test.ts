import { describe, expect, it } from "vitest";
import {
	createMediaTransactionPreviewRequestHash,
	parseMediaTransactionPreview,
	parseMediaTransactionPreviewRequest,
	parseRenameMediaTransactionPreviewRequest,
} from "../../src/modules/media/media-transaction-preview";

const HEAD_SHA = "a".repeat(40);
const ARTICLE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const DESTINATION_ARTICLE_SHA = "d".repeat(40);

function createMoveRequest() {
	return {
		version: 1 as const,
		operation: "move" as const,
		expectedHeadSha: HEAD_SHA,
		source: {
			storageSlug: "source-post",
			filename: "guide.png",
			expectedArticleSha: ARTICLE_SHA,
			expectedBlobSha: BLOB_SHA,
		},
		destination: {
			storageSlug: "destination-post",
			filename: "moved-guide.png",
			expectedArticleSha: DESTINATION_ARTICLE_SHA,
		},
	};
}

function createMovePreview() {
	return {
		version: 1 as const,
		previewId: "preview_1234567890abcdef",
		operation: "move" as const,
		createdAt: "2026-08-17T01:00:00.000Z",
		expiresAt: "2026-08-17T01:10:00.000Z",
		baseCommitSha: HEAD_SHA,
		source: {
			storageSlug: "source-post",
			article: {
				expectedSha: ARTICLE_SHA,
				repositoryPath: "src/content/posts/source-post/index.md",
			},
			resource: {
				filename: "guide.png",
				relativePath: "./guide.png",
				repositoryPath: "src/content/posts/source-post/guide.png",
				blobSha: BLOB_SHA,
			},
			references: [],
		},
		destination: {
			storageSlug: "destination-post",
			article: {
				expectedSha: DESTINATION_ARTICLE_SHA,
				repositoryPath: "src/content/posts/destination-post/index.md",
			},
			resource: {
				filename: "moved-guide.png",
				relativePath: "./moved-guide.png",
				repositoryPath: "src/content/posts/destination-post/moved-guide.png",
				blobSha: BLOB_SHA,
			},
			references: [],
		},
		referenceClosure: {
			complete: true,
			scannedArticleCount: 3,
			thirdPartyReferenceCount: 0,
		},
		effects: [
			{
				type: "resource-reuse" as const,
				repositoryPath: "src/content/posts/destination-post/moved-guide.png",
				from: null,
				to: BLOB_SHA,
			},
			{
				type: "resource-delete" as const,
				repositoryPath: "src/content/posts/source-post/guide.png",
				from: BLOB_SHA,
				to: null,
			},
		],
		policyLevel: "L1" as const,
		riskLevel: "high" as const,
		riskReasons: ["cross-article-change"] as const,
		confirmation: {
			kind: "phrase" as const,
			phrase: "移动 guide.png 到 destination-post/moved-guide.png",
		},
	};
}

function createRequest() {
	return {
		version: 1 as const,
		operation: "rename" as const,
		storageSlug: "hello-world",
		sourceFilename: "old-guide.pdf",
		destinationFilename: "new-guide.pdf",
		expectedHeadSha: HEAD_SHA,
		expectedArticleSha: ARTICLE_SHA,
		expectedBlobSha: BLOB_SHA,
	};
}

function createPreview() {
	return {
		version: 1 as const,
		previewId: "preview_1234567890abcdef",
		operation: "rename" as const,
		storageSlug: "hello-world",
		createdAt: "2026-08-17T01:00:00.000Z",
		expiresAt: "2026-08-17T01:10:00.000Z",
		baseCommitSha: HEAD_SHA,
		expectedArticleSha: ARTICLE_SHA,
		expectedBlobSha: BLOB_SHA,
		source: {
			filename: "old-guide.pdf",
			relativePath: "./old-guide.pdf",
			repositoryPath: "src/content/posts/hello-world/old-guide.pdf",
		},
		destination: {
			filename: "new-guide.pdf",
			relativePath: "./new-guide.pdf",
			repositoryPath: "src/content/posts/hello-world/new-guide.pdf",
		},
		effects: [
			{
				type: "resource-reuse" as const,
				repositoryPath: "src/content/posts/hello-world/new-guide.pdf",
				from: null,
				to: BLOB_SHA,
			},
			{
				type: "resource-delete" as const,
				repositoryPath: "src/content/posts/hello-world/old-guide.pdf",
				from: BLOB_SHA,
				to: null,
			},
		],
		references: [],
		referenceAnalysis: { complete: true, issues: [] },
		policyLevel: "L0" as const,
		riskLevel: "low" as const,
		riskReasons: [],
		confirmation: { kind: "button" as const },
	};
}

describe("媒体事务 Preview 模型", () => {
	it("规范化 strict rename 命令并稳定生成请求哈希", async () => {
		const parsed = parseRenameMediaTransactionPreviewRequest(createRequest());
		expect(parsed).toEqual(createRequest());
		const firstHash = await createMediaTransactionPreviewRequestHash(parsed);
		const secondHash = await createMediaTransactionPreviewRequestHash({ ...parsed });
		expect(firstHash).toBe(secondHash);
		expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
	});

	it("拒绝未知字段、路径输入、原地和仅大小写重命名", () => {
		for (const request of [
			{ ...createRequest(), repositoryPath: "README.md" },
			{ ...createRequest(), destinationFilename: "../secret.pdf" },
			{ ...createRequest(), destinationFilename: "old-guide.pdf" },
			{
				...createRequest(),
				sourceFilename: "Old-Guide.pdf",
				destinationFilename: "old-guide.PDF",
			},
		]) {
			expect(() => parseRenameMediaTransactionPreviewRequest(request)).toThrow();
		}
	});

	it("strict 解析 move 身份并拒绝同 slug、扩展变化和任何路径字段", () => {
		expect(parseMediaTransactionPreviewRequest(createMoveRequest())).toEqual(createMoveRequest());
		for (const request of [
			{
				...createMoveRequest(),
				source: { ...createMoveRequest().source, repositoryPath: "README.md" },
			},
			{
				...createMoveRequest(),
				destination: {
					...createMoveRequest().destination,
					storageSlug: createMoveRequest().source.storageSlug,
				},
			},
			{
				...createMoveRequest(),
				destination: { ...createMoveRequest().destination, filename: "moved-guide.pdf" },
			},
			{
				...createMoveRequest(),
				destination: { ...createMoveRequest().destination, filename: "../guide.png" },
			},
		]) {
			expect(() => parseMediaTransactionPreviewRequest(request)).toThrow();
		}
		expect(() => parseRenameMediaTransactionPreviewRequest(createMoveRequest())).toThrow();
	});

	it("重建 move 双侧路径、effects、闭包、固定 high 风险和确认短语", () => {
		expect(parseMediaTransactionPreview(createMovePreview())).toEqual(createMovePreview());
		for (const preview of [
			{
				...createMovePreview(),
				source: {
					...createMovePreview().source,
					article: { ...createMovePreview().source.article, repositoryPath: "README.md" },
				},
			},
			{ ...createMovePreview(), effects: [...createMovePreview().effects].reverse() },
			{
				...createMovePreview(),
				referenceClosure: {
					...createMovePreview().referenceClosure,
					thirdPartyReferenceCount: 1,
				},
			},
			{ ...createMovePreview(), riskLevel: "medium" },
			{
				...createMovePreview(),
				confirmation: { kind: "phrase", phrase: "移动 guide.png" },
			},
		]) {
			expect(() => parseMediaTransactionPreview(preview)).toThrow();
		}
	});

	it("按 move 双侧引用重建 relative target、effects 和风险原因", () => {
		const sourceReference = {
			source: "markdown-image" as const,
			originalReference: "![图](./guide.png)",
			currentTarget: "./guide.png",
			proposedTarget: "../destination-post/moved-guide.png",
			line: 1,
			column: 1,
		};
		const destinationReference = {
			source: "frontmatter-image" as const,
			originalReference: "../source-post/guide.png",
			currentTarget: "../source-post/guide.png",
			proposedTarget: "./moved-guide.png",
			line: null,
			column: null,
		};
		const preview = {
			...createMovePreview(),
			source: { ...createMovePreview().source, references: [sourceReference] },
			destination: {
				...createMovePreview().destination,
				references: [destinationReference],
			},
			effects: [
				...createMovePreview().effects,
				{
					type: "reference-update" as const,
					repositoryPath: "src/content/posts/source-post/index.md",
					from: "./guide.png",
					to: "../destination-post/moved-guide.png",
				},
				{
					type: "reference-update" as const,
					repositoryPath: "src/content/posts/destination-post/index.md",
					from: "../source-post/guide.png",
					to: "./moved-guide.png",
				},
			],
			riskReasons: ["cross-article-change", "resource-reference", "cover-reference"] as const,
		};
		expect(parseMediaTransactionPreview(preview)).toEqual(preview);
	});

	it("校验服务端重建路径、引用分析与低风险确认不变量", () => {
		expect(parseMediaTransactionPreview(createPreview())).toEqual(createPreview());
		for (const preview of [
			{ ...createPreview(), repositoryPath: "README.md" },
			{
				...createPreview(),
				destination: { ...createPreview().destination, repositoryPath: "README.md" },
			},
			{
				...createPreview(),
				referenceAnalysis: {
					complete: false,
					issues: [{ code: "ambiguous-inline-code", line: null, column: null }],
				},
			},
			{ ...createPreview(), riskLevel: "high" },
		]) {
			expect(() => parseMediaTransactionPreview(preview)).toThrow();
		}
	});

	it("正文引用为中风险按钮确认，封面引用为高风险短语确认", () => {
		const markdownReference = {
			source: "markdown-link" as const,
			originalReference: "[下载](./old-guide.pdf)",
			currentTarget: "./old-guide.pdf",
			proposedTarget: "./new-guide.pdf",
			line: 4,
			column: 1,
		};
		const referencedPreview = {
			...createPreview(),
			effects: [
				...createPreview().effects,
				{
					type: "reference-update" as const,
					repositoryPath: "src/content/posts/hello-world/index.md",
					from: "./old-guide.pdf",
					to: "./new-guide.pdf",
				},
			],
			references: [markdownReference],
			policyLevel: "L1" as const,
			riskLevel: "medium" as const,
			riskReasons: ["resource-reference"] as const,
		};
		expect(parseMediaTransactionPreview(referencedPreview)).toMatchObject({
			policyLevel: "L1",
			riskLevel: "medium",
			confirmation: { kind: "button" },
		});

		const coverPreview = {
			...referencedPreview,
			references: [
				{
					...markdownReference,
					source: "frontmatter-image" as const,
					originalReference: "./old-guide.pdf",
					line: null,
					column: null,
				},
			],
			riskLevel: "high" as const,
			riskReasons: ["resource-reference", "cover-reference"] as const,
			confirmation: { kind: "phrase" as const, phrase: "重命名 old-guide.pdf" },
		};
		expect(parseMediaTransactionPreview(coverPreview)).toMatchObject({
			policyLevel: "L1",
			riskLevel: "high",
			confirmation: { kind: "phrase", phrase: "重命名 old-guide.pdf" },
		});
		for (const confirmation of [
			{ kind: "phrase", phrase: "重命名 new-guide.pdf" },
			{ kind: "phrase", phrase: " 重命名 old-guide.pdf" },
			{ kind: "phrase", phrase: "重命名 old-guide.pdf " },
			{ kind: "button" },
		]) {
			expect(() => parseMediaTransactionPreview({ ...coverPreview, confirmation })).toThrow();
		}
		expect(() =>
			parseMediaTransactionPreview({
				...createPreview(),
				confirmation: { kind: "phrase", phrase: "重命名 old-guide.pdf" },
			}),
		).toThrow();
	});

	it("拒绝无效有效期和额外响应字段", () => {
		for (const preview of [
			{ ...createPreview(), expiresAt: createPreview().createdAt },
			{ ...createPreview(), subject: "subject-1" },
			{ ...createPreview(), effects: [] },
			{
				...createPreview(),
				references: [
					{
						source: "markdown-link",
						originalReference: "[下载](./other.pdf)",
						currentTarget: "./other.pdf",
						proposedTarget: "./new-guide.pdf",
						line: 1,
						column: 1,
					},
				],
			},
		]) {
			expect(() => parseMediaTransactionPreview(preview)).toThrow();
		}
	});
});
