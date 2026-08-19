import { ApiError } from "../http/errors";
import type { IdempotencyRecoveryContext, IdempotencyStore } from "./types";

export interface ExecuteIdempotentlyOptions<TResult> {
	store: IdempotencyStore<TResult>;
	scope: string;
	requestHash: string;
	expiresAt: number;
	recovery?: IdempotencyRecoveryContext;
	recoverUnknown?(record: {
		baseHeadSha?: string;
		candidateCommitSha?: string;
	}): Promise<TResult | undefined>;
	execute(control: { markSideEffectPossible(): void }): Promise<TResult>;
}

/**
 * 先原子占位，再执行产生外部副作用的操作。相同请求完成后回放原结果；相同键但不同
 * 请求拒绝复用；正在处理中的重复请求返回冲突，不等待也不再次调用 GitHub。
 */
export async function executeIdempotently<TResult>(
	options: ExecuteIdempotentlyOptions<TResult>,
): Promise<{ result: TResult; replayed: boolean }> {
	const claim = await options.store.claim({
		scope: options.scope,
		requestHash: options.requestHash,
		expiresAt: options.expiresAt,
		...(options.recovery === undefined ? {} : { recovery: options.recovery }),
	});
	if (claim.state === "completed") {
		return { result: claim.result, replayed: true };
	}
	if (claim.state === "conflict") {
		throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于其他请求。");
	}
	if (claim.state === "processing") {
		throw new ApiError(409, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中，请稍后重试。");
	}
	if (claim.state === "unknown") {
		const recovered = await options.recoverUnknown?.({
			...(claim.baseHeadSha === undefined ? {} : { baseHeadSha: claim.baseHeadSha }),
			...(claim.candidateCommitSha === undefined
				? {}
				: { candidateCommitSha: claim.candidateCommitSha }),
		});
		if (recovered !== undefined) {
			await options.store.complete({
				scope: options.scope,
				requestHash: options.requestHash,
				result: recovered,
			});
			return { result: recovered, replayed: true };
		}
		throw new ApiError(503, "COMMIT_STATUS_UNKNOWN", "上次提交状态暂时无法确认，请勿重复提交。");
	}

	let result: TResult;
	let sideEffectPossible = false;
	try {
		result = await options.execute({
			markSideEffectPossible() {
				sideEffectPossible = true;
			},
		});
	} catch (error) {
		// 只有调用方尚未跨过外部副作用边界时才能释放；unknown 记录必须保留用于恢复。
		if (!sideEffectPossible) {
			await options.store.release({ scope: options.scope, requestHash: options.requestHash });
		}
		throw error;
	}

	// 外部副作用已经成功后，complete 失败绝不能释放占位，否则重试可能产生第二个 Commit。
	// 记录会保持 processing 并失败关闭，等待人工核对或后续恢复机制处理。
	await options.store.complete({
		scope: options.scope,
		requestHash: options.requestHash,
		result,
	});
	return { result, replayed: false };
}
