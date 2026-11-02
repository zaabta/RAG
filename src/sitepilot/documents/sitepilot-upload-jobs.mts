import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import { runSitePilotMigrations, SITEPILOT_MIGRATION_LOCK_KEY } from '../db/sitepilot-migrations.mjs'

export type UploadJobStage =
  | 'queued'
  | 'parsing'
  | 'chunking'
  | 'structured_import'
  | 'embedding'
  | 'indexing'
  | 'completed'
  | 'failed'

export interface UploadJobIdentity {
  tenantId: string
  groupId: string
  userId: string
}

export function stableUploadFileId(tenantId: string, groupId: string, fileSha256: string): string {
  return `file_${createHash('sha256').update(`${tenantId}:${groupId}:${fileSha256}`).digest('hex').slice(0, 40)}`
}

export interface UploadJobView {
  jobId: string
  status: UploadJobStage
  progress: { processed: number; total: number | null; percent: number | null }
  errorCode?: string
  createdAt: string
  updatedAt: string
  attempt: number
}

interface UploadJobRow extends QueryResultRow {
  job_id: string
  tenant_id: string
  group_id: string
  user_id: string
  original_name: string
  temp_path: string | null
  file_sha256: string
  status: UploadJobStage
  progress_processed: string | number
  progress_total: string | number | null
  error_code: string | null
  attempt_count: number
  max_attempts: number
  lease_owner: string | null
  lease_token: string | null
  lease_generation: string | number
  next_attempt_at: Date | null
  stage_started_at: Date
  attempt_started_at: Date | null
  result: Record<string, unknown> | null
  created_at: Date
  updated_at: Date
}

export interface ClaimedUploadJob extends UploadJobRow {
  progress_processed: number
  progress_total: number | null
  lease_token: string
  lease_generation: number
}

export interface UploadJobEvent {
  id: string
  status: UploadJobStage
  progress: { processed: number; total: number | null; percent: number | null }
  errorCode?: string
  createdAt: string
  attempt: number
  kind: 'snapshot' | 'progress' | 'retry' | 'terminal'
}

function jobView(row: UploadJobRow): UploadJobView {
  const processed = Number(row.progress_processed)
  const total = row.progress_total == null ? null : Number(row.progress_total)
  return {
    jobId: row.job_id,
    status: row.status,
    progress: {
      processed,
      total,
      percent: total != null && total > 0 ? Math.floor((processed / total) * 100) : null,
    },
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    attempt: row.attempt_count,
  }
}

async function transaction<T>(client: PoolClient, callback: () => Promise<T>): Promise<T> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [
      SITEPILOT_MIGRATION_LOCK_KEY,
    ])
    const value = await callback()
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export class SitePilotUploadJobs {
  private readonly pool: Pool
  private readonly eventPercentStep: number

  constructor(databaseUrl: string, options: { eventPercentStep?: number } = {}) {
    this.eventPercentStep = Math.max(1, Math.min(10, options.eventPercentStep ?? 1))
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      application_name: 'sitepilot-upload-api',
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async migrate(): Promise<void> {
    await runSitePilotMigrations(this.pool, 'sitepilot_excel_test')
  }

  async enqueue(input: {
    identity: UploadJobIdentity
    originalName: string
    tempPath: string
    fileSha256: string
    fileSizeBytes?: number
  }): Promise<{ job: UploadJobView; duplicate: boolean; tempPathToDelete?: string }> {
    const client = await this.pool.connect()
    try {
      const result = await transaction(client, async () => {
        const existing = await client.query<UploadJobRow>(
          `SELECT * FROM sitepilot_excel_test.sitepilot_upload_jobs
           WHERE tenant_id = $1 AND group_id = $2 AND user_id = $3 AND file_sha256 = $4 AND status <> 'failed'
           ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
          [
            input.identity.tenantId,
            input.identity.groupId,
            input.identity.userId,
            input.fileSha256,
          ],
        )
        if (existing.rowCount) {
          return { row: existing.rows[0]!, duplicate: true, tempPathToDelete: input.tempPath }
        }
        const jobId = randomUUID()
        const inserted = await client.query<UploadJobRow>(
          `INSERT INTO sitepilot_excel_test.sitepilot_upload_jobs
             (job_id, tenant_id, group_id, user_id, original_name, temp_path, file_sha256, status, file_size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'queued',$8) RETURNING *`,
          [
            jobId,
            input.identity.tenantId,
            input.identity.groupId,
            input.identity.userId,
            input.originalName,
            input.tempPath,
            input.fileSha256,
            input.fileSizeBytes ?? null,
          ],
        )
        await this.insertEvent(client, inserted.rows[0]!)
        await client.query(
          `INSERT INTO sitepilot_excel_test.sitepilot_upload_file_versions
           (job_id, tenant_id, group_id, user_id, original_name, file_sha256, file_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            jobId,
            input.identity.tenantId,
            input.identity.groupId,
            input.identity.userId,
            input.originalName,
            input.fileSha256,
            stableUploadFileId(input.identity.tenantId, input.identity.groupId, input.fileSha256),
          ],
        )
        return { row: inserted.rows[0]!, duplicate: false }
      })
      return {
        job: jobView(result.row),
        duplicate: result.duplicate,
        ...(result.tempPathToDelete ? { tempPathToDelete: result.tempPathToDelete } : {}),
      }
    } catch (error) {
      if ((error as { code?: string }).code === '23505') {
        const existing = await this.getByDigest(input.identity, input.fileSha256)
        if (existing)
          return { job: jobView(existing), duplicate: true, tempPathToDelete: input.tempPath }
      }
      throw error
    } finally {
      client.release()
    }
  }

  private async getByDigest(
    identity: UploadJobIdentity,
    fileSha256: string,
  ): Promise<UploadJobRow | null> {
    const result = await this.pool.query<UploadJobRow>(
      `SELECT * FROM sitepilot_excel_test.sitepilot_upload_jobs
       WHERE tenant_id = $1 AND group_id = $2 AND user_id = $3 AND file_sha256 = $4 AND status <> 'failed'
       ORDER BY created_at DESC LIMIT 1`,
      [identity.tenantId, identity.groupId, identity.userId, fileSha256],
    )
    return result.rows[0] ?? null
  }

  async getOwned(jobId: string, identity: UploadJobIdentity): Promise<UploadJobView | null> {
    const result = await this.pool.query<UploadJobRow>(
      `SELECT * FROM sitepilot_excel_test.sitepilot_upload_jobs
       WHERE job_id = $1 AND tenant_id = $2 AND group_id = $3 AND user_id = $4`,
      [jobId, identity.tenantId, identity.groupId, identity.userId],
    )
    return result.rows[0] ? jobView(result.rows[0]) : null
  }

  async snapshotOwned(jobId: string, identity: UploadJobIdentity): Promise<UploadJobEvent | null> {
    const result = await this.pool.query<UploadJobRow & { latest_event_id: string | null }>(
      `SELECT j.*, (SELECT MAX(event_id)::text FROM sitepilot_excel_test.sitepilot_upload_job_events e WHERE e.job_id = j.job_id) AS latest_event_id
       FROM sitepilot_excel_test.sitepilot_upload_jobs j
       WHERE job_id = $1 AND tenant_id = $2 AND group_id = $3 AND user_id = $4`,
      [jobId, identity.tenantId, identity.groupId, identity.userId],
    )
    const row = result.rows[0]
    if (!row) return null
    const view = jobView(row)
    return {
      id: row.latest_event_id ?? '0',
      status: view.status,
      progress: view.progress,
      ...(view.errorCode ? { errorCode: view.errorCode } : {}),
      createdAt: view.updatedAt,
      attempt: row.attempt_count,
      kind: 'snapshot',
    }
  }

  async eventsAfter(
    jobId: string,
    identity: UploadJobIdentity,
    afterEventId: string,
  ): Promise<UploadJobEvent[]> {
    const result = await this.pool.query<
      QueryResultRow & {
        event_id: string | number
        status: UploadJobStage
        progress_processed: string | number
        progress_total: string | number | null
        error_code: string | null
        attempt_count: number
        event_kind: UploadJobEvent['kind']
        created_at: Date
      }
    >(
      `SELECT event_id, status, progress_processed, progress_total, error_code, created_at, attempt_count, event_kind
       FROM sitepilot_excel_test.sitepilot_upload_job_events
       WHERE job_id = $1 AND tenant_id = $2 AND user_id = $3 AND event_id > $4
       ORDER BY event_id LIMIT 250`,
      [jobId, identity.tenantId, identity.userId, afterEventId],
    )
    return result.rows.map((row) => {
      const processed = Number(row.progress_processed)
      const total = row.progress_total == null ? null : Number(row.progress_total)
      return {
        id: String(row.event_id),
        status: row.status,
        progress: {
          processed,
          total,
          percent: total != null && total > 0 ? Math.floor((processed / total) * 100) : null,
        },
        ...(row.error_code ? { errorCode: row.error_code } : {}),
        createdAt: new Date(row.created_at).toISOString(),
        attempt: row.attempt_count,
        kind: row.event_kind,
      }
    })
  }

  async claimNext(
    workerId: string,
    leaseDurationMs = 10 * 60_000,
    tenantScope?: string,
  ): Promise<ClaimedUploadJob | null> {
    const client = await this.pool.connect()
    const leaseToken = randomUUID()
    try {
      return await transaction(client, async () => {
        const claimed = await client.query<UploadJobRow>(
          `WITH candidate AS (
             SELECT job_id FROM sitepilot_excel_test.sitepilot_upload_jobs
             WHERE ($4::text IS NULL OR tenant_id = $4) AND (
               (status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp()))
                OR (status NOT IN ('queued','completed','failed') AND lease_expires_at < clock_timestamp() AND attempt_count < max_attempts)
             )
             ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
           )
           UPDATE sitepilot_excel_test.sitepilot_upload_jobs j
           SET status = 'parsing', progress_processed = 0, progress_total = NULL,
               error_code = NULL, attempt_count = attempt_count + 1,
               lease_owner = $1, lease_token = $2, lease_generation = lease_generation + 1,
               lease_expires_at = clock_timestamp() + ($3::bigint * INTERVAL '1 millisecond'),
               attempt_started_at = clock_timestamp(), stage_started_at = clock_timestamp(), next_attempt_at = NULL, updated_at = clock_timestamp()
           FROM candidate WHERE j.job_id = candidate.job_id RETURNING j.*`,
          [workerId, leaseToken, leaseDurationMs, tenantScope ?? null],
        )
        if (!claimed.rowCount) return null
        await this.insertEvent(client, claimed.rows[0]!)
        const row = claimed.rows[0]!
        return {
          ...row,
          progress_processed: Number(row.progress_processed),
          progress_total: row.progress_total == null ? null : Number(row.progress_total),
          lease_token: row.lease_token!,
          lease_generation: Number(row.lease_generation),
        }
      })
    } finally {
      client.release()
    }
  }

  private async insertEvent(
    client: PoolClient,
    row: UploadJobRow,
    kind: UploadJobEvent['kind'] = 'progress',
    stageDurationMs: number | null = null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO sitepilot_excel_test.sitepilot_upload_job_events
         (job_id, tenant_id, user_id, status, progress_processed, progress_total, error_code, attempt_count, event_kind, stage_duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        row.job_id,
        row.tenant_id,
        row.user_id,
        row.status,
        row.progress_processed,
        row.progress_total,
        row.error_code,
        row.attempt_count,
        kind,
        stageDurationMs,
      ],
    )
  }

  async updateProgress(
    job: ClaimedUploadJob,
    stage: UploadJobStage,
    processed: number,
    total: number | null,
  ): Promise<void> {
    const client = await this.pool.connect()
    try {
      await transaction(client, async () => {
        const previous = await client.query<{
          status: UploadJobStage
          progress_processed: string | number
          progress_total: string | number | null
          stage_started_at: Date
        }>(
          `SELECT status, progress_processed, progress_total, stage_started_at
           FROM sitepilot_excel_test.sitepilot_upload_jobs
           WHERE job_id = $1 AND lease_token = $2 AND lease_generation = $3
             AND lease_expires_at > clock_timestamp() FOR UPDATE`,
          [job.job_id, job.lease_token, job.lease_generation],
        )
        if (!previous.rowCount) throw new Error('Job lease was lost')
        const result = await client.query<UploadJobRow>(
          `UPDATE sitepilot_excel_test.sitepilot_upload_jobs
           SET status = $4,
               progress_processed = CASE WHEN status = $4 THEN GREATEST(progress_processed, $5) ELSE $5 END,
               progress_total = $6,
               stage_started_at = CASE WHEN status = $4 THEN stage_started_at ELSE clock_timestamp() END,
               updated_at = clock_timestamp()
           WHERE job_id = $1 AND lease_token = $2 AND lease_generation = $3 AND lease_expires_at > clock_timestamp()
             AND status NOT IN ('completed','failed')
           RETURNING *`,
          [job.job_id, job.lease_token, job.lease_generation, stage, processed, total],
        )
        if (!result.rowCount) throw new Error('Job lease was lost')
        const row = result.rows[0]!
        const before = previous.rows[0]
        if (!before) throw new Error('Job progress snapshot was not found')
        const oldTotal = before.progress_total == null ? null : Number(before.progress_total)
        const newTotal = total
        const oldPercent =
          oldTotal && oldTotal > 0
            ? Math.floor((Number(before.progress_processed) / oldTotal) * 100)
            : null
        const newPercent =
          newTotal && newTotal > 0
            ? Math.floor((Number(row.progress_processed) / newTotal) * 100)
            : null
        const stageChanged = before.status !== row.status
        const meaningful =
          stageChanged ||
          (newPercent !== null &&
            newPercent !== oldPercent &&
            newPercent % this.eventPercentStep === 0)
        if (meaningful) {
          await this.insertEvent(
            client,
            row,
            stage === 'completed' || stage === 'failed' ? 'terminal' : 'progress',
            stageChanged
              ? Math.max(0, Date.now() - new Date(before.stage_started_at).getTime())
              : null,
          )
        }
      })
    } finally {
      client.release()
    }
  }

  async renewLease(job: ClaimedUploadJob, leaseDurationMs: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE sitepilot_excel_test.sitepilot_upload_jobs
       SET lease_expires_at = clock_timestamp() + ($5::bigint * INTERVAL '1 millisecond'), updated_at = clock_timestamp()
       WHERE job_id = $1 AND lease_owner = $2 AND lease_token = $3 AND lease_generation = $4
         AND lease_expires_at > clock_timestamp() AND status NOT IN ('queued','completed','failed')`,
      [job.job_id, job.lease_owner, job.lease_token, job.lease_generation, leaseDurationMs],
    )
    return result.rowCount === 1
  }

  async metrics(): Promise<Record<string, number>> {
    const result = await this.pool.query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM sitepilot_excel_test.sitepilot_upload_jobs GROUP BY status`,
    )
    const counts = Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count)]))
    const details = await this.pool.query<{
      retries: string
      avg_duration_ms: string | null
      avg_queue_wait_ms: string | null
      avg_stage_duration_ms: string | null
      indexed_records: string
      embedding_duration_ms: string
    }>(
      `SELECT
         COALESCE(SUM(GREATEST(attempt_count - 1, 0)), 0)::text AS retries,
         COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000) FILTER (WHERE completed_at IS NOT NULL), 0)::text AS avg_duration_ms,
         COALESCE(AVG(EXTRACT(EPOCH FROM (attempt_started_at - created_at)) * 1000) FILTER (WHERE attempt_started_at IS NOT NULL), 0)::text AS avg_queue_wait_ms,
         COALESCE((SELECT AVG(stage_duration_ms) FROM sitepilot_excel_test.sitepilot_upload_job_events WHERE stage_duration_ms IS NOT NULL), 0)::text AS avg_stage_duration_ms,
         COALESCE(SUM((result->>'indexedRecords')::bigint) FILTER (WHERE status = 'completed'), 0)::text AS indexed_records,
         COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - attempt_started_at)) * 1000) FILTER (WHERE status = 'completed'), 0)::text AS embedding_duration_ms
       FROM sitepilot_excel_test.sitepilot_upload_jobs`,
    )
    const detail = details.rows[0]!
    const embeddingDurationMs = Number(detail.embedding_duration_ms)
    return {
      queued: counts.queued ?? 0,
      active: Object.entries(counts)
        .filter(([key]) =>
          ['parsing', 'chunking', 'structured_import', 'embedding', 'indexing'].includes(key),
        )
        .reduce((sum, [, value]) => sum + value, 0),
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
      retries: Number(detail.retries),
      averageJobDurationMs: Number(detail.avg_duration_ms),
      averageQueueWaitMs: Number(detail.avg_queue_wait_ms),
      averageStageDurationMs: Number(detail.avg_stage_duration_ms),
      embeddingRecordsPerSecond:
        embeddingDurationMs > 0 ? Number(detail.indexed_records) / (embeddingDurationMs / 1000) : 0,
    }
  }

  async queuedCount(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM sitepilot_excel_test.sitepilot_upload_jobs WHERE status = 'queued'`,
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  async isTempPathReferenced(tempPath: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM sitepilot_excel_test.sitepilot_upload_jobs
       WHERE temp_path = $1 OR RIGHT(temp_path, char_length($1) + 1) = '/' || $1 LIMIT 1`,
      [tempPath],
    )
    return (result.rowCount ?? 0) > 0
  }

  async visibleUploadFileIds(
    identity: UploadJobIdentity,
    candidateIds: string[],
  ): Promise<{ known: Set<string>; active: Set<string> }> {
    if (candidateIds.length === 0) return { known: new Set(), active: new Set() }
    const result = await this.pool.query<{ file_id: string; is_active: boolean }>(
      `SELECT DISTINCT ON (file_id) file_id, is_active
       FROM sitepilot_excel_test.sitepilot_upload_file_versions
       WHERE tenant_id = $1 AND group_id = $2 AND file_id = ANY($3::text[])
       ORDER BY file_id, is_active DESC`,
      [identity.tenantId, identity.groupId, candidateIds],
    )
    return {
      known: new Set(result.rows.map((row) => row.file_id)),
      active: new Set(result.rows.filter((row) => row.is_active).map((row) => row.file_id)),
    }
  }

  async failExpiredExhausted(): Promise<string[]> {
    const client = await this.pool.connect()
    try {
      return await transaction(client, async () => {
        const failed = await client.query<UploadJobRow & { cleanup_path: string | null }>(
          `WITH expired AS (
             SELECT job_id, temp_path FROM sitepilot_excel_test.sitepilot_upload_jobs
             WHERE status NOT IN ('queued','completed','failed') AND lease_expires_at < clock_timestamp()
               AND attempt_count >= max_attempts FOR UPDATE SKIP LOCKED
           )
           UPDATE sitepilot_excel_test.sitepilot_upload_jobs j
           SET status = 'failed', error_code = 'PROCESSING_FAILED',
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, completed_at = clock_timestamp(), updated_at = clock_timestamp()
           FROM expired WHERE j.job_id = expired.job_id
           RETURNING j.*, expired.temp_path AS cleanup_path`,
        )
        for (const row of failed.rows) await this.insertEvent(client, row, 'terminal')
        return failed.rows.flatMap((row) => (row.cleanup_path ? [row.cleanup_path] : []))
      })
    } finally {
      client.release()
    }
  }

  async complete(
    job: ClaimedUploadJob,
    resultData: Record<string, unknown>,
  ): Promise<string | null> {
    const client = await this.pool.connect()
    try {
      return await transaction(client, async () => {
        const result = await client.query<UploadJobRow>(
          `UPDATE sitepilot_excel_test.sitepilot_upload_jobs
           SET status = 'completed', progress_processed = COALESCE(progress_total, progress_processed),
               result = $5::jsonb, lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
               completed_at = clock_timestamp(), updated_at = clock_timestamp()
           WHERE job_id = $1 AND lease_owner = $2 AND lease_token = $3 AND lease_generation = $4
             AND lease_expires_at > clock_timestamp() RETURNING *`,
          [
            job.job_id,
            job.lease_owner,
            job.lease_token,
            job.lease_generation,
            JSON.stringify(resultData),
          ],
        )
        if (!result.rowCount) return null
        await client.query(
          `UPDATE sitepilot_excel_test.sitepilot_upload_file_versions
           SET is_active = FALSE, published_at = NULL
           WHERE tenant_id = $1 AND group_id = $2 AND lower(original_name) = lower($3) AND is_active`,
          [result.rows[0]!.tenant_id, result.rows[0]!.group_id, result.rows[0]!.original_name],
        )
        await client.query(
          `UPDATE sitepilot_excel_test.sitepilot_upload_file_versions
           SET is_active = TRUE, published_at = clock_timestamp()
           WHERE job_id = $1`,
          [job.job_id],
        )
        await this.insertEvent(client, result.rows[0]!, 'terminal')
        return job.temp_path
      })
    } finally {
      client.release()
    }
  }

  async clearExpiredTerminalStorageKeys(retentionMs: number): Promise<string[]> {
    const result = await this.pool.query<{ temp_path: string }>(
      `WITH expired AS (
         SELECT job_id, temp_path FROM sitepilot_excel_test.sitepilot_upload_jobs
         WHERE status IN ('completed','failed') AND temp_path IS NOT NULL
           AND completed_at < clock_timestamp() - ($1::bigint * INTERVAL '1 millisecond')
         FOR UPDATE SKIP LOCKED
       )
       UPDATE sitepilot_excel_test.sitepilot_upload_jobs j SET temp_path = NULL
       FROM expired WHERE j.job_id = expired.job_id
       RETURNING expired.temp_path`,
      [retentionMs],
    )
    return result.rows.map((row) => row.temp_path)
  }

  async failOrRetry(
    job: ClaimedUploadJob,
    errorCode: string,
    retryable: boolean,
  ): Promise<string | null> {
    const client = await this.pool.connect()
    try {
      return await transaction(client, async () => {
        const rowResult = await client.query<UploadJobRow>(
          `SELECT * FROM sitepilot_excel_test.sitepilot_upload_jobs WHERE job_id = $1 AND lease_owner = $2 AND lease_token = $3 AND lease_generation = $4 AND lease_expires_at > clock_timestamp() FOR UPDATE`,
          [job.job_id, job.lease_owner, job.lease_token, job.lease_generation],
        )
        if (!rowResult.rowCount) return null
        const row = rowResult.rows[0]!
        const retry = retryable && row.attempt_count < row.max_attempts
        const updated = await client.query<UploadJobRow>(
          `UPDATE sitepilot_excel_test.sitepilot_upload_jobs
           SET status = $3, error_code = $4,
               temp_path = temp_path,
               next_attempt_at = CASE WHEN $3 = 'queued' THEN clock_timestamp() + (LEAST(300000, 5000 * POWER(2, GREATEST(attempt_count - 1, 0)))::bigint * INTERVAL '1 millisecond') ELSE NULL END,
               lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL, updated_at = clock_timestamp(),
               completed_at = CASE WHEN $3 = 'failed' THEN clock_timestamp() ELSE NULL END
           WHERE job_id = $1 AND lease_owner = $2 AND lease_token = $5 AND lease_generation = $6 RETURNING *`,
          [
            job.job_id,
            job.lease_owner,
            retry ? 'queued' : 'failed',
            retry ? 'RETRYING' : errorCode,
            job.lease_token,
            job.lease_generation,
          ],
        )
        await this.insertEvent(client, updated.rows[0]!, retry ? 'retry' : 'terminal')
        return retry ? null : row.temp_path
      })
    } finally {
      client.release()
    }
  }
}
