import { z } from "zod";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const SAFE_RESOURCE_FILENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

const repositoryResourceSchema = z.object({
	filename: z.string().min(1).max(120).regex(SAFE_RESOURCE_FILENAME),
	blobSha: z.string().regex(GIT_OBJECT_SHA),
});

const resourceChangeSchema = z.discriminatedUnion("operation", [
	z
		.object({
			operation: z.literal("delete"),
			filename: repositoryResourceSchema.shape.filename,
			expectedSha: repositoryResourceSchema.shape.blobSha,
		})
		.strict(),
	z
		.object({
			operation: z.literal("replace"),
			filename: repositoryResourceSchema.shape.filename,
			expectedSha: repositoryResourceSchema.shape.blobSha,
			assetId: z.uuid(),
		})
		.strict(),
	z
		.object({
			operation: z.literal("move"),
			filename: repositoryResourceSchema.shape.filename,
			destinationFilename: repositoryResourceSchema.shape.filename,
			expectedSha: repositoryResourceSchema.shape.blobSha,
		})
		.strict(),
]);

export type RepositoryArticleResource = z.infer<typeof repositoryResourceSchema>;
export type PendingArticleResourceChange = z.infer<typeof resourceChangeSchema>;

export interface ArticleResourceReferenceRisk {
	markdown: boolean;
	frontmatterImage: boolean;
}

export function findArticleResourceReferenceRisk(
	filename: string,
	markdown: string,
	frontmatterImage: string,
): ArticleResourceReferenceRisk {
	const reference = `./${filename}`;
	return {
		// 精确子串检测会覆盖 Markdown 图片、普通链接和 HTML 属性；不自动改写以避免误伤代码块。
		markdown: markdown.includes(reference),
		frontmatterImage: frontmatterImage.trim() === reference,
	};
}

/**
 * 浏览器状态只保存服务端详情返回的源文件名和 Blob SHA；路径重建、目标存在校验及
 * 最终乐观锁仍由服务端完成。这里提前拒绝明显冲突，减少无效提交但不替代服务端边界。
 */
export function upsertArticleResourceChange(
	resources: readonly RepositoryArticleResource[],
	changes: readonly PendingArticleResourceChange[],
	input: unknown,
): PendingArticleResourceChange[] {
	const change = resourceChangeSchema.parse(input);
	const source = resources.find((resource) => resource.filename === change.filename);
	if (!source || source.blobSha !== change.expectedSha) {
		throw new TypeError("已有资源版本无效，请重新加载文章。");
	}
	const next = changes.filter((entry) => entry.filename !== change.filename);
	if (change.operation === "move") {
		if (change.destinationFilename === change.filename) {
			throw new TypeError("资源新文件名不能与原文件名相同。");
		}
		if (resources.some((resource) => resource.filename === change.destinationFilename)) {
			throw new TypeError("资源新文件名已存在。");
		}
		if (
			next.some(
				(entry) =>
					entry.operation === "move" && entry.destinationFilename === change.destinationFilename,
			)
		) {
			throw new TypeError("多个资源不能移动到同一个文件名。");
		}
	}
	return [...next, change].sort((left, right) => left.filename.localeCompare(right.filename, "en"));
}

export function removeArticleResourceChange(
	changes: readonly PendingArticleResourceChange[],
	filename: string,
): PendingArticleResourceChange[] {
	return changes.filter((change) => change.filename !== filename);
}

export function createArticleResourceChangesPayload(
	changes: readonly PendingArticleResourceChange[],
): { version: 1; changes: PendingArticleResourceChange[] } {
	return {
		version: 1,
		changes: z.array(resourceChangeSchema).max(10).parse(changes),
	};
}
