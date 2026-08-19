import { z } from "zod";
import { parseSlug } from "../../utils/slug-utils";

const GIT_OBJECT_SHA = /^[a-f0-9]{40,64}$/;
const MAX_MEDIA_TRANSACTION_TARGETS = 50;

export interface MediaTransactionTargetsRequest {
	expectedHeadSha: string;
	source: {
		storageSlug: string;
		articleSha: string;
	};
}

export interface MediaTransactionTarget {
	storageSlug: string;
	articleSha: string;
	title: string;
}

export interface MediaTransactionTargets {
	baseCommitSha: string;
	source: {
		storageSlug: string;
		articleSha: string;
	};
	items: readonly MediaTransactionTarget[];
	truncated: boolean;
}

const requestSchema = z
	.object({
		expectedHeadSha: z.string().regex(GIT_OBJECT_SHA),
		source: z
			.object({
				storageSlug: z.unknown(),
				articleSha: z.string().regex(GIT_OBJECT_SHA),
			})
			.strict(),
	})
	.strict();

const targetSchema = z
	.object({
		storageSlug: z.unknown(),
		articleSha: z.string().regex(GIT_OBJECT_SHA),
		title: z.string().trim().min(1).max(200),
	})
	.strict();

const responseSchema = z
	.object({
		baseCommitSha: z.string().regex(GIT_OBJECT_SHA),
		source: z
			.object({
				storageSlug: z.unknown(),
				articleSha: z.string().regex(GIT_OBJECT_SHA),
			})
			.strict(),
		items: z.array(targetSchema).max(MAX_MEDIA_TRANSACTION_TARGETS),
		truncated: z.boolean(),
	})
	.strict();

/** 浏览器只能提交快照锁与源文章身份，不能提交仓库路径、分支或目标 URL。 */
export function parseMediaTransactionTargetsRequest(
	input: unknown,
): MediaTransactionTargetsRequest {
	const parsed = requestSchema.parse(input);
	return {
		...parsed,
		source: { ...parsed.source, storageSlug: parseSlug(parsed.source.storageSlug) },
	};
}

/** 在 API 边界重新执行 strict 输出校验，防止未来服务改动意外泄露仓库路径或 URL。 */
export function parseMediaTransactionTargets(input: unknown): MediaTransactionTargets {
	const parsed = responseSchema.parse(input);
	return {
		...parsed,
		source: { ...parsed.source, storageSlug: parseSlug(parsed.source.storageSlug) },
		items: parsed.items.map((item) => ({ ...item, storageSlug: parseSlug(item.storageSlug) })),
	};
}
