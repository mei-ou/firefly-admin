import { z } from "zod";
import { articleConfig } from "../../../config/articleConfig";
import { type ArticlePathConfig, buildArticlePath } from "../../../core/security/path-policy";
import type { GitProvider } from "../../../providers/git/types";
import type { ArticleListResult, ArticleSummary, RemoteArticle } from "../../../types/article";
import { parseSlug } from "../../../utils/slug-utils";
import { readArticle } from "./read-article";

export const ARTICLE_LIST_MAX_SCAN = 100;
export const ARTICLE_LIST_READ_CONCURRENCY = 5;
export const ARTICLE_LIST_DEFAULT_PAGE_SIZE = 20;
export const ARTICLE_LIST_MAX_PAGE_SIZE = 50;

const articleListQuerySchema = z
	.object({
		page: z.coerce.number().int().min(1).max(10_000).default(1),
		pageSize: z.coerce
			.number()
			.int()
			.min(1)
			.max(ARTICLE_LIST_MAX_PAGE_SIZE)
			.default(ARTICLE_LIST_DEFAULT_PAGE_SIZE),
		query: z.string().trim().max(100).default(""),
	})
	.strict();

export interface ArticleListQuery {
	page?: unknown;
	pageSize?: unknown;
	query?: unknown;
}

export type ValidatedArticleListQuery = z.infer<typeof articleListQuerySchema>;

/** 供 API 在限流和 Provider 初始化前复用同一份查询边界，避免校验顺序发生漂移。 */
export function parseArticleListQuery(input: ArticleListQuery): ValidatedArticleListQuery {
	return articleListQuerySchema.parse(input);
}

export interface ListArticlesDependencies {
	gitProvider: Pick<GitProvider, "listDirectory" | "getFile">;
	pathConfig?: ArticlePathConfig;
	maxScan?: number;
	readConcurrency?: number;
}

function parseBoundedInteger(value: number | undefined, fallback: number, maximum: number): number {
	const candidate = value ?? fallback;
	if (!Number.isInteger(candidate) || candidate < 1 || candidate > maximum) {
		throw new TypeError("文章列表服务配置无效。");
	}
	return candidate;
}

function toSummary(article: RemoteArticle): ArticleSummary {
	const { updated } = article.frontmatter;
	return {
		storageSlug: article.storageSlug,
		...(article.slug === undefined ? {} : { slug: article.slug }),
		title: article.frontmatter.title,
		published: article.frontmatter.published,
		...(updated === undefined ? {} : { updated }),
		draft: article.frontmatter.draft,
		description: article.frontmatter.description,
		tags: article.frontmatter.tags,
		category: article.frontmatter.category,
		pinned: article.frontmatter.pinned,
	};
}

function compareArticleSummaries(left: ArticleSummary, right: ArticleSummary): number {
	if (left.pinned !== right.pinned) {
		return left.pinned ? -1 : 1;
	}
	const dateDifference = right.published.getTime() - left.published.getTime();
	return dateDifference !== 0 ? dateDifference : left.storageSlug.localeCompare(right.storageSlug);
}

function matchesQuery(article: ArticleSummary, normalizedQuery: string): boolean {
	if (normalizedQuery.length === 0) {
		return true;
	}
	const searchableValues = [
		article.storageSlug,
		article.slug ?? "",
		article.title,
		article.description,
		article.category ?? "",
		...article.tags,
	];
	return searchableValues.some((value) =>
		value.normalize("NFKC").toLocaleLowerCase().includes(normalizedQuery),
	);
}

/**
 * 以固定数量和固定并发读取文章摘要。扫描上限在读取任何文章文件前截断，因此一次列表
 * 请求不会随仓库规模无限放大；单篇缺失或格式损坏只计入 skipped，不让整个列表失败。
 * 根目录列表失败仍会直接抛出，因为此时无法建立可信候选集合。
 */
export async function listArticles(
	queryInput: ArticleListQuery,
	dependencies: ListArticlesDependencies,
): Promise<ArticleListResult> {
	const query = parseArticleListQuery(queryInput);
	const pathConfig = dependencies.pathConfig ?? articleConfig;
	if (!pathConfig.usePageBundle) {
		throw new TypeError("P1 仅支持 Page Bundle 文章列表。");
	}
	const maxScan = parseBoundedInteger(
		dependencies.maxScan,
		ARTICLE_LIST_MAX_SCAN,
		ARTICLE_LIST_MAX_SCAN,
	);
	const readConcurrency = parseBoundedInteger(
		dependencies.readConcurrency,
		ARTICLE_LIST_READ_CONCURRENCY,
		ARTICLE_LIST_READ_CONCURRENCY,
	);

	// 复用路径策略验证配置，并从固定文章路径反推出已经过验证的内容根目录。
	const sentinelPath = buildArticlePath("list-boundary-check", pathConfig);
	const contentRootSuffix = `/list-boundary-check/${pathConfig.entryFilename}`;
	const contentRoot = sentinelPath.slice(0, -contentRootSuffix.length);
	const entries = await dependencies.gitProvider.listDirectory(contentRoot);
	const candidates = entries
		.filter((entry) => entry.type === "directory")
		.map((entry) => {
			try {
				const storageSlug = parseSlug(entry.name);
				const expectedPath = `${contentRoot}/${storageSlug}`;
				return entry.path === expectedPath ? storageSlug : null;
			} catch {
				return null;
			}
		})
		.filter((storageSlug): storageSlug is string => storageSlug !== null)
		.sort((left, right) => left.localeCompare(right));
	const selected = candidates.slice(0, maxScan);
	const summaries: ArticleSummary[] = [];
	let skipped = 0;
	let nextIndex = 0;

	const worker = async () => {
		while (nextIndex < selected.length) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			const storageSlug = selected[currentIndex];
			if (storageSlug === undefined) {
				continue;
			}
			try {
				const article = await readArticle(storageSlug, {
					gitProvider: dependencies.gitProvider,
					pathConfig,
				});
				summaries.push(toSummary(article));
			} catch {
				// 候选目录来自不可信远端仓库；列表只记录跳过数量，不暴露文件名和解析细节。
				skipped += 1;
			}
		}
	};
	await Promise.all(Array.from({ length: Math.min(readConcurrency, selected.length) }, worker));

	const normalizedQuery = query.query.normalize("NFKC").toLocaleLowerCase();
	const filtered = summaries.filter((article) => matchesQuery(article, normalizedQuery));
	filtered.sort(compareArticleSummaries);
	const total = filtered.length;
	const totalPages = total === 0 ? 0 : Math.ceil(total / query.pageSize);
	const start = (query.page - 1) * query.pageSize;

	return {
		items: filtered.slice(start, start + query.pageSize),
		page: query.page,
		pageSize: query.pageSize,
		total,
		totalPages,
		candidateCount: candidates.length,
		scanned: selected.length,
		skipped,
		truncated: candidates.length > selected.length,
	};
}
