# SitePilot Workspace

The SitePilot HTTP service now provides user-scoped conversations, search history, and a document library using the existing PostgreSQL schema and upload volume. Migration `006_sitepilot_workspace` is applied by the existing migration runner at API/worker startup.

## Local Ollama agent (opt-in)

The Agent can use a local Ollama server without enabling external LLM data
processing. Set the following in the backend-only `.env.docker` file:

```env
SITEPILOT_LLM_PROVIDER=ollama
SITEPILOT_LLM_MODEL=qwen3:8b
SITEPILOT_OLLAMA_BASE_URL=http://host.docker.internal:11434
SITEPILOT_LLM_TIMEOUT_MS=120000
SITEPILOT_EXTERNAL_LLM_DATA_ALLOWED=false
```

With Docker Desktop on macOS or Windows, `host.docker.internal` resolves from
the API container to the host. Ollama must be running on the host and listening
on port `11434`; make it reachable from Docker Desktop, but restrict the host
firewall to the local Docker/host network. Do not port-forward Ollama or expose
it to the public internet. The backend rejects non-local Ollama URLs. You can
check availability with `curl http://localhost:11434/api/tags`; this does not
download a model. The application never pulls models. Download `qwen3:8b`
separately on the host when convenient, then recreate the API container.
For Qwen3, requests set `think: false`; reasoning fields and `<think>` blocks
are withheld from streamed output. If Ollama reports that the configured model
is missing, the Agent returns the `MODEL_NOT_INSTALLED` SSE error and persists
that safe error code with the failed assistant message.

Ollama uses its native `/api/chat` endpoint with system, prior conversation,
and current evidence messages. Factual responses include evidence references;
SitePilot checks the references and numeric values locally, then asks the same
provider for a bounded supported/insufficient/conflicting verdict before
emitting SSE text or persisting the answer. This is at most two model calls per
factual response; direct greetings, metadata, and structured SQL answers do
not use that verifier call. `SITEPILOT_LLM_TIMEOUT_MS` bounds provider calls.

## Gemini agent (external opt-in)

Gemini uses the official `@google/genai` SDK. It sends only up to five authorized, redacted search chunks plus a validated structured aggregate result. It does not send the workbook itself. External generation remains unavailable unless the API container has all of:

```env
SITEPILOT_LLM_PROVIDER=gemini
SITEPILOT_LLM_MODEL=gemini-3.5-flash-lite
SITEPILOT_EXTERNAL_LLM_DATA_ALLOWED=true
GEMINI_API_KEY=<server-side key>
```

Keep `GEMINI_API_KEY` in the backend-only `.env.docker`, never in the frontend or a `VITE_` variable. The checked-in example deliberately leaves external processing disabled. Do not enable billing. Confirm the key's Google AI Studio project has an available free tier before enabling generation; the application does not infer the key's billing eligibility. The provider timeout is bounded by `SITEPILOT_LLM_TIMEOUT_MS` (15 seconds by default, maximum 30 seconds).

Without either a configured local Ollama provider or explicitly authorized Gemini settings, the API records an assistant failure and returns a clear unavailable response; document search continues to work. Provider calls include no logs of prompt text, document contents, or API keys. Agent responses stream incrementally through the authenticated SSE endpoint.

The Agent uses a bounded structured tool plan: conversational replies, document
inventory, document metadata, structured spreadsheet analytics, or authorized
TypeGraph hybrid search. Knowledge answers are checked against the cited
chunks; uncited claims, unsupported numbers, conflicting sources, or invalid
verifier output fail closed as insufficient/conflicting evidence. It does not
automatically attach the top search results. Retrieved text is untrusted data,
and model reasoning fields are never returned or logged.

## Document formats and batch uploads

`POST /api/documents/upload` still accepts one `file` field with the existing
single-job response. It also accepts up to four `file` or `files` parts in one
request (maximum 25 MiB per file and 50 MiB total); a batch returns a `jobs`
array with an independent job ID, status, duplicate flag, and progress for each
file. Every file is validated and queued independently under the authenticated
tenant and group.

Supported formats are `.xlsx`, `.docx`, `.txt`, and `.md`. Legacy `.doc` is
rejected as unsupported because no secure converter is configured. DOCX is
parsed with Mammoth with external file access disabled, after bounded ZIP
archive checks. Markdown is parsed into headings, paragraphs, lists, tables,
and code blocks; TXT is decoded as strict UTF-8 with normalized line endings.
Chunks retain the filename, heading path, paragraph/table location, content
hash, and stable IDs for retry-safe TypeGraph upserts. The default chunk size
is 384 tokens with 48 tokens of overlap, measured with the cached multilingual
E5 tokenizer already used for embeddings. Configure
`SITEPILOT_DOCUMENT_CHUNK_SIZE_TOKENS` (64–480) and
`SITEPILOT_DOCUMENT_CHUNK_OVERLAP_TOKENS` (0–half the selected size). Legacy
`*_CHARS` settings are accepted by converting their values to approximate token
settings; chunk boundaries themselves always use the actual tokenizer. Markdown
and TXT citations carry source line ranges; Word citations carry extracted
paragraph ranges and heading sections. Tokenizer loading is local-only and does
not download a model. Parsing and indexing remain in the existing PostgreSQL-backed worker.

## APIs

- `POST/GET /api/agent/conversations`, `GET/PATCH/DELETE /api/agent/conversations/:id`, `POST /api/agent/conversations/:id/messages`
- `GET/POST/DELETE /api/search/history`, `DELETE /api/search/history/:id`
- `GET /api/documents`, `GET /api/documents/:id/download`
- `GET /api/documents/search?q=...`; the UI uses `saveHistory=true` for an explicit submitted search.
- `POST /api/documents/upload` accepts one file or a batch; each file gets its own job and existing `GET /api/jobs/:jobId` / `/events` tracking.

All routes require the existing SitePilot JWT (`aud=sitepilot-upload`) and are scoped to authenticated tenant, group, and user. Conversations and history are user-private; document listing/download and every ingested format follow the tenant and access-group boundary, matching the existing search visibility model. Downloads stream from storage and return 410 when an old original is no longer present.

## Original files

Previously, `SITEPILOT_UPLOAD_RETENTION_HOURS` also deleted the original user upload. This was an unsafe conflation of staging and user-owned files. The default now retains originals indefinitely. Automatic deletion is disabled unless an operator explicitly sets `SITEPILOT_DELETE_ORIGINALS_AFTER_HOURS` to a positive number. Existing rows whose originals were already removed remain visible with `downloadAvailable: false`; files are never reconstructed from embeddings.

No originals, indexed rows, or vector data are removed by migration `006`.
