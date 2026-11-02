import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'

export const SITEPILOT_MIGRATION_LOCK_KEY = 867530901

export interface SqlMigration {
  version: string
  url: URL
}

const MIGRATIONS: SqlMigration[] = [
  {
    version: '001_sitepilot_excel',
    url: new URL('../../../migrations/001_sitepilot_excel.sql', import.meta.url),
  },
  {
    version: '003_sitepilot_upload_jobs',
    url: new URL('../../../migrations/003_sitepilot_upload_jobs.sql', import.meta.url),
  },
  {
    version: '004_sitepilot_upload_hardening',
    url: new URL('../../../migrations/004_sitepilot_upload_hardening.sql', import.meta.url),
  },
  {
    version: '005_sitepilot_pending_scan_indexes',
    url: new URL('../../../migrations/005_sitepilot_pending_scan_indexes.sql', import.meta.url),
  },
  {
    version: '006_sitepilot_workspace',
    url: new URL('../../../migrations/006_sitepilot_workspace.sql', import.meta.url),
  },
]

function quoteSchema(schema: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error('Invalid SitePilot migration schema identifier')
  }
  return `"${schema}"`
}

async function transaction(client: PoolClient, operation: () => Promise<void>): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [
      SITEPILOT_MIGRATION_LOCK_KEY,
    ])
    await operation()
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  }
}

export async function runSitePilotMigrations(
  pool: Pool,
  schema: string,
  migrations: readonly SqlMigration[] = MIGRATIONS,
): Promise<void> {
  const quotedSchema = quoteSchema(schema)
  const client = await pool.connect()
  try {
    // Session lock serializes API/worker startup migrations. App transactions take the
    // corresponding shared lock, so DDL waits for active SQL transactions to finish.
    await client.query('SELECT pg_advisory_lock($1::bigint)', [SITEPILOT_MIGRATION_LOCK_KEY])
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`)
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${quotedSchema}.sitepilot_migration_history (
        version TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    for (const migration of migrations) {
      const source = await readFile(migration.url, 'utf8')
      const checksum = createHash('sha256').update(source).digest('hex')
      const applied = await client.query<{ checksum: string }>(
        `SELECT checksum FROM ${quotedSchema}.sitepilot_migration_history WHERE version = $1`,
        [migration.version],
      )
      if (applied.rowCount) {
        if (applied.rows[0]!.checksum !== checksum) {
          throw new Error(
            `Applied migration ${migration.version} was edited; add a new migration instead`,
          )
        }
        continue
      }

      // Execute each complete SQL file in PostgreSQL. Splitting on semicolons breaks
      // valid SQL bodies and quoted strings; pg's simple-query protocol accepts files.
      const sql = source.replaceAll('sitepilot_excel_test', schema)
      await transaction(client, async () => {
        await client.query(sql)
        await client.query(
          `INSERT INTO ${quotedSchema}.sitepilot_migration_history (version, checksum) VALUES ($1, $2)`,
          [migration.version, checksum],
        )
      })
    }
  } finally {
    await client
      .query('SELECT pg_advisory_unlock($1::bigint)', [SITEPILOT_MIGRATION_LOCK_KEY])
      .catch(() => undefined)
    client.release()
  }
}
