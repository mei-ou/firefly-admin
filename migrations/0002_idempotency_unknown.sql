PRAGMA foreign_keys = OFF;

CREATE TABLE idempotency_records_v2 (
	scope TEXT PRIMARY KEY,
	request_hash TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('processing', 'unknown', 'completed')),
	response_json TEXT,
	base_head_sha TEXT,
	candidate_commit_sha TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	CHECK (
		(status = 'processing' AND response_json IS NULL AND base_head_sha IS NULL AND candidate_commit_sha IS NULL) OR
		(status = 'unknown' AND response_json IS NULL) OR
		(status = 'completed' AND response_json IS NOT NULL)
	)
);

-- 旧 processing 记录可能已发生外部副作用，迁移时必须失败关闭为 unknown。
INSERT INTO idempotency_records_v2 (
	scope,
	request_hash,
	status,
	response_json,
	base_head_sha,
	candidate_commit_sha,
	created_at,
	expires_at
)
SELECT
	scope,
	request_hash,
	CASE status WHEN 'processing' THEN 'unknown' ELSE status END,
	response_json,
	NULL,
	NULL,
	created_at,
	expires_at
FROM idempotency_records;

DROP TABLE idempotency_records;
ALTER TABLE idempotency_records_v2 RENAME TO idempotency_records;

CREATE INDEX idempotency_records_expires_at_idx
	ON idempotency_records (expires_at);

PRAGMA foreign_keys = ON;
