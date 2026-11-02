import process from 'node:process'
import { spawn } from 'node:child_process'

import { Client } from 'pg'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error('SitePilot container requires DATABASE_URL.')
  process.exit(1)
}

const retryableCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
])

while (true) {
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5_000,
    application_name: 'sitepilot-container-readiness',
  })
  try {
    await client.connect()
    await client.query('SELECT 1')
    await client.end()
    break
  } catch (error) {
    await client.end().catch(() => undefined)
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (!retryableCodes.has(code)) {
      console.error(`SitePilot PostgreSQL configuration failed (${code || 'unknown'}).`)
      process.exit(1)
    }
    console.log('Waiting for PostgreSQL on the configured Docker network.')
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
}

const child = spawn(
  process.execPath,
  ['/app/node_modules/tsx/dist/cli.mjs', 'src/sitepilot/api/sitepilot-upload-server.mts'],
  { env: process.env, stdio: 'inherit' },
)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.once('error', () => {
  console.error('SitePilot application process could not be started.')
  process.exitCode = 1
})
child.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
