import { z } from "zod";
import {
	type ArticlePathConfig,
	buildArticlePath,
	buildArticleResourcePath,
	buildControlledArticleResourceReference,
	getArticleResourceFilenameConflictKey,
	parseArticleResourceFilename,
} from "../../core/security/path-policy";
import { parseSlug } from "../../utils/slug-utils";
import type { ArticleAssetReferenceSource, ArticleAssetRiskLevel } from "./article-asset";
import type { ArticleAssetReferenceIssueCode } from "./article-asset-references";
import type { ArticleAssetPolicyLevel } from "./article-asset-risk";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const PREVIEW_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,179}$/;
const MAX_REFERENCE_TEXT_LENGTH = 512;
const MAX_PREVIEW_EFFECTS = 20_000;

export type MediaTransactionPreviewRiskReason =
	| "cross-article-change"
	| "resource-reference"
	| "cover-reference";
export type MediaTransactionConfirmation = { kind: "button" } | { kind: "phrase"; phrase: string };

export interface RenameMediaTransactionPreviewRequest {
	version: 1;
	operation: "rename";
	storageSlug: string;
	sourceFilename: string;
	destinationFilename: string;
	expectedHeadSha: string;
	expectedArticleSha: string;
	expectedBlobSha: string;
}

export interface MoveMediaTransactionPreviewRequest {
	version: 1;
	operation: "move";
	expectedHeadSha: string;
	source: {
		storageSlug: string;
		filename: string;
		expectedArticleSha: string;
		expectedBlobSha: string;
	};
	destination: {
		storageSlug: string;
		filename: string;
		expectedArticleSha: string;
	};
}

export type MediaTransactionPreviewRequest =
	| RenameMediaTransactionPreviewRequest
	| MoveMediaTransactionPreviewRequest;

export interface MediaTransactionReferenceImpact {
	source: ArticleAssetReferenceSource;
	originalReference: string;
	currentTarget: string;
	proposedTarget: string;
	line: number | null;
	column: number | null;
}

export interface MediaTransactionPreviewEffect {
	type: "resource-reuse" | "resource-delete" | "reference-update";
	repositoryPath: string;
	from: string | null;
	to: string | null;
}

interface MediaTransactionPreviewBase {
	version: 1;
	previewId: string;
	createdAt: string;
	expiresAt: string;
	baseCommitSha: string;
	effects: readonly MediaTransactionPreviewEffect[];
	policyLevel: ArticleAssetPolicyLevel;
	riskLevel: ArticleAssetRiskLevel;
	riskReasons: readonly MediaTransactionPreviewRiskReason[];
	confirmation: MediaTransactionConfirmation;
}

export interface RenameMediaTransactionPreview extends MediaTransactionPreviewBase {
	operation: "rename";
	storageSlug: string;
	expectedArticleSha: string;
	expectedBlobSha: string;
	source: {
		filename: string;
		relativePath: string;
		repositoryPath: string;
	};
	destination: {
		filename: string;
		relativePath: string;
		repositoryPath: string;
	};
	references: readonly MediaTransactionReferenceImpact[];
	referenceAnalysis: {
		complete: boolean;
		issues: readonly {
			code: ArticleAssetReferenceIssueCode;
			line: number | null;
			column: number | null;
		}[];
	};
}

export interface MoveMediaTransactionPreviewSide {
	storageSlug: string;
	article: {
		expectedSha: string;
		repositoryPath: string;
	};
	resource: {
		filename: string;
		relativePath: string;
		repositoryPath: string;
		blobSha: string;
	};
	references: readonly MediaTransactionReferenceImpact[];
}

export interface MoveMediaTransactionPreview extends MediaTransactionPreviewBase {
	operation: "move";
	source: MoveMediaTransactionPreviewSide;
	destination: MoveMediaTransactionPreviewSide;
	referenceClosure: {
		complete: boolean;
		scannedArticleCount: number;
		thirdPartyReferenceCount: number;
	};
}

export type MediaTransactionPreview = RenameMediaTransactionPreview | MoveMediaTransactionPreview;

export function requireRenameMediaTransactionPreview(
	preview: MediaTransactionPreview,
): RenameMediaTransactionPreview {
	if (preview.operation !== "rename") throw new TypeError("媒体事务 Preview 不是重命名。");
	return preview;
}

const renameRequestSchema = z
	.object({
		version: z.literal(1),
		operation: z.literal("rename"),
		storageSlug: z.unknown(),
		sourceFilename: z.unknown(),
		destinationFilename: z.unknown(),
		expectedHeadSha: z.string().regex(GIT_OBJECT_SHA),
		expectedArticleSha: z.string().regex(GIT_OBJECT_SHA),
		expectedBlobSha: z.string().regex(GIT_OBJECT_SHA),
	})
	.strict();

const moveRequestSchema = z
	.object({
		version: z.literal(1),
		operation: z.literal("move"),
		expectedHeadSha: z.string().regex(GIT_OBJECT_SHA),
		source: z
			.object({
				storageSlug: z.unknown(),
				filename: z.unknown(),
				expectedArticleSha: z.string().regex(GIT_OBJECT_SHA),
				expectedBlobSha: z.string().regex(GIT_OBJECT_SHA),
			})
			.strict(),
		destination: z
			.object({
				storageSlug: z.unknown(),
				filename: z.unknown(),
				expectedArticleSha: z.string().regex(GIT_OBJECT_SHA),
			})
			.strict(),
	})
	.strict();

const requestSchema = z.discriminatedUnion("operation", [renameRequestSchema, moveRequestSchema]);

const referenceIssueSchema = z
	.object({
		code: z.enum([
			"invalid-local-reference",
			"unsupported-local-reference-syntax",
			"ambiguous-inline-code",
		]),
		line: z.number().int().positive().nullable(),
		column: z.number().int().positive().nullable(),
	})
	.strict();

const referenceImpactSchema = z
	.object({
		source: z.enum(["frontmatter-image", "markdown-image", "markdown-link"]),
		originalReference: z.string().min(1).max(MAX_REFERENCE_TEXT_LENGTH),
		currentTarget: z.string().min(1).max(MAX_REFERENCE_TEXT_LENGTH),
		proposedTarget: z.string().min(1).max(MAX_REFERENCE_TEXT_LENGTH),
		line: z.number().int().positive().nullable(),
		column: z.number().int().positive().nullable(),
	})
	.strict();

const effectSchema = z
	.object({
		type: z.enum(["resource-reuse", "resource-delete", "reference-update"]),
		repositoryPath: z.string().min(1).max(512),
		from: z.string().min(1).max(512).nullable(),
		to: z.string().min(1).max(512).nullable(),
	})
	.strict();

const confirmationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("button") }).strict(),
	z.object({ kind: z.literal("phrase"), phrase: z.string().min(1).max(360) }).strict(),
]);

const previewBaseShape = {
	version: z.literal(1),
	previewId: z.string().regex(PREVIEW_ID),
	createdAt: z.iso.datetime({ offset: true }),
	expiresAt: z.iso.datetime({ offset: true }),
	baseCommitSha: z.string().regex(GIT_OBJECT_SHA),
	effects: z.array(effectSchema).max(MAX_PREVIEW_EFFECTS),
	policyLevel: z.enum(["L0", "L1"]),
	riskLevel: z.enum(["low", "medium", "high"]),
	riskReasons: z
		.array(z.enum(["cross-article-change", "resource-reference", "cover-reference"]))
		.max(3),
	confirmation: confirmationSchema,
};

const renamePreviewSchema = z
	.object({
		...previewBaseShape,
		operation: z.literal("rename"),
		storageSlug: z.unknown(),
		expectedArticleSha: z.string().regex(GIT_OBJECT_SHA),
		expectedBlobSha: z.string().regex(GIT_OBJECT_SHA),
		source: z
			.object({
				filename: z.unknown(),
				relativePath: z.string().min(1).max(512),
				repositoryPath: z.string().min(1).max(512),
			})
			.strict(),
		destination: z
			.object({
				filename: z.unknown(),
				relativePath: z.string().min(1).max(512),
				repositoryPath: z.string().min(1).max(512),
			})
			.strict(),
		references: z.array(referenceImpactSchema).max(10_000),
		referenceAnalysis: z
			.object({
				complete: z.boolean(),
				issues: z.array(referenceIssueSchema).max(10_000),
			})
			.strict(),
	})
	.strict();

const moveSideSchema = z
	.object({
		storageSlug: z.unknown(),
		article: z
			.object({
				expectedSha: z.string().regex(GIT_OBJECT_SHA),
				repositoryPath: z.string().min(1).max(512),
			})
			.strict(),
		resource: z
			.object({
				filename: z.unknown(),
				relativePath: z.string().min(1).max(512),
				repositoryPath: z.string().min(1).max(512),
				blobSha: z.string().regex(GIT_OBJECT_SHA),
			})
			.strict(),
		references: z.array(referenceImpactSchema).max(10_000),
	})
	.strict();

const movePreviewSchema = z
	.object({
		...previewBaseShape,
		operation: z.literal("move"),
		source: moveSideSchema,
		destination: moveSideSchema,
		referenceClosure: z
			.object({
				complete: z.boolean(),
				scannedArticleCount: z.number().int().positive().max(10_000),
				thirdPartyReferenceCount: z.number().int().nonnegative().max(10_000),
			})
			.strict(),
	})
	.strict();

const previewSchema = z.discriminatedUnion("operation", [renamePreviewSchema, movePreviewSchema]);

function getExtension(filename: string): string {
	return filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
}

/** Preview 命令只接受客户端可知的资源身份与乐观锁，所有路径均由服务端重建。 */
export function parseMediaTransactionPreviewRequest(
	input: unknown,
): MediaTransactionPreviewRequest {
	const parsed = requestSchema.parse(input);
	if (parsed.operation === "rename") {
		const storageSlug = parseSlug(parsed.storageSlug);
		const sourceFilename = parseArticleResourceFilename(parsed.sourceFilename);
		const destinationFilename = parseArticleResourceFilename(parsed.destinationFilename);
		if (
			getArticleResourceFilenameConflictKey(sourceFilename) ===
			getArticleResourceFilenameConflictKey(destinationFilename)
		) {
			throw new TypeError("资源重命名目标不能与源文件相同或仅大小写不同。");
		}
		return { ...parsed, storageSlug, sourceFilename, destinationFilename };
	}
	const source = {
		...parsed.source,
		storageSlug: parseSlug(parsed.source.storageSlug),
		filename: parseArticleResourceFilename(parsed.source.filename),
	};
	const destination = {
		...parsed.destination,
		storageSlug: parseSlug(parsed.destination.storageSlug),
		filename: parseArticleResourceFilename(parsed.destination.filename),
	};
	if (source.storageSlug === destination.storageSlug) {
		throw new TypeError("跨文章媒体事务的源文章和目标文章不能相同。");
	}
	if (getExtension(source.filename) !== getExtension(destination.filename)) {
		throw new TypeError("跨文章移动不能改变资源扩展名。");
	}
	return { ...parsed, source, destination };
}

/** 保留 E1 rename 调用方导出；非 rename 请求一律拒绝。 */
export function parseRenameMediaTransactionPreviewRequest(
	input: unknown,
): RenameMediaTransactionPreviewRequest {
	const parsed = parseMediaTransactionPreviewRequest(input);
	if (parsed.operation !== "rename") throw new TypeError("媒体事务操作不是重命名。");
	return parsed;
}

/** 规范请求哈希用于同一主体下短 TTL Preview 的稳定复用，不包含主体或服务端生成值。 */
export async function createMediaTransactionPreviewRequestHash(input: unknown): Promise<string> {
	const parsed = parseMediaTransactionPreviewRequest(input);
	const encoded = new TextEncoder().encode(JSON.stringify(parsed));
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertLifetime(createdAtInput: string, expiresAtInput: string): void {
	const createdAt = Date.parse(createdAtInput);
	const expiresAt = Date.parse(expiresAtInput);
	if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= createdAt) {
		throw new TypeError("资源影响预览有效期无效。");
	}
}

function parseRenamePreview(
	parsed: z.infer<typeof renamePreviewSchema>,
	pathConfig?: ArticlePathConfig,
): RenameMediaTransactionPreview {
	const storageSlug = parseSlug(parsed.storageSlug);
	const sourceFilename = parseArticleResourceFilename(parsed.source.filename);
	const destinationFilename = parseArticleResourceFilename(parsed.destination.filename);
	const expectedSourcePath = buildArticleResourcePath(storageSlug, sourceFilename, pathConfig);
	const expectedDestinationPath = buildArticleResourcePath(
		storageSlug,
		destinationFilename,
		pathConfig,
	);
	const expectedArticlePath = buildArticlePath(storageSlug, pathConfig);
	const expectedReferences = parsed.references.map((reference) => ({
		...reference,
		proposedTarget: `./${destinationFilename}`,
	}));
	const expectedEffects: MediaTransactionPreviewEffect[] = [
		{
			type: "resource-reuse",
			repositoryPath: expectedDestinationPath,
			from: null,
			to: parsed.expectedBlobSha,
		},
		{
			type: "resource-delete",
			repositoryPath: expectedSourcePath,
			from: parsed.expectedBlobSha,
			to: null,
		},
		...expectedReferences.map((reference) => ({
			type: "reference-update" as const,
			repositoryPath: expectedArticlePath,
			from: reference.currentTarget,
			to: reference.proposedTarget,
		})),
	];
	if (
		getArticleResourceFilenameConflictKey(sourceFilename) ===
			getArticleResourceFilenameConflictKey(destinationFilename) ||
		parsed.source.relativePath !== `./${sourceFilename}` ||
		parsed.destination.relativePath !== `./${destinationFilename}` ||
		parsed.source.repositoryPath !== expectedSourcePath ||
		parsed.destination.repositoryPath !== expectedDestinationPath ||
		parsed.references.some(
			(reference) =>
				reference.currentTarget !== `./${sourceFilename}` ||
				reference.proposedTarget !== `./${destinationFilename}`,
		) ||
		JSON.stringify(parsed.effects) !== JSON.stringify(expectedEffects)
	) {
		throw new TypeError("资源影响预览路径无效。");
	}
	if (!parsed.referenceAnalysis.complete || parsed.referenceAnalysis.issues.length > 0) {
		throw new TypeError("资源影响预览引用分析不完整。");
	}
	const hasCoverReference = parsed.references.some(
		(reference) => reference.source === "frontmatter-image",
	);
	const expectedRiskLevel: ArticleAssetRiskLevel = hasCoverReference
		? "high"
		: parsed.references.length > 0
			? "medium"
			: "low";
	const expectedPolicyLevel: ArticleAssetPolicyLevel = parsed.references.length > 0 ? "L1" : "L0";
	const expectedReasons: MediaTransactionPreviewRiskReason[] = [];
	if (parsed.references.length > 0) expectedReasons.push("resource-reference");
	if (hasCoverReference) expectedReasons.push("cover-reference");
	if (
		parsed.policyLevel !== expectedPolicyLevel ||
		parsed.riskLevel !== expectedRiskLevel ||
		JSON.stringify(parsed.riskReasons) !== JSON.stringify(expectedReasons) ||
		(hasCoverReference &&
			(parsed.confirmation.kind !== "phrase" ||
				parsed.confirmation.phrase !== `重命名 ${sourceFilename}`)) ||
		(!hasCoverReference && parsed.confirmation.kind !== "button")
	) {
		throw new TypeError("资源影响预览风险或确认要求无效。");
	}
	assertLifetime(parsed.createdAt, parsed.expiresAt);
	return {
		...parsed,
		storageSlug,
		source: { ...parsed.source, filename: sourceFilename },
		destination: { ...parsed.destination, filename: destinationFilename },
	};
}

function parseMovePreview(
	parsed: z.infer<typeof movePreviewSchema>,
	pathConfig?: ArticlePathConfig,
): MoveMediaTransactionPreview {
	const sourceSlug = parseSlug(parsed.source.storageSlug);
	const destinationSlug = parseSlug(parsed.destination.storageSlug);
	const sourceFilename = parseArticleResourceFilename(parsed.source.resource.filename);
	const destinationFilename = parseArticleResourceFilename(parsed.destination.resource.filename);
	if (
		sourceSlug === destinationSlug ||
		getExtension(sourceFilename) !== getExtension(destinationFilename)
	) {
		throw new TypeError("跨文章资源影响预览身份无效。");
	}
	const sourceArticlePath = buildArticlePath(sourceSlug, pathConfig);
	const destinationArticlePath = buildArticlePath(destinationSlug, pathConfig);
	const sourceResourcePath = buildArticleResourcePath(sourceSlug, sourceFilename, pathConfig);
	const destinationResourcePath = buildArticleResourcePath(
		destinationSlug,
		destinationFilename,
		pathConfig,
	);
	const sourceCurrentTarget = `./${sourceFilename}`;
	const destinationCurrentTarget = buildControlledArticleResourceReference(
		destinationSlug,
		sourceSlug,
		sourceFilename,
		pathConfig,
	);
	const sourceProposedTarget = buildControlledArticleResourceReference(
		sourceSlug,
		destinationSlug,
		destinationFilename,
		pathConfig,
	);
	const destinationProposedTarget = `./${destinationFilename}`;
	const sourceReferences = parsed.source.references.map((reference) => ({
		...reference,
		proposedTarget: sourceProposedTarget,
	}));
	const destinationReferences = parsed.destination.references.map((reference) => ({
		...reference,
		proposedTarget: destinationProposedTarget,
	}));
	const expectedEffects: MediaTransactionPreviewEffect[] = [
		{
			type: "resource-reuse",
			repositoryPath: destinationResourcePath,
			from: null,
			to: parsed.source.resource.blobSha,
		},
		{
			type: "resource-delete",
			repositoryPath: sourceResourcePath,
			from: parsed.source.resource.blobSha,
			to: null,
		},
		...sourceReferences.map((reference) => ({
			type: "reference-update" as const,
			repositoryPath: sourceArticlePath,
			from: reference.currentTarget,
			to: reference.proposedTarget,
		})),
		...destinationReferences.map((reference) => ({
			type: "reference-update" as const,
			repositoryPath: destinationArticlePath,
			from: reference.currentTarget,
			to: reference.proposedTarget,
		})),
	];
	const allReferences = [...sourceReferences, ...destinationReferences];
	const hasCoverReference = allReferences.some(
		(reference) => reference.source === "frontmatter-image",
	);
	const expectedReasons: MediaTransactionPreviewRiskReason[] = ["cross-article-change"];
	if (allReferences.length > 0) expectedReasons.push("resource-reference");
	if (hasCoverReference) expectedReasons.push("cover-reference");
	const phrase = `移动 ${sourceFilename} 到 ${destinationSlug}/${destinationFilename}`;
	if (
		parsed.source.article.repositoryPath !== sourceArticlePath ||
		parsed.destination.article.repositoryPath !== destinationArticlePath ||
		parsed.source.resource.relativePath !== sourceCurrentTarget ||
		parsed.destination.resource.relativePath !== destinationProposedTarget ||
		parsed.source.resource.repositoryPath !== sourceResourcePath ||
		parsed.destination.resource.repositoryPath !== destinationResourcePath ||
		parsed.destination.resource.blobSha !== parsed.source.resource.blobSha ||
		parsed.source.references.some((reference) => reference.currentTarget !== sourceCurrentTarget) ||
		parsed.destination.references.some(
			(reference) => reference.currentTarget !== destinationCurrentTarget,
		) ||
		!parsed.referenceClosure.complete ||
		parsed.referenceClosure.thirdPartyReferenceCount !== 0 ||
		JSON.stringify(parsed.effects) !== JSON.stringify(expectedEffects)
	) {
		throw new TypeError("跨文章资源影响预览路径或闭包无效。");
	}
	if (
		parsed.policyLevel !== "L1" ||
		parsed.riskLevel !== "high" ||
		JSON.stringify(parsed.riskReasons) !== JSON.stringify(expectedReasons) ||
		parsed.confirmation.kind !== "phrase" ||
		parsed.confirmation.phrase !== phrase
	) {
		throw new TypeError("跨文章资源影响预览风险或确认要求无效。");
	}
	assertLifetime(parsed.createdAt, parsed.expiresAt);
	return {
		...parsed,
		source: {
			...parsed.source,
			storageSlug: sourceSlug,
			resource: { ...parsed.source.resource, filename: sourceFilename },
		},
		destination: {
			...parsed.destination,
			storageSlug: destinationSlug,
			resource: { ...parsed.destination.resource, filename: destinationFilename },
		},
	};
}

/** 对 API 和持久化快照执行 strict 校验，并重建全部派生路径、effects、风险和确认短语。 */
export function parseMediaTransactionPreview(
	input: unknown,
	pathConfig?: ArticlePathConfig,
): MediaTransactionPreview {
	const parsed = previewSchema.parse(input);
	return parsed.operation === "rename"
		? parseRenamePreview(parsed, pathConfig)
		: parseMovePreview(parsed, pathConfig);
}
