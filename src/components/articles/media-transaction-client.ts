const IDEMPOTENCY_KEY = /^[\x21-\x7e]{16,200}$/;

export interface MediaTransactionResponse {
	response: Response;
	body: unknown;
}

export type MediaTransactionFetch = typeof fetch;

async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function postMediaTransaction(
	endpoint: "/api/media/transactions/preview" | "/api/media/transactions/commit",
	payload: unknown,
	headers: Record<string, string>,
	fetchImplementation: MediaTransactionFetch,
): Promise<MediaTransactionResponse> {
	const response = await fetchImplementation(endpoint, {
		method: "POST",
		// 调用方不能注入或覆盖媒体事务写请求的安全边界头。
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Firefly-Admin": "1",
			...headers,
		},
		body: JSON.stringify(payload),
	});
	return { response, body: await readJson(response) };
}

export function previewMediaTransaction(
	payload: unknown,
	fetchImplementation: MediaTransactionFetch = fetch,
): Promise<MediaTransactionResponse> {
	return postMediaTransaction("/api/media/transactions/preview", payload, {}, fetchImplementation);
}

export function commitMediaTransaction(
	payload: unknown,
	idempotencyKey: string,
	fetchImplementation: MediaTransactionFetch = fetch,
): Promise<MediaTransactionResponse> {
	if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
		throw new TypeError("媒体事务幂等键格式无效。");
	}
	return postMediaTransaction(
		"/api/media/transactions/commit",
		payload,
		{ "Idempotency-Key": idempotencyKey },
		fetchImplementation,
	);
}
