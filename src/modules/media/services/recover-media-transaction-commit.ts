import {
	type ArticlePathConfig,
	getArticleResourceFilenameConflictKey,
	parseArticleResourceFilename,
} from "../../../core/security/path-policy";
import type {
	GitDirectoryEntry,
	GitProvider,
	GitRepositoryFile,
} from "../../../providers/git/types";
import {
	type MediaTransactionCommitArticlePlan,
	type MediaTransactionCommitResult,
	type MoveMediaTransactionCommitPlan,
	parseMediaTransactionCommitPlan,
	parseMediaTransactionCommitResult,
	type RenameMediaTransactionCommitPlan,
} from "../media-transaction-commit";
import {
	type MediaTransactionPreview,
	type MoveMediaTransactionPreview,
	parseMediaTransactionPreview,
	type RenameMediaTransactionPreview,
} from "../media-transaction-preview";

export interface RecoverMediaTransactionCommitDependencies {
	gitProvider: Pick<GitProvider, "getHead" | "getFileAtCommit" | "listDirectoryAtCommit">;
	pathConfig: ArticlePathConfig;
	now?: () => number;
}

function getBundlePath(articlePath: string, pathConfig: ArticlePathConfig): string {
	return articlePath.slice(0, -(pathConfig.entryFilename.length + 1));
}

function isPlannedArticle(
	file: GitRepositoryFile,
	article: MediaTransactionCommitArticlePlan,
): boolean {
	return (
		file.path === article.repositoryPath &&
		file.encoding === "utf-8" &&
		file.content === article.plannedContent &&
		(article.mode === "write" || file.sha === article.expectedSha)
	);
}

async function recoverRenameMediaTransactionCommit(
	plan: RenameMediaTransactionCommitPlan,
	preview: RenameMediaTransactionPreview,
	candidateCommitSha: string,
	commitUrl: string,
	dependencies: RecoverMediaTransactionCommitDependencies,
): Promise<MediaTransactionCommitResult | undefined> {
	const bundlePath = getBundlePath(plan.article.repositoryPath, dependencies.pathConfig);
	const [articleFile, entries] = await Promise.all([
		dependencies.gitProvider.getFileAtCommit(plan.article.repositoryPath, candidateCommitSha),
		dependencies.gitProvider.listDirectoryAtCommit(bundlePath, candidateCommitSha),
	]);
	if (!isPlannedArticle(articleFile, plan.article)) return undefined;

	const sourceKey = getArticleResourceFilenameConflictKey(preview.source.filename);
	const destinationKey = getArticleResourceFilenameConflictKey(preview.destination.filename);
	let destinationFound = false;
	const keys = new Set<string>();
	for (const entry of entries) {
		if (
			entry.path === plan.article.repositoryPath &&
			entry.name === dependencies.pathConfig.entryFilename
		) {
			continue;
		}
		if (entry.type !== "file") return undefined;
		let filename: string;
		try {
			filename = parseArticleResourceFilename(entry.name);
		} catch {
			return undefined;
		}
		const key = getArticleResourceFilenameConflictKey(filename);
		if (keys.has(key) || key === sourceKey) return undefined;
		keys.add(key);
		if (key !== destinationKey) continue;
		if (
			filename !== preview.destination.filename ||
			entry.path !== plan.destination.repositoryPath ||
			entry.sha !== plan.source.blobSha
		) {
			return undefined;
		}
		destinationFound = true;
	}
	if (!destinationFound) return undefined;

	const result: MediaTransactionCommitResult = {
		version: 1,
		operation: "rename",
		previewId: plan.previewId,
		commitSha: candidateCommitSha,
		url: commitUrl,
		article: { updated: plan.article.mode === "write", fileSha: articleFile.sha },
		source: { deleted: true },
		destination: { blobSha: plan.destination.reusedBlobSha },
		completedAt: new Date(dependencies.now?.() ?? Date.now()).toISOString(),
	};
	return parseMediaTransactionCommitResult(
		result,
		plan,
		preview,
		candidateCommitSha,
		dependencies.pathConfig,
	);
}

interface MoveBundleExpectation {
	article: MediaTransactionCommitArticlePlan;
	resourceFilename: string;
	resourcePath: string;
	resourceBlobSha: string;
	resourceMustExist: boolean;
}

/** 严格证明一个 Page Bundle 的入口、直接子项路径、大小和 NFKC/大小写唯一性。 */
function validateMoveBundle(
	entries: readonly GitDirectoryEntry[],
	articleFile: GitRepositoryFile,
	expectation: MoveBundleExpectation,
	pathConfig: ArticlePathConfig,
): boolean {
	if (!isPlannedArticle(articleFile, expectation.article)) return false;
	const bundlePath = getBundlePath(expectation.article.repositoryPath, pathConfig);
	const articleKey = pathConfig.entryFilename.normalize("NFKC").toLowerCase();
	const resourceKey = getArticleResourceFilenameConflictKey(expectation.resourceFilename);
	const resourceKeys = new Set<string>();
	let articleEntryCount = 0;
	let resourceEntryCount = 0;
	for (const entry of entries) {
		if (entry.type !== "file") return false;
		if (entry.name === pathConfig.entryFilename) {
			if (
				entry.path !== expectation.article.repositoryPath ||
				entry.sha !== articleFile.sha ||
				entry.size === null ||
				!Number.isSafeInteger(entry.size) ||
				entry.size < 0
			) {
				return false;
			}
			articleEntryCount += 1;
			continue;
		}
		if (entry.name.normalize("NFKC").toLowerCase() === articleKey) return false;

		let filename: string;
		try {
			filename = parseArticleResourceFilename(entry.name);
		} catch {
			return false;
		}
		const key = getArticleResourceFilenameConflictKey(filename);
		if (
			resourceKeys.has(key) ||
			entry.path !== `${bundlePath}/${filename}` ||
			entry.size === null ||
			!Number.isSafeInteger(entry.size) ||
			entry.size <= 0
		) {
			return false;
		}
		resourceKeys.add(key);
		if (key !== resourceKey) continue;
		resourceEntryCount += 1;
		if (
			filename !== expectation.resourceFilename ||
			entry.path !== expectation.resourcePath ||
			entry.sha !== expectation.resourceBlobSha
		) {
			return false;
		}
	}
	return articleEntryCount === 1 && resourceEntryCount === (expectation.resourceMustExist ? 1 : 0);
}

async function recoverMoveMediaTransactionCommit(
	plan: MoveMediaTransactionCommitPlan,
	preview: MoveMediaTransactionPreview,
	candidateCommitSha: string,
	commitUrl: string,
	dependencies: RecoverMediaTransactionCommitDependencies,
): Promise<MediaTransactionCommitResult | undefined> {
	const sourceBundlePath = getBundlePath(
		plan.source.article.repositoryPath,
		dependencies.pathConfig,
	);
	const destinationBundlePath = getBundlePath(
		plan.destination.article.repositoryPath,
		dependencies.pathConfig,
	);
	const [sourceArticleFile, destinationArticleFile, sourceEntries, destinationEntries] =
		await Promise.all([
			dependencies.gitProvider.getFileAtCommit(
				plan.source.article.repositoryPath,
				candidateCommitSha,
			),
			dependencies.gitProvider.getFileAtCommit(
				plan.destination.article.repositoryPath,
				candidateCommitSha,
			),
			dependencies.gitProvider.listDirectoryAtCommit(sourceBundlePath, candidateCommitSha),
			dependencies.gitProvider.listDirectoryAtCommit(destinationBundlePath, candidateCommitSha),
		]);
	if (
		!validateMoveBundle(
			sourceEntries,
			sourceArticleFile,
			{
				article: plan.source.article,
				resourceFilename: preview.source.resource.filename,
				resourcePath: plan.source.resource.repositoryPath,
				resourceBlobSha: plan.source.resource.blobSha,
				resourceMustExist: false,
			},
			dependencies.pathConfig,
		) ||
		!validateMoveBundle(
			destinationEntries,
			destinationArticleFile,
			{
				article: plan.destination.article,
				resourceFilename: preview.destination.resource.filename,
				resourcePath: plan.destination.resource.repositoryPath,
				resourceBlobSha: plan.destination.resource.reusedBlobSha,
				resourceMustExist: true,
			},
			dependencies.pathConfig,
		)
	) {
		return undefined;
	}

	const result: MediaTransactionCommitResult = {
		version: 1,
		operation: "move",
		previewId: plan.previewId,
		commitSha: candidateCommitSha,
		url: commitUrl,
		articles: {
			source: {
				updated: plan.source.article.mode === "write",
				fileSha: sourceArticleFile.sha,
			},
			destination: {
				updated: plan.destination.article.mode === "write",
				fileSha: destinationArticleFile.sha,
			},
		},
		source: { deleted: true },
		destination: { blobSha: plan.destination.resource.reusedBlobSha },
		completedAt: new Date(dependencies.now?.() ?? Date.now()).toISOString(),
	};
	return parseMediaTransactionCommitResult(
		result,
		plan,
		preview,
		candidateCommitSha,
		dependencies.pathConfig,
	);
}

/**
 * 只读证明候选 Commit 已成为 HEAD 且完整应用 strict Plan。任何缺失、冲突或读取异常都
 * 不能推断成功，调用方必须继续保留 unknown。
 */
export async function recoverMediaTransactionCommit(
	planInput: unknown,
	previewInput: MediaTransactionPreview,
	candidateCommitSha: string,
	dependencies: RecoverMediaTransactionCommitDependencies,
): Promise<MediaTransactionCommitResult | undefined> {
	try {
		const preview = parseMediaTransactionPreview(previewInput, dependencies.pathConfig);
		const plan = parseMediaTransactionCommitPlan(planInput, preview, dependencies.pathConfig);
		const head = await dependencies.gitProvider.getHead();
		if (head.commitSha !== candidateCommitSha || !head.commitUrl) return undefined;
		if (plan.operation === "rename" && preview.operation === "rename") {
			return await recoverRenameMediaTransactionCommit(
				plan,
				preview,
				candidateCommitSha,
				head.commitUrl,
				dependencies,
			);
		}
		if (plan.operation === "move" && preview.operation === "move") {
			return await recoverMoveMediaTransactionCommit(
				plan,
				preview,
				candidateCommitSha,
				head.commitUrl,
				dependencies,
			);
		}
		return undefined;
	} catch {
		return undefined;
	}
}
