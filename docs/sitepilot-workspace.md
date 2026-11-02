# SitePilot Workspace

The SitePilot HTTP service now provides user-scoped conversations, search history, and a document library using the existing PostgreSQL schema and upload volume. Migration `006_sitepilot_workspace` is applied by the existing migration runner at API/worker startup.

## Gemini agent (development opt-in)

The chat route uses the official `@google/genai` SDK. It sends only up to five authorized, redacted search chunks plus a validated structured aggregate result. It does not send the workbook itself. The Agent API remains unavailable unless the API container has all of:

```env
SITEPILOT_LLM_PROVIDER=gemini
SITEPILOT_LLM_MODEL=gemini-3.5-flash-lite
SITEPILOT_EXTERNAL_LLM_DATA_ALLOWED=true
GEMINI_API_KEY=<server-side key>
```

Keep `GEMINI_API_KEY` in the backend-only `.env.docker`, never in the frontend or a `VITE_` variable. The checked-in example deliberately leaves external processing disabled. Do not enable billing. Confirm the key's Google AI Studio project has an available free tier before enabling generation; the application does not infer the key's billing eligibility. The provider timeout is bounded by `SITEPILOT_LLM_TIMEOUT_MS` (15 seconds by default, maximum 30 seconds).

Without those settings, the API records an assistant failure and returns a clear unavailable response; document search continues to work. Provider calls include no logs of prompt text, document contents, or API keys. The current agent response is non-streaming.

## APIs

- `POST/GET /api/agent/conversations`, `GET/PATCH/DELETE /api/agent/conversations/:id`, `POST /api/agent/conversations/:id/messages`
- `GET/POST/DELETE /api/search/history`, `DELETE /api/search/history/:id`
- `GET /api/documents`, `GET /api/documents/:id/download`
- `GET /api/documents/search?q=...`; the UI uses `saveHistory=true` for an explicit submitted search.

All routes require the existing SitePilot JWT (`aud=sitepilot-upload`) and are scoped to authenticated tenant, group, and user. Conversations and history are user-private; document listing/download follow the tenant and access-group boundary, matching the existing search visibility model. Downloads stream from storage and return 410 when an old original is no longer present.

## Original files

Previously, `SITEPILOT_UPLOAD_RETENTION_HOURS` also deleted the original user upload. This was an unsafe conflation of staging and user-owned files. The default now retains originals indefinitely. Automatic deletion is disabled unless an operator explicitly sets `SITEPILOT_DELETE_ORIGINALS_AFTER_HOURS` to a positive number. Existing rows whose originals were already removed remain visible with `downloadAvailable: false`; files are never reconstructed from embeddings.

No originals, indexed rows, or vector data are removed by migration `006`.
