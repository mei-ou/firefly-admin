import { ApiError } from "../../../core/http/errors";
import type { ArticlePathConfig } from "../../../core/security/path-policy";
import type { AtomicGitFileChange, GitProvider } from "../../../providers/git/types";
import {
	type MediaTransactionCommitArticlePlan,
	type MediaTransactionCommitPlan,
	type MediaTransactionCommitResult,
	type MoveMediaTransactionCommitPlan,
	parseMediaTransactionCommitPlan,
	parseMediaTransactionCommitResult,
	type RenameMediaTransactionCommitPlan,
} from "../media-transaction-commit";
import {
	type MediaTransactionPreview,
	parseMediaTransactionPreview,
} from "../media-transaction-preview";

export interface ExecuteMediaTransactionCommitDependencies {
	gitProvider: Pick<GitProvider, "commitFilesAtomically">;
	pathConfig: ArticlePathConfig;
	checkpointCandidateCommit(candidateCommitSha: string): Promise<void>;
	now?: () => number;
}

interface ExpectedCommittedFile {
	kind: "article" | "reuse" | "delete";
	expectedSha?: string;
	side?: "source" | "destination";
}

function appendArticleWrite(
	files: AtomicGitFileChange[],
	article: MediaTransactionCommitArticlePlan,
): void {
	if (article.mode !== "write") return;
	files.push({
		operation: "write",
		path: article.repositoryPath,
		content: article.plannedContent,
		expectedSha: article.expectedSha,
	});
}

function invalidCommitResult(): ApiError {
	return new ApiError(502, "UPSTREAM_ERROR", "Git 服务返回了无效提交结果。");
}

/** 将 strict Plan 映射为唯一一次原子 Git 提交，并严格验证 Provider 返回的完整文件集合。 */
export async function executeMediaTransactionCommit(
	planInput: unknown,
	previewInput: MediaTransactionPreview,
	dependencies: ExecuteMediaTransactionCommitDependencies,
): Promise<MediaTransactionCommitResult> {
	const preview = parseMediaTransactionPreview(previewInput, dependencies.pathConfig);
	const plan = parseMediaTransactionCommitPlan(planInput, preview, dependencies.pathConfig);
	const files: AtomicGitFileChange[] = [];
	const expectedFiles = new Map<string, ExpectedCommittedFile>();
	let message: string;

	if (plan.operation === "rename") {
		if (preview.operation !== "rename") throw new TypeError("媒体事务 Preview 不是重命名。");
		appendArticleWrite(files, plan.article);
		if (plan.article.mode === "write") {
			expectedFiles.set(plan.article.repositoryPath, { kind: "article", side: "source" });
		}
		files.push(
			{
				operation: "reuse",
				path: plan.destination.repositoryPath,
				expectedSha: null,
				fileSha: plan.destination.reusedBlobSha,
			},
			{
				operation: "delete",
				path: plan.source.repositoryPath,
				expectedSha: plan.source.blobSha,
			},
		);
		expectedFiles.set(plan.destination.repositoryPath, {
			kind: "reuse",
			expectedSha: plan.destination.reusedBlobSha,
		});
		expectedFiles.set(plan.source.repositoryPath, { kind: "delete" });
		message = `assets(post): rename ${preview.source.filename} to ${preview.destination.filename}`;
	} else {
		if (preview.operation !== "move") throw new TypeError("媒体事务 Preview 不是移动。");
		appendArticleWrite(files, plan.source.article);
		appendArticleWrite(files, plan.destination.article);
		if (plan.source.article.mode === "write") {
			expectedFiles.set(plan.source.article.repositoryPath, { kind: "article", side: "source" });
		}
		if (plan.destination.article.mode === "write") {
			expectedFiles.set(plan.destination.article.repositoryPath, {
				kind: "article",
				side: "destination",
			});
		}
		files.push(
			{
				operation: "reuse",
				path: plan.destination.resource.repositoryPath,
				expectedSha: null,
				fileSha: plan.destination.resource.reusedBlobSha,
			},
			{
				operation: "delete",
				path: plan.source.resource.repositoryPath,
				expectedSha: plan.source.resource.blobSha,
			},
		);
		expectedFiles.set(plan.destination.resource.repositoryPath, {
			kind: "reuse",
			expectedSha: plan.destination.resource.reusedBlobSha,
		});
		expectedFiles.set(plan.source.resource.repositoryPath, { kind: "delete" });
		message = `assets(post): move ${preview.source.resource.filename} to ${preview.destination.storageSlug}/${preview.destination.resource.filename}`;
	}

	const committed = await dependencies.gitProvider.commitFilesAtomically({
		expectedHeadSha: plan.baseCommitSha,
		message,
		files,
		checkpointCandidateCommit: dependencies.checkpointCandidateCommit,
	});
	if (committed.files.length !== expectedFiles.size) throw invalidCommitResult();

	const articleFileShas =
		plan.operation === "rename"
			? { source: plan.article.expectedSha, destination: "" }
			: {
					source: plan.source.article.expectedSha,
					destination: plan.destination.article.expectedSha,
				};
	const seen = new Set<string>();
	for (const file of committed.files) {
		const expected = expectedFiles.get(file.path);
		if (seen.has(file.path) || expected === undefined) throw invalidCommitResult();
		seen.add(file.path);
		if (
			(expected.kind === "delete" && file.fileSha !== null) ||
			(expected.kind === "reuse" && file.fileSha !== expected.expectedSha) ||
			(expected.kind === "article" && file.fileSha === null)
		) {
			throw invalidCommitResult();
		}
		if (expected.kind === "article" && file.fileSha !== null && expected.side !== undefined) {
			articleFileShas[expected.side] = file.fileSha;
		}
	}

	const completedAt = new Date(dependencies.now?.() ?? Date.now()).toISOString();
	const result: MediaTransactionCommitResult =
		plan.operation === "rename"
			? {
					version: 1,
					operation: "rename",
					previewId: plan.previewId,
					commitSha: committed.commitSha,
					url: committed.commitUrl,
					article: {
						updated: plan.article.mode === "write",
						fileSha: articleFileShas.source,
					},
					source: { deleted: true },
					destination: { blobSha: plan.destination.reusedBlobSha },
					completedAt,
				}
			: {
					version: 1,
					operation: "move",
					previewId: plan.previewId,
					commitSha: committed.commitSha,
					url: committed.commitUrl,
					articles: {
						source: {
							updated: plan.source.article.mode === "write",
							fileSha: articleFileShas.source,
						},
						destination: {
							updated: plan.destination.article.mode === "write",
							fileSha: articleFileShas.destination,
						},
					},
					source: { deleted: true },
					destination: { blobSha: plan.destination.resource.reusedBlobSha },
					completedAt,
				};
	return parseMediaTransactionCommitResult(
		result,
		plan,
		preview,
		committed.commitSha,
		dependencies.pathConfig,
	);
}

export type {
	MediaTransactionCommitPlan,
	MoveMediaTransactionCommitPlan,
	RenameMediaTransactionCommitPlan,
};
