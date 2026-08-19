import { z } from "zod";
import { ApiError } from "../../../core/http/errors";
import {
	type ArticlePathConfig,
	buildArticlePath,
	parseArticleResourceFilename,
} from "../../../core/security/path-policy";
import type { GitDirectoryEntry, GitProvider } from "../../../providers/git/types";
import { parseMarkdownDocument } from "../../../utils/frontmatter-utils";
import { parseSlug } from "../../../utils/slug-utils";
import type { ArticleAssetReference } from "../article-asset";
import { analyzeArticleAssetReferences } from "../article-asset-references";
import {
	MEDIA_TRANSACTION_ARTICLE_MAX_COUNT,
	MEDIA_TRANSACTION_ARTICLE_READ_CONCURRENCY,
	MEDIA_TRANSACTION_ARTICLE_TOTAL_MAX_BYTES,
} from "../media-config";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;

export interface MediaTransactionReferenceClosureArticle {
	storageSlug: string;
	articleSha: string;
	references: readonly ArticleAssetReference[];
}

export interface MediaTransactionReferenceClosure {
	baseCommitSha: string;
	source: MediaTransactionReferenceClosureArticle;
	destination: MediaTransactionReferenceClosureArticle;
	scannedArticleCount: number;
}

export interface ScanMediaTransactionReferenceClosureDependencies {
	gitProvider: Pick<GitProvider, "getFileAtCommit" | "listDirectoryAtCommit">;
	pathConfig: ArticlePathConfig;
}

const requestSchema = z
	.object({
		baseCommitSha: z.string().regex(GIT_OBJECT_SHA),
		source: z
			.object({
				storageSlug: z.unknown(),
				articleSha: z.string().regex(GIT_OBJECT_SHA),
				filename: z.unknown(),
			})
			.strict(),
		destination: z
			.object({
				storageSlug: z.unknown(),
				articleSha: z.string().regex(GIT_OBJECT_SHA),
			})
			.strict(),
	})
	.strict();

function incomplete(message = "无法完整证明受控文章引用闭包，请修复远端文章后重试。"): ApiError {
	return new ApiError(422, "MEDIA_REFERENCE_CLOSURE_INCOMPLETE", message);
}

function getContentRoot(pathConfig: ArticlePathConfig): string {
	const sentinelPath = buildArticlePath("media-transaction-boundary", pathConfig);
	return sentinelPath.slice(0, -`/media-transaction-boundary/${pathConfig.entryFilename}`.length);
}

function listControlledBundleSlugs(
	entries: readonly GitDirectoryEntry[],
	contentRoot: string,
): string[] {
	const slugs: string[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "directory") continue;
		let storageSlug: string;
		try {
			storageSlug = parseSlug(entry.name);
		} catch {
			continue;
		}
		if (entry.path !== `${contentRoot}/${storageSlug}` || seen.has(storageSlug)) throw incomplete();
		seen.add(storageSlug);
		slugs.push(storageSlug);
	}
	return slugs.sort((left, right) => left.localeCompare(right));
}

async function mapWithConcurrency<TInput, TOutput>(
	items: readonly TInput[],
	concurrency: number,
	mapper: (item: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
	const results = new Array<TOutput>(items.length);
	let nextIndex = 0;
	const worker = async () => {
		while (nextIndex < items.length) {
			const index = nextIndex;
			nextIndex += 1;
			const item = items[index];
			if (item !== undefined) results[index] = await mapper(item);
		}
	};
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

interface ScannedArticle extends MediaTransactionReferenceClosureArticle {
	textBytes: number;
}

async function scanArticle(
	storageSlug: string,
	baseCommitSha: string,
	sourceIdentity: { storageSlug: string; filename: string },
	dependencies: ScanMediaTransactionReferenceClosureDependencies,
): Promise<ScannedArticle> {
	const path = buildArticlePath(storageSlug, dependencies.pathConfig);
	const file = await dependencies.gitProvider.getFileAtCommit(path, baseCommitSha);
	if (file.path !== path || file.encoding !== "utf-8") throw incomplete();
	let parsed: ReturnType<typeof parseMarkdownDocument>;
	try {
		parsed = parseMarkdownDocument(file.content);
	} catch {
		throw incomplete();
	}
	let analysis: ReturnType<typeof analyzeArticleAssetReferences>;
	try {
		analysis = analyzeArticleAssetReferences({
			storageSlug,
			frontmatterImage: parsed.frontmatter.image,
			markdown: parsed.markdown,
		});
	} catch {
		throw incomplete();
	}
	if (!analysis.complete || analysis.issues.length > 0) throw incomplete();
	return {
		storageSlug,
		articleSha: file.sha,
		references: analysis.references.filter(
			(reference) =>
				reference.targetStorageSlug === sourceIdentity.storageSlug &&
				reference.targetFilename === sourceIdentity.filename,
		),
		textBytes: new TextEncoder().encode(file.content).byteLength,
	};
}

/**
 * 在调用方已经冻结的 Commit 上扫描全部受控 Page Bundle。资源匹配只使用解析后的
 * `(targetStorageSlug, targetFilename)` 身份；若第三篇文章持有引用，当前双文章事务无法安全
 * 改写完整闭包，因此失败关闭。依赖类型刻意不包含 HEAD 或任何 Git 写能力。
 */
export async function scanMediaTransactionReferenceClosure(
	input: unknown,
	dependencies: ScanMediaTransactionReferenceClosureDependencies,
): Promise<MediaTransactionReferenceClosure> {
	const parsed = requestSchema.parse(input);
	if (
		!dependencies.pathConfig.usePageBundle ||
		dependencies.pathConfig.entryFilename !== "index.md"
	) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "媒体事务引用闭包仅支持固定 Page Bundle。");
	}
	const source = {
		...parsed.source,
		storageSlug: parseSlug(parsed.source.storageSlug),
		filename: parseArticleResourceFilename(parsed.source.filename),
	};
	const destination = {
		...parsed.destination,
		storageSlug: parseSlug(parsed.destination.storageSlug),
	};
	if (source.storageSlug === destination.storageSlug) {
		throw new TypeError("跨文章媒体事务的源文章和目标文章不能相同。");
	}

	const contentRoot = getContentRoot(dependencies.pathConfig);
	let slugs: string[];
	try {
		const entries = await dependencies.gitProvider.listDirectoryAtCommit(
			contentRoot,
			parsed.baseCommitSha,
		);
		slugs = listControlledBundleSlugs(entries, contentRoot);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw incomplete();
	}
	if (
		slugs.length > MEDIA_TRANSACTION_ARTICLE_MAX_COUNT ||
		!slugs.includes(source.storageSlug) ||
		!slugs.includes(destination.storageSlug)
	) {
		throw incomplete();
	}

	let articles: ScannedArticle[];
	try {
		articles = await mapWithConcurrency(
			slugs,
			MEDIA_TRANSACTION_ARTICLE_READ_CONCURRENCY,
			(storageSlug) =>
				scanArticle(
					storageSlug,
					parsed.baseCommitSha,
					{ storageSlug: source.storageSlug, filename: source.filename },
					dependencies,
				),
		);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw incomplete();
	}
	if (
		articles.reduce((total, article) => total + article.textBytes, 0) >
		MEDIA_TRANSACTION_ARTICLE_TOTAL_MAX_BYTES
	) {
		throw incomplete();
	}
	const sourceArticle = articles.find((article) => article.storageSlug === source.storageSlug);
	const destinationArticle = articles.find(
		(article) => article.storageSlug === destination.storageSlug,
	);
	if (
		!sourceArticle ||
		!destinationArticle ||
		sourceArticle.articleSha !== source.articleSha ||
		destinationArticle.articleSha !== destination.articleSha
	) {
		throw new ApiError(409, "MEDIA_PREVIEW_CONFLICT", "文章快照已变化，请重新选择目标。");
	}
	if (
		articles.some(
			(article) =>
				article.storageSlug !== source.storageSlug &&
				article.storageSlug !== destination.storageSlug &&
				article.references.length > 0,
		)
	) {
		throw incomplete("其他受控文章仍引用源资源，当前事务无法安全覆盖完整引用闭包。");
	}
	const toClosureArticle = ({ textBytes: _textBytes, ...article }: ScannedArticle) => article;
	return {
		baseCommitSha: parsed.baseCommitSha,
		source: toClosureArticle(sourceArticle),
		destination: toClosureArticle(destinationArticle),
		scannedArticleCount: articles.length,
	};
}
