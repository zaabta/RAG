import { createHash, randomUUID } from 'node:crypto'
import { Pool, type PoolClient, type QueryResultRow } from 'pg'

import type {
  ParsedExcelRecord,
  ParsedExcelWorkbook,
  SmartExcelChunk,
} from './sitepilot-excel-core.mjs'
import { SITEPILOT_EXCEL_SCHEMA } from './sitepilot-excel-config.mjs'
import { runSitePilotMigrations, SITEPILOT_MIGRATION_LOCK_KEY } from '../db/sitepilot-migrations.mjs'

const SCHEMA = SITEPILOT_EXCEL_SCHEMA
const PENDING_PAGE_SIZE = 200
const MAX_PENDING_PAGE_SIZE = 500

function boundedPageSize(value: number): number {
  if (!Number.isFinite(value)) return PENDING_PAGE_SIZE
  return Math.min(MAX_PENDING_PAGE_SIZE, Math.max(1, Math.trunc(value)))
}

function excelDateString(value: Date, includeTime = true): string {
  const pad = (part: number, width = 2) => String(part).padStart(width, '0')
  const date = `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  if (!includeTime) return date
  return `${date}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`
}

export interface ImportStageResult {
  runId: string
  inserted: number
  updated: number
  unchanged: number
  deleted: number
  chunks: number
  warnings: number
}

export interface PendingRecord extends QueryResultRow {
  record_id: string
  file_id: string
  file_name: string
  sheet_name: string
  record_key: string
  source_row_start: number
  source_row_end: number
  source_range: string
  form_no: string | null
  event_date: Date | null
  violation_main: string | null
  violation_sub: string | null
  normalized_fields: Record<string, unknown>
  document_content: string
  chunks: StoredSmartChunk[]
}

export interface StoredSmartChunk extends SmartExcelChunk {
  syncHash: string
}

export interface ExactRecordResult {
  recordId: string
  formNo: string
  sheetName: string
  sourceRowStart: number
  sourceRowEnd: number
  sourceRange: string
  eventDate: Date | null
  violationMain: string | null
  violationSub: string | null
  region: string | null
  location: string | null
}

export interface GroupCount {
  key: string
  count: number
}

export async function inTransaction<T>(
  client: Pick<PoolClient, 'query'>,
  operation: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [
      SITEPILOT_MIGRATION_LOCK_KEY,
    ])
    const result = await operation()
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

function field(record: ParsedExcelRecord, key: string): unknown {
  return record.normalizedFields[key]
}

function textField(record: ParsedExcelRecord, key: string): string | null {
  const value = field(record, key)
  if (value == null || value === '' || value === '[REDACTED]') return null
  return value instanceof Date ? excelDateString(value, false) : String(value)
}

function dateField(record: ParsedExcelRecord, key: string): string | null {
  const value = field(record, key)
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return excelDateString(value, false)
  return null
}

function numericField(record: ParsedExcelRecord, key: string): number | null {
  const value = field(record, key)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(?:[.,]\d+)?$/.test(value.trim())) {
    const parsed = Number(value.trim().replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, current: unknown) =>
    current instanceof Date ? excelDateString(current) : current,
  )
}

function makeChunkMetadata(
  record: ParsedExcelRecord,
  chunk: SmartExcelChunk,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {}
  for (const key of [
    'form_no',
    'olay_tarihi',
    'firma_alt_yuklenici',
    'ihlal_yapilan_bolge',
    'ihlal_yapilan_lokasyon',
    'ana_ihlal_turu',
    'alt_ihlal_turu',
    'uygulanan_cezai_islem',
  ]) {
    const value = record.normalizedFields[key]
    if (value != null && value !== '' && value !== '[REDACTED]') {
      safe[key] = value instanceof Date ? excelDateString(value, false) : value
    }
  }
  return {
    chunkId: chunk.chunkId,
    documentId: chunk.documentId,
    fileId: record.fileId,
    fileName: record.fileName,
    sheetName: chunk.sheetName,
    rowStart: chunk.rowStart,
    rowEnd: chunk.rowEnd,
    sourceRange: record.sourceRange,
    recordKey: chunk.recordKey,
    chunkType: chunk.chunkType,
    chunkIndex: chunk.chunkIndex,
    sourceCells: chunk.sourceCells,
    contentHash: chunk.contentHash,
    accessScope: chunk.accessScope,
    ...(chunk.narrativeField ? { narrativeField: chunk.narrativeField } : {}),
    safeFields: safe,
  }
}

export class SitePilotExcelStore {
  private readonly pool: Pool

  constructor(connectionString: string, maxConnections = 2) {
    this.pool = new Pool({
      connectionString,
      max: maxConnections,
      application_name: 'sitepilot-excel-import',
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async migrate(): Promise<void> {
    await runSitePilotMigrations(this.pool, SCHEMA)
  }

  async stageImport(
    workbook: ParsedExcelWorkbook,
    onProgress?: (processed: number, total: number) => Promise<void>,
  ): Promise<ImportStageResult> {
    const client = await this.pool.connect()
    const runId = randomUUID()
    let inserted = 0
    let updated = 0
    let unchanged = 0
    let deleted = 0
    let chunkCount = 0
    try {
      const result = await inTransaction(client, async () => {
        await client.query(
          `INSERT INTO ${SCHEMA}.excel_files (file_id, file_name, content_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (file_id) DO UPDATE SET file_name = EXCLUDED.file_name, content_hash = EXCLUDED.content_hash, updated_at = NOW()`,
          [workbook.fileId, workbook.fileName, workbook.contentHash],
        )
        await client.query(
          `INSERT INTO ${SCHEMA}.excel_import_runs (run_id, file_id, content_hash, status)
           VALUES ($1, $2, $3, 'syncing')`,
          [runId, workbook.fileId, workbook.contentHash],
        )

        for (const sheet of workbook.sheets) {
          await client.query(
            `INSERT INTO ${SCHEMA}.excel_sheets (file_id, sheet_name, row_count, column_count, header_row, last_seen_run)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (file_id, sheet_name) DO UPDATE SET row_count = EXCLUDED.row_count, column_count = EXCLUDED.column_count,
               header_row = EXCLUDED.header_row, last_seen_run = EXCLUDED.last_seen_run`,
            [
              workbook.fileId,
              sheet.name,
              sheet.rowCount,
              sheet.columnCount,
              sheet.headerRow,
              runId,
            ],
          )
          for (const record of sheet.records) {
            const previous = await client.query<{ record_hash: string }>(
              `SELECT record_hash FROM ${SCHEMA}.excel_records WHERE file_id = $1 AND sheet_name = $2 AND record_key = $3`,
              [record.fileId, record.sheetName, record.recordKey],
            )
            if (!previous.rowCount) inserted++
            else if (previous.rows[0]!.record_hash === record.recordHash) unchanged++
            else updated++

            await client.query(
              `INSERT INTO ${SCHEMA}.excel_records
               (record_id, file_id, sheet_name, record_key, source_row_start, source_row_end, source_range,
                form_no, event_date, company, region, location, violation_main, violation_sub,
                disciplinary_action, suspension_days, normalized_fields, original_headers, cell_states,
                record_hash, document_content, is_active, sync_status, last_seen_run)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20,$21,TRUE,'pending',$22)
               ON CONFLICT (file_id, sheet_name, record_key) DO UPDATE SET
                record_id = EXCLUDED.record_id, source_row_start = EXCLUDED.source_row_start, source_row_end = EXCLUDED.source_row_end,
                source_range = EXCLUDED.source_range, form_no = EXCLUDED.form_no, event_date = EXCLUDED.event_date,
                company = EXCLUDED.company, region = EXCLUDED.region, location = EXCLUDED.location,
                violation_main = EXCLUDED.violation_main, violation_sub = EXCLUDED.violation_sub,
                disciplinary_action = EXCLUDED.disciplinary_action, suspension_days = EXCLUDED.suspension_days,
                normalized_fields = EXCLUDED.normalized_fields, original_headers = EXCLUDED.original_headers,
                cell_states = EXCLUDED.cell_states, document_content = EXCLUDED.document_content,
                sync_status = CASE
                  WHEN NOT excel_records.is_active OR excel_records.sync_status IN ('delete_pending', 'deleted') THEN 'pending'
                  WHEN excel_records.record_hash IS DISTINCT FROM EXCLUDED.record_hash THEN 'pending'
                  ELSE excel_records.sync_status END,
                record_hash = EXCLUDED.record_hash, is_active = TRUE, last_seen_run = EXCLUDED.last_seen_run, updated_at = NOW()`,
              [
                record.recordId,
                record.fileId,
                record.sheetName,
                record.recordKey,
                record.rowStart,
                record.rowEnd,
                record.sourceRange,
                textField(record, 'form_no'),
                dateField(record, 'olay_tarihi'),
                textField(record, 'firma_alt_yuklenici'),
                textField(record, 'ihlal_yapilan_bolge'),
                textField(record, 'ihlal_yapilan_lokasyon'),
                textField(record, 'ana_ihlal_turu'),
                textField(record, 'alt_ihlal_turu'),
                textField(record, 'uygulanan_cezai_islem'),
                numericField(record, 'uygulanan_uzaklastirma_gun_sayisi'),
                safeJson(record.normalizedFields),
                safeJson(record.originalHeaders),
                safeJson(record.cellStates),
                record.recordHash,
                record.documentContent,
                runId,
              ],
            )

            const currentChunkIds = record.chunks.map((chunk) => chunk.chunkId)
            for (const chunk of record.chunks) {
              const metadata = makeChunkMetadata(record, chunk)
              const syncHash = createHash('sha256')
                .update(safeJson({ content: chunk.content, metadata }))
                .digest('hex')
              await client.query(
                `INSERT INTO ${SCHEMA}.excel_chunks
                 (chunk_id, document_id, file_id, sheet_name, record_key, row_start, row_end, source_cells,
                  chunk_type, chunk_index, narrative_field, content, content_hash, sync_hash, metadata, access_scope,
                  is_active, sync_status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,TRUE,'pending')
                 ON CONFLICT (chunk_id) DO UPDATE SET
                  document_id = EXCLUDED.document_id, row_start = EXCLUDED.row_start, row_end = EXCLUDED.row_end,
                  source_cells = EXCLUDED.source_cells, chunk_type = EXCLUDED.chunk_type, narrative_field = EXCLUDED.narrative_field,
                  content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
                  sync_status = CASE
                    WHEN NOT excel_chunks.is_active OR excel_chunks.sync_status IN ('delete_pending', 'deleted') THEN 'pending'
                    WHEN excel_chunks.sync_hash IS DISTINCT FROM EXCLUDED.sync_hash THEN 'pending'
                    ELSE excel_chunks.sync_status END,
                  sync_hash = EXCLUDED.sync_hash, metadata = EXCLUDED.metadata, access_scope = EXCLUDED.access_scope,
                  is_active = TRUE, updated_at = NOW()`,
                [
                  chunk.chunkId,
                  chunk.documentId,
                  record.fileId,
                  record.sheetName,
                  record.recordKey,
                  chunk.rowStart,
                  chunk.rowEnd,
                  safeJson(chunk.sourceCells),
                  chunk.chunkType,
                  chunk.chunkIndex,
                  chunk.narrativeField ?? null,
                  chunk.content,
                  chunk.contentHash,
                  syncHash,
                  safeJson(metadata),
                  chunk.accessScope,
                ],
              )
              chunkCount++
            }
            await client.query(
              `UPDATE ${SCHEMA}.excel_chunks SET is_active = FALSE, sync_status = 'delete_pending', updated_at = NOW()
               WHERE document_id = $1 AND is_active AND NOT (chunk_id = ANY($2::text[]))`,
              [record.recordId, currentChunkIds],
            )
            const processedRecords = inserted + updated + unchanged
            if (
              onProgress &&
              (processedRecords % 25 === 0 || processedRecords === workbook.totalRecords)
            ) {
              await onProgress(processedRecords, workbook.totalRecords)
            }
          }
        }

        const stale = await client.query<{ record_id: string }>(
          `UPDATE ${SCHEMA}.excel_records SET is_active = FALSE, sync_status = 'delete_pending', updated_at = NOW()
           WHERE file_id = $1 AND last_seen_run <> $2 AND is_active RETURNING record_id`,
          [workbook.fileId, runId],
        )
        deleted = stale.rowCount ?? 0
        if (stale.rows.length) {
          await client.query(
            `UPDATE ${SCHEMA}.excel_chunks SET is_active = FALSE, sync_status = 'delete_pending', updated_at = NOW()
             WHERE document_id = ANY($1::text[]) AND is_active`,
            [stale.rows.map((row) => row.record_id)],
          )
        }

        for (const warning of workbook.warnings) {
          await client.query(
            `INSERT INTO ${SCHEMA}.excel_import_warnings
             (run_id, file_id, sheet_name, row_number, cell_ref, warning_code, message)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              runId,
              workbook.fileId,
              warning.sheetName,
              warning.rowNumber ?? null,
              warning.cellRef ?? null,
              warning.code,
              warning.message,
            ],
          )
        }
        await client.query(
          `UPDATE ${SCHEMA}.excel_files SET latest_run_id = $2, sheet_count = $3, record_count = $4,
           chunk_count = $5, updated_at = NOW() WHERE file_id = $1`,
          [
            workbook.fileId,
            runId,
            workbook.sheets.length,
            workbook.totalRecords,
            workbook.totalChunks,
          ],
        )
        await client.query(
          `UPDATE ${SCHEMA}.excel_import_runs SET sheet_count = $2, record_count = $3, chunk_count = $4,
           warnings_count = $5, inserted_count = $6, updated_count = $7, deleted_count = $8, status = 'staged'
           WHERE run_id = $1`,
          [
            runId,
            workbook.sheets.length,
            workbook.totalRecords,
            chunkCount,
            workbook.warnings.length,
            inserted,
            updated,
            deleted,
          ],
        )
        return {
          runId,
          inserted,
          updated,
          unchanged,
          deleted,
          chunks: chunkCount,
          warnings: workbook.warnings.length,
        }
      })
      return result
    } catch (error) {
      // The transaction rolls back all structured changes; no raw source values enter error messages.
      throw error
    } finally {
      client.release()
    }
  }

  async pendingRecordCount(fileId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${SCHEMA}.excel_records
       WHERE file_id = $1 AND is_active AND sync_status = 'pending'`,
      [fileId],
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  async *pendingRecordBatches(
    fileId: string,
    pageSize = PENDING_PAGE_SIZE,
  ): AsyncGenerator<PendingRecord[], void, void> {
    const limit = boundedPageSize(pageSize)
    let cursor: { sheet_name: string; source_row_start: number; record_id: string } | undefined
    while (true) {
      const result = await this.pool.query<PendingRecord>(
        `SELECT r.record_id, r.file_id, f.file_name, r.sheet_name, r.record_key, r.source_row_start,
              r.source_row_end, r.source_range, r.form_no, r.event_date, r.violation_main, r.violation_sub,
              r.normalized_fields, r.document_content
       FROM ${SCHEMA}.excel_records r JOIN ${SCHEMA}.excel_files f USING (file_id)
       WHERE r.file_id = $1 AND r.is_active AND r.sync_status = 'pending'
         AND ($2::text IS NULL OR (r.sheet_name, r.source_row_start, r.record_id) > ($2, $3, $4))
       ORDER BY r.sheet_name, r.source_row_start, r.record_id LIMIT $5`,
        [
          fileId,
          cursor?.sheet_name ?? null,
          cursor?.source_row_start ?? null,
          cursor?.record_id ?? null,
          limit,
        ],
      )
      if (result.rows.length === 0) return
      const records = result.rows
      const recordIds = records.map((record) => record.record_id)
      const chunks = await this.pool.query(
        `SELECT chunk_id, document_id, sheet_name, row_start, row_end, record_key, chunk_type, chunk_index,
                source_cells, content_hash, access_scope, content, narrative_field, sync_hash
         FROM ${SCHEMA}.excel_chunks WHERE document_id = ANY($1::text[]) AND is_active
         ORDER BY document_id, chunk_index`,
        [recordIds],
      )
      const chunksByRecord = new Map<string, StoredSmartChunk[]>()
      for (const row of chunks.rows) {
        const recordChunks = chunksByRecord.get(row.document_id) ?? []
        recordChunks.push({
          chunkId: row.chunk_id,
          documentId: row.document_id,
          sheetName: row.sheet_name,
          rowStart: row.row_start,
          rowEnd: row.row_end,
          recordKey: row.record_key,
          chunkType: row.chunk_type,
          chunkIndex: row.chunk_index,
          sourceCells: row.source_cells,
          contentHash: row.content_hash,
          accessScope: row.access_scope,
          content: row.content,
          narrativeField: row.narrative_field ?? undefined,
          syncHash: row.sync_hash,
        })
        chunksByRecord.set(row.document_id, recordChunks)
      }
      for (const record of records) record.chunks = chunksByRecord.get(record.record_id) ?? []
      cursor = records.at(-1)
        ? {
            sheet_name: records.at(-1)!.sheet_name,
            source_row_start: records.at(-1)!.source_row_start,
            record_id: records.at(-1)!.record_id,
          }
        : undefined
      yield records
    }
  }

  async pendingDeletionCount(fileId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${SCHEMA}.excel_records
       WHERE file_id = $1 AND NOT is_active AND sync_status = 'delete_pending'`,
      [fileId],
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  async *pendingDeletionBatches(
    fileId: string,
    pageSize = 200,
  ): AsyncGenerator<string[], void, void> {
    const limit = boundedPageSize(pageSize)
    let cursor: string | undefined
    while (true) {
      const result = await this.pool.query<{ record_id: string }>(
        `SELECT record_id FROM ${SCHEMA}.excel_records
         WHERE file_id = $1 AND NOT is_active AND sync_status = 'delete_pending'
           AND ($2::text IS NULL OR record_id > $2)
         ORDER BY record_id LIMIT $3`,
        [fileId, cursor ?? null, limit],
      )
      if (result.rows.length === 0) return
      cursor = result.rows.at(-1)!.record_id
      yield result.rows.map((row) => row.record_id)
    }
  }

  async syncedRecordCount(fileId: string): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${SCHEMA}.excel_records
       WHERE file_id = $1 AND is_active AND sync_status = 'synced'`,
      [fileId],
    )
    return Number(result.rows[0]?.count ?? 0)
  }

  async markRecordSynced(recordId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await inTransaction(client, async () => {
        await client.query(
          `UPDATE ${SCHEMA}.excel_records SET sync_status = 'synced', updated_at = NOW() WHERE record_id = $1`,
          [recordId],
        )
        await client.query(
          `UPDATE ${SCHEMA}.excel_chunks SET sync_status = CASE WHEN is_active THEN 'synced' ELSE 'deleted' END, updated_at = NOW()
           WHERE document_id = $1`,
          [recordId],
        )
      })
    } finally {
      client.release()
    }
  }

  async markRecordDeleted(recordId: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await inTransaction(client, async () => {
        await client.query(
          `UPDATE ${SCHEMA}.excel_records SET sync_status = 'deleted', updated_at = NOW() WHERE record_id = $1`,
          [recordId],
        )
        await client.query(
          `UPDATE ${SCHEMA}.excel_chunks SET sync_status = 'deleted', updated_at = NOW() WHERE document_id = $1`,
          [recordId],
        )
      })
    } finally {
      client.release()
    }
  }

  async finishImport(
    runId: string,
    status: 'complete' | 'failed',
    failureCode?: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${SCHEMA}.excel_import_runs SET status = $2, failure_code = $3, finished_at = NOW() WHERE run_id = $1`,
      [runId, status, failureCode ?? null],
    )
  }

  async exactFormNo(fileId: string, formNo: string): Promise<ExactRecordResult[]> {
    const result = await this.pool.query(
      `SELECT record_id, form_no, sheet_name, source_row_start, source_row_end, source_range,
              event_date, violation_main, violation_sub, region, location
       FROM ${SCHEMA}.excel_records WHERE file_id = $1 AND form_no = $2 AND is_active
       ORDER BY sheet_name, source_row_start`,
      [fileId, formNo],
    )
    return result.rows.map((row) => ({
      recordId: row.record_id,
      formNo: row.form_no,
      sheetName: row.sheet_name,
      sourceRowStart: row.source_row_start,
      sourceRowEnd: row.source_row_end,
      sourceRange: row.source_range,
      eventDate: row.event_date,
      violationMain: row.violation_main,
      violationSub: row.violation_sub,
      region: row.region,
      location: row.location,
    }))
  }

  async topViolations(fileId: string, limit = 10): Promise<GroupCount[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
    const result = await this.pool.query(
      `SELECT violation_main AS key, COUNT(*)::int AS count FROM ${SCHEMA}.excel_records
       WHERE file_id = $1 AND sheet_name = $2 AND is_active AND violation_main IS NOT NULL
       GROUP BY violation_main ORDER BY count DESC, key ASC LIMIT $3`,
      [fileId, 'İHTAR TABLOSU_DTO', safeLimit],
    )
    return result.rows.map((row) => ({ key: row.key, count: row.count }))
  }

  async suspensionSummary(
    fileId: string,
  ): Promise<{ affectedRecords: number; byAction: GroupCount[] }> {
    const result = await this.pool.query(
      `SELECT disciplinary_action AS key, COUNT(*)::int AS count FROM ${SCHEMA}.excel_records
       WHERE file_id = $1 AND sheet_name = $2 AND is_active
         AND (COALESCE(suspension_days, 0) > 0 OR disciplinary_action ILIKE '%UZAKLAŞTIRMA%')
       GROUP BY disciplinary_action ORDER BY count DESC, key ASC`,
      [fileId, 'İHTAR TABLOSU_DTO'],
    )
    return {
      affectedRecords: result.rows.reduce((sum, row) => sum + row.count, 0),
      byAction: result.rows.map((row) => ({ key: row.key ?? 'Unspecified', count: row.count })),
    }
  }

  async countViolationRecords(fileId: string): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${SCHEMA}.excel_records WHERE file_id = $1 AND sheet_name = $2 AND is_active`,
      [fileId, 'İHTAR TABLOSU_DTO'],
    )
    return result.rows[0]?.count ?? 0
  }

  async countByRegion(fileId: string): Promise<GroupCount[]> {
    const result = await this.pool.query(
      `SELECT region AS key, COUNT(*)::int AS count FROM ${SCHEMA}.excel_records
       WHERE file_id = $1 AND sheet_name = $2 AND is_active AND region IS NOT NULL
       GROUP BY region ORDER BY count DESC, key ASC`,
      [fileId, 'İHTAR TABLOSU_DTO'],
    )
    return result.rows.map((row) => ({ key: row.key, count: row.count }))
  }

  async countForRegion(fileId: string, region: string): Promise<number> {
    const result = await this.pool.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${SCHEMA}.excel_records
       WHERE file_id = $1 AND sheet_name = $2 AND is_active AND region = $3`,
      [fileId, 'İHTAR TABLOSU_DTO', region],
    )
    return result.rows[0]?.count ?? 0
  }
}
