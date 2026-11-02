ALTER TABLE sitepilot_excel_test.sitepilot_upload_jobs
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_generation BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS stage_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS attempt_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS sitepilot_upload_jobs_ready_idx
  ON sitepilot_excel_test.sitepilot_upload_jobs (next_attempt_at, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS sitepilot_upload_jobs_lease_idx
  ON sitepilot_excel_test.sitepilot_upload_jobs (lease_expires_at)
  WHERE status NOT IN ('queued', 'completed', 'failed');

ALTER TABLE sitepilot_excel_test.sitepilot_upload_job_events
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS event_kind TEXT NOT NULL DEFAULT 'progress',
  ADD COLUMN IF NOT EXISTS stage_duration_ms BIGINT;

UPDATE sitepilot_excel_test.sitepilot_upload_jobs
SET lease_generation = 0
WHERE lease_generation IS NULL;

CREATE TABLE IF NOT EXISTS sitepilot_excel_test.sitepilot_upload_file_versions (
  job_id UUID PRIMARY KEY REFERENCES sitepilot_excel_test.sitepilot_upload_jobs(job_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  file_id TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sitepilot_upload_file_versions_scope_idx
  ON sitepilot_excel_test.sitepilot_upload_file_versions (tenant_id, group_id, file_id);
CREATE INDEX IF NOT EXISTS sitepilot_upload_file_versions_active_idx
  ON sitepilot_excel_test.sitepilot_upload_file_versions (tenant_id, group_id, lower(original_name))
  WHERE is_active;
