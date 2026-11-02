# SitePilot XLSX ingestion: queue audit and production hardening

## TypeGraph Jobs audit

TypeGraph v0.7.0 Jobs are persistence primitives, not a background execution system.

- [`job.ts`](/Users/ali/Desktop/Typegraph/packages/sdk/src/types/job.ts:5) has the four statuses `pending`, `processing`, `complete`, and `failed`, plus one processed/total pair. It has no stage, attempt, lease, or cancellation fields.
- [`typegraph.ts`](/Users/ali/Desktop/Typegraph/packages/sdk/src/typegraph.ts:270) exposes get/list/upsert/updateStatus/incrementProgress. It has no enqueue/claim API or worker loop.
- [`migrations.ts`](/Users/ali/Desktop/Typegraph/packages/adapters/pgvector/src/migrations.ts:514) creates persistent `typegraph_jobs`; [`job-store.ts`](/Users/ali/Desktop/Typegraph/packages/adapters/pgvector/src/job-store.ts:146) applies status patches and atomic progress increments. Its `get(id)` is not an upload authorization check; upload access is scoped separately in this service.
- Existing `IngestOptions.onProgress` was not called by pre-chunked ingest. [`engine.ts`](/Users/ali/Desktop/Typegraph/packages/sdk/src/index-engine/engine.ts:330) now emits measured embed/store progress callbacks.

The custom queue remains PostgreSQL-backed. No Redis, BullMQ, or paid model API is used.

## Audit findings and changes

| Area            | Confirmed issue                                                                                                                                                                                                                                                               | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lease ownership | The original worker refreshed a ten-minute lease only while reporting progress. A slow parser, database write, or model call could outlive it. The original `lease_owner` was a reusable worker ID, so it could not fence a previous claim from a later claim by that worker. | Each claim now gets a UUID lease token and monotonically increasing generation. A dedicated Node worker thread renews with database time every configured interval. Progress, retry, completion, and publication require the same owner, token, generation, and an unexpired lease. See [`claimNext` and `updateProgress`](/Users/ali/Desktop/Typegraph/src/sitepilot/documents/sitepilot-upload-jobs.mts:306), [`renewLease`](/Users/ali/Desktop/Typegraph/src/sitepilot/documents/sitepilot-upload-jobs.mts:443), and the [heartbeat worker](/Users/ali/Desktop/Typegraph/src/sitepilot/workers/sitepilot-upload-heartbeat.mjs:1). |
| Retry behavior  | The original retry path requeued immediately and did not identify retry events.                                                                                                                                                                                               | Retries use 5s exponential backoff capped at 5 minutes, max three claims, and persist a `retry` event with the attempt number. See [`failOrRetry`](/Users/ali/Desktop/Typegraph/src/sitepilot/documents/sitepilot-upload-jobs.mts:596).                                                                                                                                                                                                                                                                                                                                                                |
| Stale writes    | Job status alone did not protect the final completion update from a stale claimant.                                                                                                                                                                                           | Every state mutation is fenced. Version activation and completed status commit in the same PostgreSQL transaction. Stale vector writes from a previous attempt use the same content-derived IDs and are idempotent; they cannot activate a version.                                                                                                                                                                                                                                                                                                                                    |
| Publication     | TypeGraph vector indexing and structured PostgreSQL import cannot share one transaction. A failed ingest could leave some vectors searchable.                                                                                                                                 | Upload file versions are staged in PostgreSQL and marked active only with job completion. `/api/documents/search` filters staged and superseded upload versions; the previous completed version stays active until promotion. The consistency boundary and remaining direct-SDK limitation are below.                                                                                                                                                                                                                                                                                  |
| Upload files    | The original default used the OS temp directory, so a queued file could disappear on host/container replacement.                                                                                                                                                              | `FILE_STORAGE_ROOT` (legacy alias `SITEPILOT_UPLOAD_STORAGE_DIR`) selects storage. Compose mounts the shared `sitepilot_uploads` volume at `/app/storage/uploads`. New jobs store relative random storage keys; files are atomically renamed into place, set to `0600`, and revalidated by path and SHA-256. See [`readVerifiedUpload`](/Users/ali/Desktop/Typegraph/src/sitepilot/api/sitepilot-upload-server.mts:54) and [`Docker storage guide`](/Users/ali/Desktop/Typegraph/docs/sitepilot-docker-storage.md).                                                                              |
| File retention  | Immediate cleanup removed originals as soon as processing finished.                                                                                                                                                                                                           | Completed and exhausted files remain for `SITEPILOT_UPLOAD_RETENTION_HOURS` (default 24); queued/retrying files remain until terminal state. Expired terminal references are cleared before files are removed. Unreferenced crash leftovers are cleaned after one hour.                                                                                                                                                                                                                                                                                                                |
| SSE volume      | The prior 3,105-record run wrote 909 events. Embedding/indexing stage changes alternated every batch.                                                                                                                                                                         | PostgreSQL progress remains authoritative, while event history emits on meaningful percentage changes and real stage changes. Pipeline progress no longer flips stages for every batch. SSE replays history, sends a current snapshot, and resumes by `Last-Event-ID`; terminal reconnects get a final snapshot. See [`updateProgress`](/Users/ali/Desktop/Typegraph/src/sitepilot/documents/sitepilot-upload-jobs.mts:374) and the [SSE handler](/Users/ali/Desktop/Typegraph/src/sitepilot/api/sitepilot-upload-server.mts:611).                                                                               |
| Resource limits | Upload request concurrency and per-process worker/embedding fanout were not bounded tightly enough for a small host.                                                                                                                                                          | At most four multipart uploads and 50 SSE streams are active per process; queue depth defaults to 50; free storage must retain a 128 MiB reserve; at most two ingestion workers run; pipeline batches are eight records; the model is shared, q8 by default, and ONNX uses two intra-op and one inter-op threads.                                                                                                                                                                                                                                                                      |

Queue schema and indexes are in [`003_sitepilot_upload_jobs.sql`](/Users/ali/Desktop/Typegraph/migrations/003_sitepilot_upload_jobs.sql:1). Upgrade columns, progress-event metadata, and upload-version publication are in [`004_sitepilot_upload_hardening.sql`](/Users/ali/Desktop/Typegraph/migrations/004_sitepilot_upload_hardening.sql:1). Both run idempotently at service startup.

## Worker behavior and configuration

Start with `pnpm run sitepilot:upload-server`. Required environment values are `DATABASE_URL` and `SITEPILOT_JWT_SECRET`; JWTs must be HS256, audience `sitepilot-upload`, and carry trusted `sub`, `tenant_id`, `sitepilot_group_id`, group membership, and `exp` claims. The service derives all job and TypeGraph scope from those claims.

Optional settings:

- `FILE_STORAGE_ROOT`: storage directory, preferred over the legacy `SITEPILOT_UPLOAD_STORAGE_DIR`. Mount it as the same Docker volume in both API and worker services.
- `SITEPILOT_UPLOAD_RETENTION_HOURS`: retain terminal source files for 24 hours by default (1–8760 hours).
- `SITEPILOT_UPLOAD_WORKERS`: 1 or 2; default 1.
- `SITEPILOT_UPLOAD_LEASE_MS`: 15 seconds to 1 hour; default 120 seconds.
- `SITEPILOT_UPLOAD_HEARTBEAT_MS`: default 20 seconds, automatically capped at one third of the lease.
- `SITEPILOT_UPLOAD_MAX_QUEUED`: default 50.
- `SITEPILOT_UPLOAD_STORAGE_RESERVE_BYTES`: default 128 MiB.
- `SITEPILOT_EMBEDDING_DTYPE`: `q8` by default; `q4` or `fp32` are available.
- `SITEPILOT_EMBEDDING_THREADS`: 1–8; default 2.

The worker thread renews leases independently of Excel parsing and inference. The lease is calculated using PostgreSQL `clock_timestamp()`. If renewal cannot be made, future progress/completion calls fail their token/generation/expiry check. The worker stops and the next claimant recovers after expiry. Shutdown stops HTTP/SSE connections and waits for in-flight jobs to finish.

Retry delivery is at least once. Stable content-derived file IDs and record/chunk IDs make structured upserts and vector writes repeatable. `markRecordSynced` updates structured record/chunk state in one database transaction. A test-injected failure after all vectors are written but before publication demonstrates that the version remains hidden and the next attempt can publish it.

## API and observability

- `POST /api/documents/upload` — one `.xlsx` file with the XLSX MIME type; returns a job ID. Identical content by the same tenant/group/user deduplicates.
- `GET /api/jobs/:jobId` — tenant/group/user scoped polling with status, attempt, processed/total, and measured percentage.
- `GET /api/jobs/:jobId/events` — persisted SSE with event IDs, attempt, stage, progress, and snapshot; reconnect using `Last-Event-ID` or `?after=`.
- `GET /api/documents/search?q=...` — tenant/group scoped hybrid search returning only active upload versions plus legacy documents not managed by this upload queue.
- `GET /health` — queue counts, active workers, retries, average queue/job/stage durations, embedding throughput, and lease renewal failures. It contains aggregate service counts only.

Multipart input is capped at 25 MiB; archive validation caps entries, expansion, compression ratio, worksheets, rows, and columns. Four concurrent bodies bound upload buffering, and a queue limit plus storage reserve provide backpressure. Error codes and logs omit cell values.

## Verification and measurements

Run unit and repository checks:

```sh
pnpm run sitepilot:upload-test
pnpm run sitepilot:excel-test
pnpm run typecheck
pnpm run build
pnpm test
```

Run the database-backed integration (default: the existing six-sheet, 3,105-record workbook):

```sh
pnpm run sitepilot:upload-integration
```

The integration test uses random tenant/user scopes and a test-only failure hook. It covers two concurrent claimers, lease renewal and expiry takeover, stale-worker state fencing, retry exhaustion, queued upload across API restart, duplicate upload, invalid archive, tenant/group denial, forced failure after vector indexing but before publish, hidden staged search results, ordered/coalesced SSE, terminal SSE reconnect, successful search, and citations.

Observed full-workbook results with q8 embeddings, two intra-op threads, one inter-op thread, and the pre-publication failure/retry:

- 3,105 records/chunks indexed; attempt 1 renewed its lease 12 times, then failed at the injected publication boundary. Attempt 2 reconciled and published the same 3,105-record version.
- SSE output: 314 events versus the previous 909-event run (about 65% fewer). This run includes two attempts; events remain grouped by stage and attempt.
- Peak process RSS: 1,035 MiB. Process CPU time: 402 seconds. These are single local-run measurements, not capacity guarantees; model cold start and host scheduling affect them.
- q8 reduced a sanitized one-record cold-start sample from about 2,082 MiB under the previous fp32 setting to about 912 MiB. The full run stayed close to 1 GiB RSS.

## Remaining production limits

- TypeGraph document ingest is not transactionally coupled to the custom queue or structured SQL. The upload API hides staged versions and promotes atomically in PostgreSQL, but direct TypeGraph SDK searches or direct SQL reads that bypass the upload API/version table can see staged data. Route production reads through the authenticated search API or add equivalent version filtering to every reader.
- The integration forces lease expiry and stale-owner calls; it does not kill a separate OS worker during each individual parser, structured-import, embedding, or vector-store instruction. The full run does exercise a multi-minute active job and a failure after vector indexing before publication.
- ExcelJS and the current smart-chunking parser retain the parsed workbook/chunks in memory. The tested peak is around 1 GiB with q8; hosts with less available memory need a streaming parser or external embedding worker before enabling concurrent ingestion.
- Cancellation is not implemented. Host/container replacement preserves files only when `SITEPILOT_UPLOAD_STORAGE_DIR` is on persistent storage. Old vector versions are hidden after promotion but are not physically garbage-collected from TypeGraph yet.
