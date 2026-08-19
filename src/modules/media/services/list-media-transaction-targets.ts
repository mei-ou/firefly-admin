import { ApiError } from "../../../core/http/errors";
import { type ArticlePathConfig, buildArticlePath } from "../../../core/security/path-policy";
import type { GitDirectoryEntry, GitProvider } from "../../../providers/git/types";
import { parseMarkdownDocument } from "../../../utils/frontmatter-utils";
import { parseSlug } from "../../../utils/slug-utils";
import {
	MEDIA_TRANSACTION_ARTICLE_MAX_COUNT,
	MEDIA_TRANSACTION_ARTICLE_READ_CONCURRENCY,
	MEDIA_TRANSACTION_ARTICLE_TOTAL_MAX_BYTES,
} from "../media-config";
import {
	type MediaTransactionTarget,
	type MediaTransactionTargets,
	parseMediaTransactionTargets,
	parseMediaTransactionTargetsRequest,
} from "../media-transaction-targets";

export interface ListMediaTransactionTargetsDependencies {
	gitProvider: Pick<GitProvider, "getHead" | "getFileAtCommit" | "listDirectoryAtCommit">;
	pathConfig: ArticlePathConfig;
}

interface SnapshotArticle {
	storageSlug: string;
	articleSha: string;
	title: string;
	textBytes: number;
}

function conflict(message: string): ApiError {
	return new ApiError(409, "MEDIA_PREVIEW_CONFLICT", message);
}

function incomplete(): ApiError {
	return new ApiError(
		422,
		"MEDIA_REFERENCE_CLOSURE_INCOMPLETE",
		"无法完整读取受控文章快照，请修复远端文章后重试。",
	);
}

function getContentRoot(pathConfig: ArticlePathConfig): string {
	const sentinelPath = buildArticlePath("media-transaction-boundary", pathConfig);
	return sentinelPath.slice(0, -`/media-transaction-boundary/${pathConfig.entryFilename}`.length);
}

function listBundleSlugs(entries: readonly GitDirectoryEntry[], contentRoot: string): string[] {
	return entries
		.filter((entry) => entry.type === "directory")
		.map((entry) => {
			try {
				const storageSlug = parseSlug(entry.name);
				return entry.path === `${contentRoot}/${storageSlug}` ? storageSlug : null;
			} catch {
				return null;
			}
		})
		.filter((storageSlug): storageSlug is string => storageSlug !== null)
		.sort((left, right) => left.localeCompare(right));
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

async function readSnapshotArticle(
	storageSlug: string,
	commitSha: string,
	dependencies: ListMediaTransactionTargetsDependencies,
): Promise<SnapshotArticle> {
	const path = buildArticlePath(storageSlug, dependencies.pathConfig);
	const file = await dependencies.gitProvider.getFileAtCommit(path, commitSha);
	if (file.path !== path || file.encoding !== "utf-8") throw incomplete();
	let parsed: ReturnType<typeof parseMarkdownDocument>;
	try {
		parsed = parseMarkdownDocument(file.content);
	} catch {
		throw incomplete();
	}
	return {
		storageSlug,
		articleSha: file.sha,
		title: parsed.frontmatter.title,
		textBytes: new TextEncoder().encode(file.content).byteLength,
	};
}

/**
 * 目标候选只从一次 HEAD 对应的不可变 Commit 读取。目录候选超限会返回 truncated，但被选入
 * 窗口的任一文章缺失或格式无效都会失败关闭，避免展示无法参与后续闭包扫描的虚假目标。
 */
export async function listMediaTransactionTargets(
	input: unknown,
	dependencies: ListMediaTransactionTargetsDependencies,
): Promise<MediaTransactionTargets> {
	const request = parseMediaTransactionTargetsRequest(input);
	if (
		!dependencies.pathConfig.usePageBundle ||
		dependencies.pathConfig.entryFilename !== "index.md"
	) {
		throw new ApiError(503, "CONFIGURATION_ERROR", "媒体事务目标仅支持固定 Page Bundle。");
	}
	const head = await dependencies.gitProvider.getHead();
	if (head.commitSha !== request.expectedHeadSha) {
		throw conflict("远端分支已变化，请重新加载文章后再选择目标。 ");
	}
	const contentRoot = getContentRoot(dependencies.pathConfig);
	const entries = await dependencies.gitProvider.listDirectoryAtCommit(contentRoot, head.commitSha);
	const candidates = listBundleSlugs(entries, contentRoot);
	const sourceIndex = candidates.indexOf(request.source.storageSlug);
	if (sourceIndex < 0) throw conflict("源文章不存在或已移出受控目录。");

	const otherCandidates = candidates.filter(
		(storageSlug) => storageSlug !== request.source.storageSlug,
	);
	const selectedCandidates = otherCandidates.slice(0, MEDIA_TRANSACTION_ARTICLE_MAX_COUNT);
	// source 不计入返回候选上限，但必须从同一 Commit 读取并参与 SHA 复核。
	const selected = [request.source.storageSlug, ...selectedCandidates];
	let articles: SnapshotArticle[];
	try {
		articles = await mapWithConcurrency(
			selected,
			MEDIA_TRANSACTION_ARTICLE_READ_CONCURRENCY,
			(storageSlug) => readSnapshotArticle(storageSlug, head.commitSha, dependencies),
		);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw incomplete();
	}
	const totalBytes = articles.reduce((sum, article) => sum + article.textBytes, 0);
	if (totalBytes > MEDIA_TRANSACTION_ARTICLE_TOTAL_MAX_BYTES) throw incomplete();
	const source = articles[0];
	if (!source || source.articleSha !== request.source.articleSha) {
		throw conflict("源文章版本已变化，请重新加载后再选择目标。");
	}
	const items: MediaTransactionTarget[] = articles.slice(1).map((article) => ({
		storageSlug: article.storageSlug,
		articleSha: article.articleSha,
		title: article.title,
	}));
	return parseMediaTransactionTargets({
		baseCommitSha: head.commitSha,
		source: request.source,
		items,
		truncated: otherCandidates.length > selectedCandidates.length,
	});
}
