CREATE TABLE IF NOT EXISTS sitepilot_excel_test.excel_files (
  file_id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  latest_run_id UUID,
  sheet_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sitepilot_excel_test.excel_import_runs (
  run_id UUID PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES sitepilot_excel_test.excel_files(file_id),
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'syncing', 'complete', 'failed')),
  sheet_count INTEGER NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  warnings_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  deleted_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  failure_code TEXT
);

CREATE TABLE IF NOT EXISTS sitepilot_excel_test.excel_sheets (
  file_id TEXT NOT NULL REFERENCES sitepilot_excel_test.excel_files(file_id),
  sheet_name TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  column_count INTEGER NOT NULL,
  header_row INTEGER,
  last_seen_run UUID NOT NULL REFERENCES sitepilot_excel_test.excel_import_runs(run_id),
  PRIMARY KEY (file_id, sheet_name)
);

CREATE TABLE IF NOT EXISTS sitepilot_excel_test.excel_records (
  record_id TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL REFERENCES sitepilot_excel_test.excel_files(file_id),
  sheet_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  source_row_start INTEGER NOT NULL,
  source_row_end INTEGER NOT NULL,
  source_range TEXT NOT NULL,
  form_no TEXT,
  event_date DATE,
  company TEXT,
  region TEXT,
  location TEXT,
  violation_main TEXT,
  violation_sub TEXT,
  disciplinary_action TEXT,
  suspension_days NUMERIC,
  normalized_fields JSONB NOT NULL,
  original_headers JSONB NOT NULL,
  cell_states JSONB NOT NULL,
  privacy_status TEXT NOT NULL DEFAULT 'redacted' CHECK (privacy_status = 'redacted'),
  record_hash TEXT NOT NULL,
  document_content TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'delete_pending', 'deleted')),
  last_seen_run UUID NOT NULL REFERENCES sitepilot_excel_test.excel_import_runs(run_id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (file_id, sheet_name, record_key)
);

CREATE TABLE IF NOT EXISTS sitepilot_excel_test.excel_chunks (
  chunk_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES sitepilot_excel_test.excel_records(record_id),
  file_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  record_key TEXT NOT NULL,
  row_start INTEGER NOT NULL,
  row_end INTEGER NOT NULL,
  source_cells JSONB NOT NULL,
  chunk_type TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  narrative_field TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  sync_hash TEXT NOT NULL,
  metadata JSONB NOT NULL,
  access_scope TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'delete_pending', 'deleted')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (file_id, sheet_name, record_key)
    REFERENCES sitepilot_excel_test.excel_records(file_id, sheet_name, record_key)
);

CREATE TABLE IF NOT EXISTS sitepilot_excel_test.excel_import_warnings (
  warning_id BIGSERIAL PRIMARY KEY,
  run_id UUID NOT NULL REFERENCES sitepilot_excel_test.excel_import_runs(run_id),
  file_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  row_number INTEGER,
  cell_ref TEXT,
  warning_code TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS excel_records_file_active_idx
  ON sitepilot_excel_test.excel_records (file_id, is_active, sheet_name);
CREATE INDEX IF NOT EXISTS excel_records_form_no_idx
  ON sitepilot_excel_test.excel_records (file_id, form_no) WHERE is_active;
CREATE INDEX IF NOT EXISTS excel_records_event_date_idx
  ON sitepilot_excel_test.excel_records (file_id, event_date) WHERE is_active;
CREATE INDEX IF NOT EXISTS excel_records_violation_idx
  ON sitepilot_excel_test.excel_records (file_id, violation_main, violation_sub) WHERE is_active;
CREATE INDEX IF NOT EXISTS excel_records_region_idx
  ON sitepilot_excel_test.excel_records (file_id, region) WHERE is_active;
CREATE INDEX IF NOT EXISTS excel_records_action_idx
  ON sitepilot_excel_test.excel_records (file_id, disciplinary_action) WHERE is_active;
CREATE INDEX IF NOT EXISTS excel_chunks_active_record_idx
  ON sitepilot_excel_test.excel_chunks (file_id, document_id, chunk_index) WHERE is_active;
CREATE INDEX IF NOT EXISTS excel_import_runs_file_time_idx
  ON sitepilot_excel_test.excel_import_runs (file_id, started_at DESC);

REVOKE ALL ON SCHEMA sitepilot_excel_test FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA sitepilot_excel_test FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA sitepilot_excel_test FROM PUBLIC;
