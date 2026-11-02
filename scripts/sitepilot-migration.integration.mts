import 'dotenv/config'
import process from 'node:process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Pool } from 'pg'

import { runSitePilotMigrations } from '../src/sitepilot/db/sitepilot-migrations.mjs'

const connectionString = process.env.DATABASE_URL
if (!connectionString) throw new Error('DATABASE_URL is required for migration integration tests')
const schema = `sp_mig_test_${randomUUID().replaceAll('-', '').slice(0, 20)}`
const legacySchema = `sp_legacy_test_${randomUUID().replaceAll('-', '').slice(0, 18)}`
const pool = new Pool({ connectionString, max: 4, application_name: 'sitepilot-migration-test' })
const tempDir = await mkdtemp(join(tmpdir(), 'sitepilot-migration-test-'))

try {
  // Concurrent callers represent API and worker startup. The advisory lock must serialize them.
  await Promise.all([runSitePilotMigrations(pool, schema), runSitePilotMigrations(pool, schema)])

  const history = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "${schema}".sitepilot_migration_history`,
  )
  if (Number(history.rows[0]!.count) !== 5) throw new Error('Migration history count mismatch')

  // A second run on populated schema must preserve a sentinel row.
  await pool.query(
    `INSERT INTO "${schema}".excel_files (file_id, file_name, content_hash)
     VALUES ($1, $2, $3)`,
    ['synthetic-file', 'synthetic.xlsx', 'synthetic-checksum'],
  )
  await runSitePilotMigrations(pool, schema)
  const preserved = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "${schema}".excel_files WHERE file_id = $1`,
    ['synthetic-file'],
  )
  if (Number(preserved.rows[0]!.count) !== 1)
    throw new Error('Existing schema data was not preserved')

  // Simulate an existing installation created by the previous Excel migration runner.
  await pool.query(`CREATE SCHEMA "${legacySchema}"`)
  const legacySql = await readFile(
    new URL('../migrations/001_sitepilot_excel.sql', import.meta.url),
    'utf8',
  )
  await pool.query(legacySql.replaceAll('sitepilot_excel_test', legacySchema))
  await pool.query(`CREATE TABLE "${legacySchema}".excel_schema_migrations (
    version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`)
  await pool.query(`INSERT INTO "${legacySchema}".excel_schema_migrations (version) VALUES ($1)`, [
    '001_sitepilot_excel',
  ])
  await pool.query(
    `INSERT INTO "${legacySchema}".excel_files (file_id, file_name, content_hash)
     VALUES ($1, $2, $3)`,
    ['legacy-synthetic-file', 'legacy-synthetic.xlsx', 'legacy-synthetic-checksum'],
  )
  await runSitePilotMigrations(pool, legacySchema)
  const legacyData = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM "${legacySchema}".excel_files WHERE file_id = $1`,
    ['legacy-synthetic-file'],
  )
  if (Number(legacyData.rows[0]!.count) !== 1)
    throw new Error('Legacy schema data was not preserved during migration adoption')

  // A changed historical source must be rejected before any SQL is executed.
  const changedPath = join(tempDir, 'changed.sql')
  await writeFile(changedPath, 'SELECT 1;\n', { mode: 0o600 })
  let checksumRejected = false
  try {
    await runSitePilotMigrations(pool, schema, [
      { version: '001_sitepilot_excel', url: pathToFileURL(changedPath) },
    ])
  } catch (error) {
    checksumRejected = error instanceof Error && error.message.includes('was edited')
  }
  if (!checksumRejected) throw new Error('Edited historical migration was not rejected')

  console.log(
    'Migration integration passed: empty schema, concurrent startup, populated and legacy schema preservation, checksum rejection.',
  )
} catch (error) {
  const code =
    typeof error === 'object' && error && 'code' in error ? String(error.code) : 'unknown'
  console.error(`Migration integration failed (${code})`)
  process.exitCode = 1
} finally {
  // This schema name is generated exclusively by this test; no existing schema is touched.
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined)
  await pool.query(`DROP SCHEMA IF EXISTS "${legacySchema}" CASCADE`).catch(() => undefined)
  await pool.end()
  await rm(tempDir, { recursive: true, force: true })
}
