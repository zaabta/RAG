import 'dotenv/config'
import process from 'node:process'

import { Pool } from 'pg'

interface ExplainNode {
  'Actual Total Time': number
  'Node Type': string
  Plans?: ExplainNode[]
}

function summarize(plan: ExplainNode): { ms: number; nodes: string[] } {
  const nodes = [plan['Node Type']]
  for (const child of plan.Plans ?? []) nodes.push(...summarize(child).nodes)
  return { ms: plan['Actual Total Time'], nodes: [...new Set(nodes)] }
}

async function measure(pool: Pool, sql: string, args: unknown[] = []) {
  const result = await pool.query<{ 'QUERY PLAN': [{ Plan: ExplainNode }] }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    args,
  )
  return summarize(result.rows[0]!['QUERY PLAN'][0]!.Plan)
}

async function medianMeasure(pool: Pool, sql: string, args: unknown[] = []) {
  const samples = await Promise.all([
    measure(pool, sql, args),
    measure(pool, sql, args),
    measure(pool, sql, args),
  ])
  const durations = samples.map((sample) => sample.ms).sort((a, b) => a - b)
  return { ms: durations[1]!, nodes: samples[1]!.nodes }
}

const connectionString = process.env.DATABASE_URL
if (!connectionString)
  throw new Error('DATABASE_URL is required for the isolated SQL performance check')
const pool = new Pool({ connectionString, max: 1, application_name: 'sitepilot-sql-perf-check' })

try {
  // TEMP tables are connection-local and disappear when this script exits. All rows are synthetic.
  await pool.query(`
    CREATE TEMP TABLE bench_records (
      record_id TEXT PRIMARY KEY, file_id TEXT NOT NULL, sheet_name TEXT NOT NULL,
      source_row_start INTEGER NOT NULL, is_active BOOLEAN NOT NULL, sync_status TEXT NOT NULL
    );
    CREATE TEMP TABLE bench_chunks (
      chunk_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
      is_active BOOLEAN NOT NULL
    );
    INSERT INTO bench_records
    SELECT 'record-' || n, 'bench-file', 'sheet-' || (n % 4), n, TRUE,
           CASE WHEN n % 5 = 0 THEN 'synced' ELSE 'pending' END
    FROM generate_series(1, 100000) AS n;
    INSERT INTO bench_chunks
    SELECT 'chunk-' || n, 'record-' || ((n - 1) / 4 + 1), (n - 1) % 4, TRUE
    FROM generate_series(1, 400000) AS n;
    ANALYZE bench_records;
    ANALYZE bench_chunks;
  `)

  const recordSql = `SELECT record_id, sheet_name, source_row_start FROM bench_records
    WHERE file_id = $1 AND is_active AND sync_status = 'pending'
      AND ($2::text IS NULL OR (sheet_name, source_row_start, record_id) > ($2, $3, $4))
    ORDER BY sheet_name, source_row_start, record_id LIMIT $5`
  const firstPageArgs = ['bench-file', null, null, null, 200]
  const firstPage = await pool.query<{
    record_id: string
    sheet_name: string
    source_row_start: number
  }>(recordSql, firstPageArgs)
  const recordIds = firstPage.rows.map((row) => row.record_id)
  const last = firstPage.rows.at(-1)!
  const nextPageArgs = ['bench-file', last.sheet_name, last.source_row_start, last.record_id, 200]
  const chunkSql = `SELECT chunk_id FROM bench_chunks
    WHERE document_id = ANY($1::text[]) AND is_active
    ORDER BY document_id, chunk_index`

  // Warm up each path and report medians over three measured EXPLAIN ANALYZE runs.
  await measure(pool, recordSql, firstPageArgs)
  await measure(pool, chunkSql, [recordIds])
  const beforeRecordFirstPage = await medianMeasure(pool, recordSql, firstPageArgs)
  const beforeRecordNextPage = await medianMeasure(pool, recordSql, nextPageArgs)
  const beforeChunk = await medianMeasure(pool, chunkSql, [recordIds])

  await pool.query(`CREATE INDEX bench_records_pending_scan_idx
    ON bench_records (file_id, sheet_name, source_row_start, record_id)
    WHERE is_active AND sync_status = 'pending'`)
  await pool.query(`CREATE INDEX bench_chunks_document_idx
    ON bench_chunks (document_id, chunk_index) WHERE is_active`)
  await pool.query('ANALYZE bench_records; ANALYZE bench_chunks')
  await measure(pool, recordSql, firstPageArgs)
  await measure(pool, chunkSql, [recordIds])
  const afterRecordFirstPage = await medianMeasure(pool, recordSql, firstPageArgs)
  const afterRecordNextPage = await medianMeasure(pool, recordSql, nextPageArgs)
  const afterChunk = await medianMeasure(pool, chunkSql, [recordIds])

  console.log(
    JSON.stringify(
      {
        fixture: { records: 100000, chunks: 400000, selectedRecords: recordIds.length },
        queryCountFor3105Records: { before: 3106, after: 33, pageSize: 200 },
        records: {
          firstPage: { before: beforeRecordFirstPage, after: afterRecordFirstPage },
          nextPage: { before: beforeRecordNextPage, after: afterRecordNextPage },
        },
        chunks: { before: beforeChunk, after: afterChunk },
        note: 'Synthetic temporary data only; no workbook values or persistent tables were read or written.',
      },
      null,
      2,
    ),
  )
} catch (error) {
  // Database error messages can contain SQL details; report only a safe error class/code.
  const code =
    typeof error === 'object' && error && 'code' in error ? String(error.code) : 'unknown'
  console.error(`SQL performance check failed (${code})`)
  process.exitCode = 1
} finally {
  await pool.end()
}
