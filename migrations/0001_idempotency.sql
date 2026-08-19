CREATE TABLE IF NOT EXISTS idempotency_records (
	scope TEXT PRIMARY KEY,
	request_hash TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('processing', 'completed')),
	response_json TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	CHECK (
		(status = 'processing' AND response_json IS NULL) OR
		(status = 'completed' AND response_json IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS idempotency_records_expires_at_idx
	ON idempotency_records (expires_at);
