# SitePilot backend architecture audit

## Repository identity

- Git remote: `https://github.com/typegraph-ai/Typegraph.git` (`origin`).
- Checkout: `main`, with `HEAD` and `origin/main` at `43f05208e5e0fd72e2b0e55ecdf597d4f846b7be` (`progress`, 2026-09-01).
- Upstream SDK package: `@typegraph-ai/sdk` **0.7.0**. The PostgreSQL adapter used by SitePilot is the workspace package `@typegraph-ai/adapter-pgvector-pg` 0.1.0, backed by `@typegraph-ai/adapter-pgvector` 0.5.0.
- The checkout contains a dirty worktree. SitePilot additions are untracked/modified files, not upstream commits. Do not treat `scripts/` as disposable or reset the worktree.

## Runtime dependency map

```mermaid
flowchart LR
  EP[src/sitepilot/docker-entrypoint.mjs] --> API[src/sitepilot/api/sitepilot-upload-server.mts]
  API --> AUTH[JWT auth and upload validation]
  API --> JOBS[src/sitepilot/documents/sitepilot-upload-jobs.mts]
  API --> EXCEL[src/sitepilot/excel: parser and import pipeline]
  API --> AGENT[src/sitepilot/agent/sitepilot-workspace.mts]
  API --> TYPEGRAPH[src/sitepilot/excel/sitepilot-excel-config.mts]
  JOBS --> DBM[src/sitepilot/db/sitepilot-migrations.mts]
  EXCEL --> STORE[PostgreSQL structured records/chunks]
  EXCEL --> EMB[src/sitepilot/embeddings/sitepilot-local-embeddings.mts]
  TYPEGRAPH --> SDK[@typegraph-ai/sdk 0.7.0]
  TYPEGRAPH --> PGADAPTER[@typegraph-ai/adapter-pgvector-pg]
  AGENT --> LLM[src/sitepilot/agent/sitepilot-llm-provider.mts]
  AGENT --> TYPEGRAPH
  API --> HB[src/sitepilot/workers/sitepilot-upload-heartbeat.mjs]
  DBM --> SQL[migrations/*.sql]
```

API and Worker containers use the same HTTP/worker entry module; Compose role and worker-count environment determine which loop is active. The entrypoint waits for PostgreSQL and starts the TypeScript server with `tsx`. Queue state, job events, structured Excel rows/chunks, conversations, and search history use parameterized `pg` queries. Vector indexing and retrieval go through the TypeGraph SDK and its PostgreSQL adapter.

## Ownership inventory

| Location | Ownership and responsibility | Runtime use |
| --- | --- | --- |
| `packages/sdk`, `packages/adapters/*`, `packages/mcp-server`, `packages/otel`, `packages/vercel-ai-provider` | Upstream TypeGraph monorepo packages | SitePilot imports SDK and PostgreSQL vector adapter only. Other adapters/integrations are workspace packages, not SitePilot runtime dependencies. |
| `src/sitepilot/api` | SitePilot Node HTTP API, auth, upload validation, SSE, worker orchestration | API and Worker |
| `src/sitepilot/documents` | PostgreSQL upload queue, claims, fencing, retries, progress and publication | API and Worker |
| `src/sitepilot/excel` | Workbook parsing, smart chunking, structured import, indexing pipeline and store | API/Worker and manual Excel CLIs |
| `src/sitepilot/agent` | Conversation/history SQL, analytics, evidence/citation handling, LLM provider | API |
| `src/sitepilot/db` | Version/checksum migration runner | API/Worker and migration integration |
| `src/sitepilot/embeddings`, `src/sitepilot/typegraph` | Local embedding runtime and TypeGraph adapter configuration | Indexing, search, smoke/search CLIs |
| `src/sitepilot/workers` | Lease heartbeat worker-thread implementation | API/Worker process |
| `scripts/sitepilot-*.mts` | Operational CLIs, dev-auth utility, tests, Docker and database integrations | Invoked on demand; not the production source tree |
| `migrations/*.sql` | Versioned SitePilot SQL migrations | Loaded by the migration runner; retained at repository root for compatibility and checksums |
| `docs/sitepilot-*.md` | SitePilot operational and design documentation | Documentation |
| `reports/sitepilot-excel-inspection.json` | Generated inspection report | Not imported at runtime; retained as an existing artifact |
| `packages/**/dist`, root `node_modules`, `.turbo` | Build/dependency artifacts | Regenerated; not application source |

Operational scripts deliberately remain in `scripts/`: `sitepilot-smoke`, `sitepilot-search`, `sitepilot-excel-{audit,inspect,preview,query,import}`, `sitepilot-dev-auth`, SQL performance/migration/upload integrations, and test fixtures. No file was classified as safely removable based on this audit.

## Upstream coupling and unused capabilities

SitePilot consumes TypeGraph as a **workspace SDK dependency**, not as an installed registry package. Docker builds the workspace packages before installing production dependencies. The working tree has a local `packages/sdk/src/index-engine/engine.ts` change adding `onProgress` callbacks around embedding and vector storage, plus its test changes. SitePilot’s ingestion progress pipeline relies on this callback. That is the only inspected upstream-core behavior SitePilot customizes; preserve it unless an equivalent callback is released upstream or moved into a supported adapter boundary.

At runtime, Excel data is chunked by SitePilot’s smart chunker, embedded by its local multilingual model, and indexed/retrieved through TypeGraph. SitePilot sets `graphExtraction: false`; retrieval enables semantic and BM25 weights with RRF and disables graph/recency. TypeGraph graph extraction, graph traversal and cognitive/conversation memory are not invoked by the deployed SitePilot flow. The app implements conversation persistence itself in its own schema. Redis, Prisma, hosted TypeGraph, MCP, OTel, and the other vector adapters are not in the API/Worker import path.

There is intentional overlap at clear boundaries: TypeGraph owns vector indexing/retrieval and its embedding interface; SitePilot owns spreadsheet-aware parsing/chunk creation, structured row analytics, queue/retry/SSE state, auth/tenant checks, file retention, and conversation/history APIs. Replacing these with TypeGraph memory/jobs would change existing contracts and is not warranted by the audited call graph.

## Refactor decision

Production SitePilot modules now live under `src/sitepilot/`, organized by API, agent, documents, Excel, database, embeddings, TypeGraph integration, and worker responsibilities. Operational commands and tests stay under `scripts/`. Docker copies `src/` and migrations rather than shipping the development script directory, and its entrypoint points at the organized application layer.

The least disruptive next step is to keep this upstream-based monorepo until the progress callback change is upstreamed or replaced through a supported hook. A standalone SitePilot backend that imports a published TypeGraph SDK is a sound eventual boundary, but moving repositories now would either lose this required SDK behavior or retain a fork dependency by another name. No framework or ORM is needed for this structural refactor.
