CREATE TABLE media_transaction_previews (
	preview_id TEXT PRIMARY KEY,
	subject TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	operation TEXT NOT NULL CHECK (operation = 'rename'),
	storage_slug TEXT NOT NULL,
	base_commit_sha TEXT NOT NULL,
	expected_article_sha TEXT NOT NULL,
	expected_blob_sha TEXT NOT NULL,
	preview_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('ready', 'committing', 'consumed', 'expired')),
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	UNIQUE (subject, request_hash)
);

CREATE INDEX media_transaction_previews_expiry_idx
	ON media_transaction_previews (status, expires_at);
