PRAGMA foreign_keys = OFF;

CREATE TABLE media_transaction_previews_v3 (
	preview_id TEXT PRIMARY KEY,
	subject TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	operation TEXT NOT NULL CHECK (operation IN ('rename', 'move')),
	storage_slug TEXT NOT NULL,
	base_commit_sha TEXT NOT NULL,
	expected_article_sha TEXT NOT NULL,
	expected_blob_sha TEXT NOT NULL,
	destination_storage_slug TEXT,
	destination_expected_article_sha TEXT,
	preview_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('ready', 'committing', 'unknown', 'consumed', 'expired')),
	commit_idempotency_key_hash TEXT,
	commit_request_hash TEXT,
	commit_plan_hash TEXT,
	commit_plan_json TEXT,
	candidate_commit_sha TEXT,
	result_json TEXT,
	claim_token TEXT,
	claimed_at INTEGER,
	claim_expires_at INTEGER,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	consumed_at INTEGER,
	CHECK (expires_at > created_at),
	CHECK (
		(operation = 'rename' AND destination_storage_slug IS NULL AND destination_expected_article_sha IS NULL) OR
		(operation = 'move' AND destination_storage_slug IS NOT NULL AND destination_expected_article_sha IS NOT NULL)
	),
	CHECK (
		(status = 'ready' AND commit_plan_hash IS NULL AND commit_plan_json IS NULL AND candidate_commit_sha IS NULL AND result_json IS NULL AND claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL AND consumed_at IS NULL) OR
		(status = 'committing' AND commit_idempotency_key_hash IS NOT NULL AND commit_request_hash IS NOT NULL AND commit_plan_hash IS NULL AND commit_plan_json IS NULL AND candidate_commit_sha IS NULL AND result_json IS NULL AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL AND consumed_at IS NULL) OR
		(status = 'unknown' AND commit_idempotency_key_hash IS NOT NULL AND commit_request_hash IS NOT NULL AND commit_plan_hash IS NOT NULL AND commit_plan_json IS NOT NULL AND result_json IS NULL AND claim_token IS NOT NULL AND claimed_at IS NOT NULL AND claim_expires_at IS NOT NULL AND consumed_at IS NULL) OR
		(status = 'consumed' AND commit_idempotency_key_hash IS NOT NULL AND commit_request_hash IS NOT NULL AND commit_plan_hash IS NOT NULL AND commit_plan_json IS NOT NULL AND candidate_commit_sha IS NOT NULL AND result_json IS NOT NULL AND claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL AND consumed_at IS NOT NULL) OR
		(status = 'expired' AND commit_plan_hash IS NULL AND commit_plan_json IS NULL AND candidate_commit_sha IS NULL AND result_json IS NULL AND claim_token IS NULL AND claimed_at IS NULL AND claim_expires_at IS NULL AND consumed_at IS NULL)
	),
	CHECK (commit_plan_hash IS NOT NULL OR candidate_commit_sha IS NULL),
	CHECK (commit_plan_json IS NOT NULL OR commit_plan_hash IS NULL)
);

INSERT INTO media_transaction_previews_v3 (
	preview_id,
	subject,
	request_hash,
	operation,
	storage_slug,
	base_commit_sha,
	expected_article_sha,
	expected_blob_sha,
	destination_storage_slug,
	destination_expected_article_sha,
	preview_json,
	status,
	commit_idempotency_key_hash,
	commit_request_hash,
	commit_plan_hash,
	commit_plan_json,
	candidate_commit_sha,
	result_json,
	claim_token,
	claimed_at,
	claim_expires_at,
	created_at,
	expires_at,
	updated_at,
	consumed_at
)
SELECT
	preview_id,
	subject,
	request_hash,
	operation,
	storage_slug,
	base_commit_sha,
	expected_article_sha,
	expected_blob_sha,
	NULL,
	NULL,
	preview_json,
	status,
	commit_idempotency_key_hash,
	commit_request_hash,
	commit_plan_hash,
	commit_plan_json,
	candidate_commit_sha,
	result_json,
	claim_token,
	claimed_at,
	claim_expires_at,
	created_at,
	expires_at,
	updated_at,
	consumed_at
FROM media_transaction_previews;

DROP TABLE media_transaction_previews;
ALTER TABLE media_transaction_previews_v3 RENAME TO media_transaction_previews;

CREATE INDEX media_transaction_previews_expiry_idx
	ON media_transaction_previews (status, expires_at);

CREATE INDEX media_transaction_previews_lease_idx
	ON media_transaction_previews (status, claim_expires_at)
	WHERE status = 'committing';

CREATE UNIQUE INDEX media_transaction_previews_subject_commit_key_idx
	ON media_transaction_previews (subject, commit_idempotency_key_hash)
	WHERE commit_idempotency_key_hash IS NOT NULL;

CREATE UNIQUE INDEX media_transaction_previews_subject_request_idx
	ON media_transaction_previews (subject, request_hash);

PRAGMA foreign_keys = ON;
