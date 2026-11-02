CREATE TABLE IF NOT EXISTS sitepilot_excel_test.agent_conversations (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'New conversation',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS agent_conversations_scope_idx
  ON sitepilot_excel_test.agent_conversations (tenant_id, group_id, user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sitepilot_excel_test.agent_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES sitepilot_excel_test.agent_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','complete','failed')),
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_messages_conversation_idx
  ON sitepilot_excel_test.agent_messages (conversation_id, created_at, id);

CREATE TABLE IF NOT EXISTS sitepilot_excel_test.document_search_history (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  query TEXT NOT NULL,
  result_count INTEGER NOT NULL CHECK (result_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS document_search_history_scope_idx
  ON sitepilot_excel_test.document_search_history (tenant_id, group_id, user_id, created_at DESC);

ALTER TABLE sitepilot_excel_test.sitepilot_upload_jobs
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT CHECK (file_size_bytes IS NULL OR file_size_bytes >= 0);

REVOKE ALL ON TABLE sitepilot_excel_test.agent_conversations FROM PUBLIC;
REVOKE ALL ON TABLE sitepilot_excel_test.agent_messages FROM PUBLIC;
REVOKE ALL ON TABLE sitepilot_excel_test.document_search_history FROM PUBLIC;
