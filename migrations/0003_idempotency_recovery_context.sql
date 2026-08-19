ALTER TABLE idempotency_records ADD COLUMN recovery_json TEXT;

-- 仅保存人工恢复所需的最小定位元数据，不保存正文、资源内容或凭据。
