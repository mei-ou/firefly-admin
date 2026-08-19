import type { R2BucketBinding } from "../../../types/env";
import {
	MEDIA_STAGING_CLEANUP_BATCH_SIZE,
	MEDIA_STAGING_OBJECT_KEY_PATTERN,
	MEDIA_STAGING_PREFIX,
	MEDIA_STAGING_RETENTION_MS,
} from "../media-config";

const MAX_LIST_PAGES = 100;

export interface CleanupStagedMediaResult {
	deleted: number;
	ignored: number;
	pages: number;
}

export interface CleanupStagedMediaOptions {
	batchSize?: number;
	now?: Date;
	retentionMs?: number;
}

function parsePositiveInteger(value: number, name: string, maximum: number): number {
	if (!Number.isInteger(value) || value <= 0 || value > maximum) {
		throw new TypeError(`${name} 必须是 1 到 ${maximum} 之间的整数。`);
	}
	return value;
}

/**
 * 只清理服务端生成命名空间中的过期对象。prefix 只是第一道过滤，删除前仍重新执行完整
 * key 格式和上传时间校验，避免误删 staging/ 下未来扩展的其他资源。
 */
export async function cleanupExpiredStagedMedia(
	bucket: Pick<R2BucketBinding, "delete" | "list">,
	options: CleanupStagedMediaOptions = {},
): Promise<CleanupStagedMediaResult> {
	const batchSize = parsePositiveInteger(
		options.batchSize ?? MEDIA_STAGING_CLEANUP_BATCH_SIZE,
		"清理批次大小",
		1000,
	);
	const retentionMs = parsePositiveInteger(
		options.retentionMs ?? MEDIA_STAGING_RETENTION_MS,
		"暂存保留时间",
		365 * 24 * 60 * 60 * 1_000,
	);
	const now = options.now ?? new Date();
	if (!Number.isFinite(now.getTime())) throw new TypeError("清理时间无效。");
	const cutoff = now.getTime() - retentionMs;
	let cursor: string | undefined;
	let hasMore = true;
	let deleted = 0;
	let ignored = 0;
	let pages = 0;

	while (hasMore) {
		const page = await bucket.list({
			prefix: `${MEDIA_STAGING_PREFIX}/`,
			limit: batchSize,
			...(cursor === undefined ? {} : { cursor }),
		});
		pages += 1;
		if (pages > MAX_LIST_PAGES) {
			throw new Error("R2 暂存清理分页超过安全上限。");
		}

		if (page.truncated && (!page.cursor || page.cursor === cursor)) {
			throw new Error("R2 暂存清理收到无效分页游标。");
		}

		const expiredKeys: string[] = [];
		for (const object of page.objects) {
			const uploadedAt = object.uploaded instanceof Date ? object.uploaded.getTime() : Number.NaN;
			if (
				MEDIA_STAGING_OBJECT_KEY_PATTERN.test(object.key) &&
				Number.isFinite(uploadedAt) &&
				uploadedAt <= cutoff
			) {
				expiredKeys.push(object.key);
			} else {
				ignored += 1;
			}
		}
		if (expiredKeys.length > 0) {
			await bucket.delete(expiredKeys);
			deleted += expiredKeys.length;
		}

		hasMore = page.truncated;
		if (hasMore) cursor = page.cursor;
	}

	return { deleted, ignored, pages };
}
