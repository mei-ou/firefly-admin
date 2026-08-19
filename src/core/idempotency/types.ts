export interface IdempotencyRecord<TResult> {
	scope: string;
	requestHash: string;
	status: "processing" | "unknown" | "completed";
	result?: TResult;
	baseHeadSha?: string;
	candidateCommitSha?: string;
	recovery?: IdempotencyRecoveryContext;
	expiresAt: number;
}

export interface IdempotencyRecoveryContext {
	kind: "article-create" | "article-update" | "article-delete";
	storageSlug: string;
}

export type IdempotencyClaimResult<TResult> =
	| { state: "claimed" }
	| { state: "processing" }
	| {
			state: "unknown";
			baseHeadSha?: string;
			candidateCommitSha?: string;
			recovery?: IdempotencyRecoveryContext;
	  }
	| { state: "completed"; result: TResult }
	| { state: "conflict" };

export interface IdempotencyStatus<TResult> {
	state: "processing" | "unknown" | "completed";
	requestHash: string;
	baseHeadSha?: string;
	candidateCommitSha?: string;
	recovery?: IdempotencyRecoveryContext;
	result?: TResult;
	expiresAt: number;
}

/**
 * 幂等存储只定义原子占位、完成和失败释放语义。具体业务结果保持泛型，避免核心层
 * 依赖文章或 GitHub 类型；实现必须保证 claim 的唯一作用域判断在存储层原子完成。
 */
export interface IdempotencyStore<TResult> {
	claim(record: {
		scope: string;
		requestHash: string;
		expiresAt: number;
		recovery?: IdempotencyRecoveryContext;
	}): Promise<IdempotencyClaimResult<TResult>>;
	getStatus?(record: {
		scope: string;
		requestHash: string;
	}): Promise<IdempotencyStatus<TResult> | undefined>;
	getStatusByScope?(scope: string): Promise<IdempotencyStatus<TResult> | undefined>;
	markUnknown?(record: {
		scope: string;
		requestHash: string;
		baseHeadSha: string;
		recovery?: IdempotencyRecoveryContext;
	}): Promise<void>;
	recordCandidateCommit?(record: {
		scope: string;
		requestHash: string;
		candidateCommitSha: string;
	}): Promise<void>;
	complete(record: { scope: string; requestHash: string; result: TResult }): Promise<void>;
	completeUnknown?(record: { scope: string; requestHash: string; result: TResult }): Promise<void>;
	release(record: { scope: string; requestHash: string }): Promise<void>;
}
