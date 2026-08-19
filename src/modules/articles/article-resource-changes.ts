import { z } from "zod";
import { parseArticleResourceFilename } from "../../core/security/path-policy";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const ASSET_ID_PATTERN = /^[a-f0-9-]{16,64}$/i;
const MAX_ARTICLE_RESOURCE_CHANGES = 10;

const deleteArticleResourceChangeSchema = z
	.object({
		operation: z.literal("delete"),
		filename: z.unknown(),
		expectedSha: z.string().regex(GIT_OBJECT_SHA),
	})
	.strict();

const replaceArticleResourceChangeSchema = z
	.object({
		operation: z.literal("replace"),
		filename: z.unknown(),
		expectedSha: z.string().regex(GIT_OBJECT_SHA),
		assetId: z.string().regex(ASSET_ID_PATTERN),
	})
	.strict();

const moveArticleResourceChangeSchema = z
	.object({
		operation: z.literal("move"),
		filename: z.unknown(),
		destinationFilename: z.unknown(),
		expectedSha: z.string().regex(GIT_OBJECT_SHA),
	})
	.strict();

const articleResourceChangeManifestSchema = z
	.object({
		version: z.literal(1),
		changes: z
			.array(
				z.discriminatedUnion("operation", [
					deleteArticleResourceChangeSchema,
					replaceArticleResourceChangeSchema,
					moveArticleResourceChangeSchema,
				]),
			)
			.max(MAX_ARTICLE_RESOURCE_CHANGES),
	})
	.strict();

export interface DeleteArticleResourceChange {
	operation: "delete";
	filename: string;
	expectedSha: string;
}

export interface ReplaceArticleResourceChange {
	operation: "replace";
	filename: string;
	expectedSha: string;
	/** 引用同一请求 assetManifest 中的暂存对象；客户端不能直接提供替换字节。 */
	assetId: string;
}

export interface MoveArticleResourceChange {
	operation: "move";
	filename: string;
	destinationFilename: string;
	expectedSha: string;
}

export type ArticleResourceChange =
	| DeleteArticleResourceChange
	| ReplaceArticleResourceChange
	| MoveArticleResourceChange;

export interface ArticleResourceChangeManifest {
	version: 1;
	changes: readonly ArticleResourceChange[];
}

/**
 * 已有仓库资源变更与 R2 新资源清单分离。源、目标都只是当前 Page Bundle 的安全文件名；
 * 替换字节来自已复核 R2，移动则复用源 Blob SHA，完整仓库路径始终由服务端重建。
 */
export function parseArticleResourceChangeManifest(input: unknown): ArticleResourceChangeManifest {
	const parsed = articleResourceChangeManifestSchema.parse(input);
	const seenFilenames = new Set<string>();
	const seenMoveDestinations = new Set<string>();
	const seenReplacementAssetIds = new Set<string>();
	const changes: ArticleResourceChange[] = parsed.changes.map((change) => {
		const filename = parseArticleResourceFilename(change.filename);
		if (seenFilenames.has(filename)) {
			throw new TypeError("文章资源变更包含重复源文件名。");
		}
		seenFilenames.add(filename);
		if (change.operation === "delete") {
			return { operation: "delete", filename, expectedSha: change.expectedSha };
		}
		if (change.operation === "move") {
			const destinationFilename = parseArticleResourceFilename(change.destinationFilename);
			if (destinationFilename === filename || seenMoveDestinations.has(destinationFilename)) {
				throw new TypeError("文章资源移动目标无效或重复。");
			}
			seenMoveDestinations.add(destinationFilename);
			return {
				operation: "move",
				filename,
				destinationFilename,
				expectedSha: change.expectedSha,
			};
		}
		const assetId = change.assetId.toLowerCase();
		if (seenReplacementAssetIds.has(assetId)) {
			throw new TypeError("文章资源替换重复引用暂存对象。");
		}
		seenReplacementAssetIds.add(assetId);
		return { operation: "replace", filename, expectedSha: change.expectedSha, assetId };
	});
	for (const destinationFilename of seenMoveDestinations) {
		if (seenFilenames.has(destinationFilename)) {
			throw new TypeError("文章资源移动不支持路径链或循环。");
		}
	}
	// 规范排序让幂等 Hash 不依赖客户端数组顺序，也让原子 Tree 变更保持确定性。
	changes.sort((left, right) => left.filename.localeCompare(right.filename));
	return { version: 1, changes };
}
