CREATE TABLE IF NOT EXISTS sitepilot_excel_test.sitepilot_upload_jobs (
  job_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  original_name TEXT NOT NULL,
  temp_path TEXT,
  file_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'parsing', 'chunking', 'structured_import', 'embedding', 'indexing', 'completed', 'failed'
  )),
  progress_processed BIGINT NOT NULL DEFAULT 0 CHECK (progress_processed >= 0),
  progress_total BIGINT CHECK (progress_total IS NULL OR progress_total >= 0),
  error_code TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  lease_owner TEXT,
  lease_token UUID,
  lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at TIMESTAMPTZ,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sitepilot_upload_jobs_claim_idx
  ON sitepilot_excel_test.sitepilot_upload_jobs (status, lease_expires_at, created_at);
CREATE INDEX IF NOT EXISTS sitepilot_upload_jobs_owner_idx
  ON sitepilot_excel_test.sitepilot_upload_jobs (tenant_id, user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS sitepilot_upload_jobs_dedupe_idx
  ON sitepilot_excel_test.sitepilot_upload_jobs (tenant_id, group_id, user_id, file_sha256)
  WHERE status <> 'failed';

CREATE TABLE IF NOT EXISTS sitepilot_excel_test.sitepilot_upload_job_events (
  event_id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES sitepilot_excel_test.sitepilot_upload_jobs(job_id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  progress_processed BIGINT NOT NULL,
  progress_total BIGINT,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sitepilot_upload_job_events_scope_idx
  ON sitepilot_excel_test.sitepilot_upload_job_events (job_id, event_id);

REVOKE ALL ON TABLE sitepilot_excel_test.sitepilot_upload_jobs FROM PUBLIC;
REVOKE ALL ON TABLE sitepilot_excel_test.sitepilot_upload_job_events FROM PUBLIC;
REVOKE ALL ON SEQUENCE sitepilot_excel_test.sitepilot_upload_job_events_event_id_seq FROM PUBLIC;
