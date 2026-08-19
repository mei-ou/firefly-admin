import { z } from "zod";
import {
	type ArticlePathConfig,
	buildArticlePath,
	buildArticleResourcePath,
	buildControlledArticleResourceReference,
} from "../../core/security/path-policy";
import {
	type MediaTransactionPreview,
	parseMediaTransactionPreview,
	requireRenameMediaTransactionPreview,
} from "./media-transaction-preview";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const PREVIEW_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,179}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,200}$/;
const MAX_ARTICLE_CONTENT_LENGTH = 2_000_000;
const MAX_REPLACEMENTS = 10_000;

export type MediaTransactionCommitConfirmation =
	| { kind: "button" }
	| { kind: "phrase"; phrase: string };

export interface MediaTransactionCommitRequest {
	previewId: string;
	confirmation: MediaTransactionCommitConfirmation;
}

export interface MediaTransactionReferenceReplacement {
	source: "frontmatter-image" | "markdown-image" | "markdown-link";
	start: number;
	end: number;
	before: string;
	after: string;
}

export interface MediaTransactionCommitArticlePlan {
	mode: "write" | "unchanged";
	repositoryPath: string;
	expectedSha: string;
	originalContent: string;
	plannedContent: string;
	replacements: readonly MediaTransactionReferenceReplacement[];
}

export interface RenameMediaTransactionCommitPlan {
	version: 1;
	operation: "rename";
	previewId: string;
	storageSlug: string;
	baseCommitSha: string;
	source: {
		repositoryPath: string;
		blobSha: string;
	};
	destination: {
		repositoryPath: string;
		reusedBlobSha: string;
	};
	article: MediaTransactionCommitArticlePlan;
}

export interface MoveMediaTransactionCommitPlan {
	version: 1;
	operation: "move";
	previewId: string;
	baseCommitSha: string;
	source: {
		storageSlug: string;
		resource: {
			repositoryPath: string;
			blobSha: string;
		};
		article: MediaTransactionCommitArticlePlan;
	};
	destination: {
		storageSlug: string;
		resource: {
			repositoryPath: string;
			reusedBlobSha: string;
		};
		article: MediaTransactionCommitArticlePlan;
	};
}

export type MediaTransactionCommitPlan =
	| RenameMediaTransactionCommitPlan
	| MoveMediaTransactionCommitPlan;

export interface RenameMediaTransactionCommitResult {
	articles?: never;
	version: 1;
	operation: "rename";
	previewId: string;
	commitSha: string;
	url: string;
	article: {
		updated: boolean;
		fileSha: string;
	};
	source: {
		deleted: true;
	};
	destination: {
		blobSha: string;
	};
	completedAt: string;
}

export interface MoveMediaTransactionCommitResult {
	article?: never;
	version: 1;
	operation: "move";
	previewId: string;
	commitSha: string;
	url: string;
	articles: {
		source: {
			updated: boolean;
			fileSha: string;
		};
		destination: {
			updated: boolean;
			fileSha: string;
		};
	};
	source: {
		deleted: true;
	};
	destination: {
		blobSha: string;
	};
	completedAt: string;
}

export type MediaTransactionCommitResult =
	| RenameMediaTransactionCommitResult
	| MoveMediaTransactionCommitResult;

const confirmationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("button") }).strict(),
	z.object({ kind: z.literal("phrase"), phrase: z.string().min(1).max(360) }).strict(),
]);

const commitRequestSchema = z
	.object({
		previewId: z.string().regex(PREVIEW_ID),
		confirmation: confirmationSchema,
	})
	.strict();

const replacementSchema = z
	.object({
		source: z.enum(["frontmatter-image", "markdown-image", "markdown-link"]),
		start: z.number().int().nonnegative(),
		end: z.number().int().positive(),
		before: z.string().min(1).max(512),
		after: z.string().min(1).max(512),
	})
	.strict();

const articlePlanSchema = z
	.object({
		mode: z.enum(["write", "unchanged"]),
		repositoryPath: z.string().min(1).max(512),
		expectedSha: z.string().regex(GIT_OBJECT_SHA),
		originalContent: z.string().max(MAX_ARTICLE_CONTENT_LENGTH),
		plannedContent: z.string().max(MAX_ARTICLE_CONTENT_LENGTH),
		replacements: z.array(replacementSchema).max(MAX_REPLACEMENTS),
	})
	.strict();

const renameCommitPlanSchema = z
	.object({
		version: z.literal(1),
		operation: z.literal("rename"),
		previewId: z.string().regex(PREVIEW_ID),
		storageSlug: z.string(),
		baseCommitSha: z.string().regex(GIT_OBJECT_SHA),
		source: z
			.object({
				repositoryPath: z.string().min(1).max(512),
				blobSha: z.string().regex(GIT_OBJECT_SHA),
			})
			.strict(),
		destination: z
			.object({
				repositoryPath: z.string().min(1).max(512),
				reusedBlobSha: z.string().regex(GIT_OBJECT_SHA),
			})
			.strict(),
		article: articlePlanSchema,
	})
	.strict();

const moveCommitPlanSideSchema = z
	.object({
		storageSlug: z.string(),
		resource: z
			.object({
				repositoryPath: z.string().min(1).max(512),
				blobSha: z.string().regex(GIT_OBJECT_SHA).optional(),
				reusedBlobSha: z.string().regex(GIT_OBJECT_SHA).optional(),
			})
			.strict(),
		article: articlePlanSchema,
	})
	.strict();

const moveCommitPlanSchema = z
	.object({
		version: z.literal(1),
		operation: z.literal("move"),
		previewId: z.string().regex(PREVIEW_ID),
		baseCommitSha: z.string().regex(GIT_OBJECT_SHA),
		source: moveCommitPlanSideSchema,
		destination: moveCommitPlanSideSchema,
	})
	.strict();

const resultArticleSchema = z
	.object({
		updated: z.boolean(),
		fileSha: z.string().regex(GIT_OBJECT_SHA),
	})
	.strict();

const renameCommitResultSchema = z
	.object({
		version: z.literal(1),
		operation: z.literal("rename"),
		previewId: z.string().regex(PREVIEW_ID),
		commitSha: z.string().regex(GIT_OBJECT_SHA),
		url: z.url().refine((value) => new URL(value).protocol === "https:"),
		article: resultArticleSchema,
		source: z.object({ deleted: z.literal(true) }).strict(),
		destination: z.object({ blobSha: z.string().regex(GIT_OBJECT_SHA) }).strict(),
		completedAt: z.iso.datetime({ offset: true }),
	})
	.strict();

const moveCommitResultSchema = z
	.object({
		version: z.literal(1),
		operation: z.literal("move"),
		previewId: z.string().regex(PREVIEW_ID),
		commitSha: z.string().regex(GIT_OBJECT_SHA),
		url: z.url().refine((value) => new URL(value).protocol === "https:"),
		articles: z
			.object({
				source: resultArticleSchema,
				destination: resultArticleSchema,
			})
			.strict(),
		source: z.object({ deleted: z.literal(true) }).strict(),
		destination: z.object({ blobSha: z.string().regex(GIT_OBJECT_SHA) }).strict(),
		completedAt: z.iso.datetime({ offset: true }),
	})
	.strict();

function canonicalJson(input: unknown): string {
	if (input === null || typeof input === "string" || typeof input === "boolean") {
		return JSON.stringify(input);
	}
	if (typeof input === "number") {
		if (!Number.isFinite(input)) throw new TypeError("规范 JSON 不接受非有限数字。");
		return JSON.stringify(input);
	}
	if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
	if (typeof input === "object") {
		const record = input as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new TypeError("规范 JSON 包含不支持的值。");
}

async function sha256CanonicalJson(input: unknown): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(canonicalJson(input)),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertCommitConfirmation(
	request: MediaTransactionCommitRequest,
	preview: MediaTransactionPreview,
): void {
	if (request.previewId !== preview.previewId) throw new TypeError("Commit 与 Preview 不匹配。");
	if (preview.confirmation.kind === "button") {
		if (request.confirmation.kind !== "button") throw new TypeError("Commit 确认方式无效。");
		return;
	}
	if (
		request.confirmation.kind !== "phrase" ||
		request.confirmation.phrase !== preview.confirmation.phrase
	) {
		throw new TypeError("Commit 确认短语无效。");
	}
}

/** Commit body 只接受 previewId 和 confirmation；确认短语保持原始字节，不做 trim 或 normalize。 */
export function parseMediaTransactionCommitRequest(
	input: unknown,
	previewInput?: unknown,
	pathConfig?: ArticlePathConfig,
): MediaTransactionCommitRequest {
	const request = commitRequestSchema.parse(input);
	if (previewInput !== undefined) {
		assertCommitConfirmation(request, parseMediaTransactionPreview(previewInput, pathConfig));
	}
	return request;
}

export const parseRenameMediaTransactionCommitRequest = parseMediaTransactionCommitRequest;

export async function createMediaTransactionCommitRequestHash(input: unknown): Promise<string> {
	return sha256CanonicalJson(parseMediaTransactionCommitRequest(input));
}

export async function createMediaTransactionCommitIdempotencyKeyHash(
	input: unknown,
): Promise<string> {
	const key = z.string().regex(IDEMPOTENCY_KEY).parse(input);
	return sha256CanonicalJson({ key });
}

function applyPlannedReplacements(
	originalContent: string,
	replacements: readonly MediaTransactionReferenceReplacement[],
): string {
	let content = originalContent;
	let previousStart = originalContent.length + 1;
	for (const replacement of replacements) {
		if (
			replacement.end <= replacement.start ||
			replacement.end > originalContent.length ||
			replacement.end > previousStart ||
			originalContent.slice(replacement.start, replacement.end) !== replacement.before
		) {
			throw new TypeError("Commit Plan 引用替换范围无效。");
		}
		content = `${content.slice(0, replacement.start)}${replacement.after}${content.slice(replacement.end)}`;
		previousStart = replacement.start;
	}
	return content;
}

function assertArticlePlan(
	article: MediaTransactionCommitArticlePlan,
	expected: {
		repositoryPath: string;
		expectedSha: string;
		referenceSources: readonly MediaTransactionReferenceReplacement["source"][];
		before: string;
		after: string;
	},
): void {
	const plannedContent = applyPlannedReplacements(article.originalContent, article.replacements);
	const expectedMode = expected.referenceSources.length === 0 ? "unchanged" : "write";
	const expectedSources = [...expected.referenceSources].sort();
	const replacementSources = article.replacements.map((replacement) => replacement.source).sort();
	if (
		article.repositoryPath !== expected.repositoryPath ||
		article.expectedSha !== expected.expectedSha ||
		article.mode !== expectedMode ||
		article.plannedContent !== plannedContent ||
		JSON.stringify(expectedSources) !== JSON.stringify(replacementSources) ||
		article.replacements.some(
			(replacement) =>
				replacement.before !== expected.before || replacement.after !== expected.after,
		) ||
		(article.mode === "unchanged" &&
			(article.replacements.length !== 0 || article.originalContent !== article.plannedContent)) ||
		(article.mode === "write" &&
			(article.replacements.length === 0 || article.originalContent === article.plannedContent))
	) {
		throw new TypeError("Commit Plan 与 Preview 或文章改写不一致。");
	}
}

/** 从 strict JSON 重建所有仓库路径，并与不可变 Preview、SHA 和文章改写计划交叉验证。 */
export function parseRenameMediaTransactionCommitPlan(
	input: unknown,
	previewInput: unknown,
	pathConfig?: ArticlePathConfig,
): RenameMediaTransactionCommitPlan {
	const plan = renameCommitPlanSchema.parse(input);
	const preview = requireRenameMediaTransactionPreview(
		parseMediaTransactionPreview(previewInput, pathConfig),
	);
	const sourcePath = buildArticleResourcePath(
		preview.storageSlug,
		preview.source.filename,
		pathConfig,
	);
	const destinationPath = buildArticleResourcePath(
		preview.storageSlug,
		preview.destination.filename,
		pathConfig,
	);
	if (
		plan.previewId !== preview.previewId ||
		plan.storageSlug !== preview.storageSlug ||
		plan.baseCommitSha !== preview.baseCommitSha ||
		plan.source.repositoryPath !== sourcePath ||
		plan.source.blobSha !== preview.expectedBlobSha ||
		plan.destination.repositoryPath !== destinationPath ||
		plan.destination.reusedBlobSha !== preview.expectedBlobSha
	) {
		throw new TypeError("Commit Plan 与 Preview 或文章改写不一致。");
	}
	assertArticlePlan(plan.article, {
		repositoryPath: buildArticlePath(preview.storageSlug, pathConfig),
		expectedSha: preview.expectedArticleSha,
		referenceSources: preview.references.map((reference) => reference.source),
		before: `./${preview.source.filename}`,
		after: `./${preview.destination.filename}`,
	});
	return plan;
}

/**
 * Move Plan 不信任持久化路径或替换文本：两篇文章和两个资源路径都从 strict Preview
 * 重建，跨 Bundle 引用仅由 controlled builder 生成，防止 Plan JSON 扩大写入边界。
 */
export function parseMoveMediaTransactionCommitPlan(
	input: unknown,
	previewInput: unknown,
	pathConfig?: ArticlePathConfig,
): MoveMediaTransactionCommitPlan {
	const parsed = moveCommitPlanSchema.parse(input);
	if (
		parsed.source.resource.blobSha === undefined ||
		parsed.source.resource.reusedBlobSha !== undefined ||
		parsed.destination.resource.reusedBlobSha === undefined ||
		parsed.destination.resource.blobSha !== undefined
	) {
		throw new TypeError("Move Commit Plan 资源字段无效。");
	}
	const plan = parsed as MoveMediaTransactionCommitPlan;
	const preview = parseMediaTransactionPreview(previewInput, pathConfig);
	if (preview.operation !== "move") throw new TypeError("媒体事务 Preview 不是移动。");
	const sourceResourcePath = buildArticleResourcePath(
		preview.source.storageSlug,
		preview.source.resource.filename,
		pathConfig,
	);
	const destinationResourcePath = buildArticleResourcePath(
		preview.destination.storageSlug,
		preview.destination.resource.filename,
		pathConfig,
	);
	if (
		plan.previewId !== preview.previewId ||
		plan.baseCommitSha !== preview.baseCommitSha ||
		plan.source.storageSlug !== preview.source.storageSlug ||
		plan.destination.storageSlug !== preview.destination.storageSlug ||
		plan.source.resource.repositoryPath !== sourceResourcePath ||
		plan.source.resource.blobSha !== preview.source.resource.blobSha ||
		plan.destination.resource.repositoryPath !== destinationResourcePath ||
		plan.destination.resource.reusedBlobSha !== preview.source.resource.blobSha ||
		preview.destination.resource.blobSha !== preview.source.resource.blobSha
	) {
		throw new TypeError("Move Commit Plan 与 Preview 不一致。");
	}
	assertArticlePlan(plan.source.article, {
		repositoryPath: buildArticlePath(preview.source.storageSlug, pathConfig),
		expectedSha: preview.source.article.expectedSha,
		referenceSources: preview.source.references.map((reference) => reference.source),
		before: buildControlledArticleResourceReference(
			preview.source.storageSlug,
			preview.source.storageSlug,
			preview.source.resource.filename,
			pathConfig,
		),
		after: buildControlledArticleResourceReference(
			preview.source.storageSlug,
			preview.destination.storageSlug,
			preview.destination.resource.filename,
			pathConfig,
		),
	});
	assertArticlePlan(plan.destination.article, {
		repositoryPath: buildArticlePath(preview.destination.storageSlug, pathConfig),
		expectedSha: preview.destination.article.expectedSha,
		referenceSources: preview.destination.references.map((reference) => reference.source),
		before: buildControlledArticleResourceReference(
			preview.destination.storageSlug,
			preview.source.storageSlug,
			preview.source.resource.filename,
			pathConfig,
		),
		after: buildControlledArticleResourceReference(
			preview.destination.storageSlug,
			preview.destination.storageSlug,
			preview.destination.resource.filename,
			pathConfig,
		),
	});
	return plan;
}

export function parseMediaTransactionCommitPlan(
	input: unknown,
	previewInput: unknown,
	pathConfig?: ArticlePathConfig,
): MediaTransactionCommitPlan {
	const preview = parseMediaTransactionPreview(previewInput, pathConfig);
	return preview.operation === "rename"
		? parseRenameMediaTransactionCommitPlan(input, preview, pathConfig)
		: parseMoveMediaTransactionCommitPlan(input, preview, pathConfig);
}

export async function createRenameMediaTransactionCommitPlanHash(
	input: unknown,
	previewInput: unknown,
	pathConfig?: ArticlePathConfig,
): Promise<string> {
	return sha256CanonicalJson(
		parseRenameMediaTransactionCommitPlan(input, previewInput, pathConfig),
	);
}

export async function createMediaTransactionCommitPlanHash(
	input: unknown,
	previewInput: unknown,
	pathConfig?: ArticlePathConfig,
): Promise<string> {
	return sha256CanonicalJson(parseMediaTransactionCommitPlan(input, previewInput, pathConfig));
}

function assertResultArticle(
	result: { updated: boolean; fileSha: string },
	plan: MediaTransactionCommitArticlePlan,
): void {
	if (
		result.updated !== (plan.mode === "write") ||
		(plan.mode === "unchanged" && result.fileSha !== plan.expectedSha)
	) {
		throw new TypeError("Commit Result 与文章 Plan 不一致。");
	}
}

/** Result 必须绑定同一 Plan、候选 Commit、资源 Blob 和文章模式，不能信任已存 JSON。 */
export function parseMediaTransactionCommitResult(
	input: unknown,
	planInput: unknown,
	previewInput: unknown,
	candidateCommitSha?: string,
	pathConfig?: ArticlePathConfig,
): MediaTransactionCommitResult {
	const preview = parseMediaTransactionPreview(previewInput, pathConfig);
	const plan = parseMediaTransactionCommitPlan(planInput, preview, pathConfig);
	if (plan.operation === "rename") {
		const result = renameCommitResultSchema.parse(input);
		assertResultArticle(result.article, plan.article);
		if (
			result.previewId !== plan.previewId ||
			result.destination.blobSha !== plan.destination.reusedBlobSha ||
			(candidateCommitSha !== undefined && result.commitSha !== candidateCommitSha)
		) {
			throw new TypeError("Commit Result 与 Plan 或候选 Commit 不一致。");
		}
		return result;
	}
	const result = moveCommitResultSchema.parse(input);
	assertResultArticle(result.articles.source, plan.source.article);
	assertResultArticle(result.articles.destination, plan.destination.article);
	if (
		result.previewId !== plan.previewId ||
		result.destination.blobSha !== plan.destination.resource.reusedBlobSha ||
		(candidateCommitSha !== undefined && result.commitSha !== candidateCommitSha)
	) {
		throw new TypeError("Commit Result 与 Plan 或候选 Commit 不一致。");
	}
	return result;
}
