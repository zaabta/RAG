CREATE INDEX IF NOT EXISTS excel_records_pending_scan_idx
  ON sitepilot_excel_test.excel_records (file_id, sheet_name, source_row_start, record_id)
  WHERE is_active AND sync_status = 'pending';

CREATE INDEX IF NOT EXISTS excel_chunks_active_document_idx
  ON sitepilot_excel_test.excel_chunks (document_id, chunk_index)
  WHERE is_active;
