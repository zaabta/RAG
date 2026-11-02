import { parentPort, workerData } from 'node:worker_threads'
import { Pool } from 'pg'

const pool = new Pool({
  connectionString: workerData.databaseUrl,
  max: 1,
  application_name: 'sitepilot-upload-heartbeat',
})
let stopped = false
let renewing = false

async function renew() {
  if (stopped || renewing) return
  renewing = true
  try {
    const result = await pool.query(
      `UPDATE sitepilot_excel_test.sitepilot_upload_jobs
       SET lease_expires_at = clock_timestamp() + ($5::bigint * INTERVAL '1 millisecond'), updated_at = clock_timestamp()
       WHERE job_id = $1 AND lease_owner = $2 AND lease_token = $3 AND lease_generation = $4
         AND lease_expires_at > clock_timestamp() AND status NOT IN ('queued','completed','failed')`,
      [
        workerData.jobId,
        workerData.leaseOwner,
        workerData.leaseToken,
        workerData.leaseGeneration,
        workerData.leaseDurationMs,
      ],
    )
    if (result.rowCount !== 1) {
      parentPort?.postMessage({ type: 'lost' })
      stopped = true
      clearInterval(timer)
      await pool.end()
      return
    }
    parentPort?.postMessage({ type: 'renewed' })
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error ? String(error.code) : 'HEARTBEAT_ERROR'
    parentPort?.postMessage({ type: 'error', code })
  } finally {
    renewing = false
  }
}

const timer = setInterval(() => void renew(), workerData.heartbeatIntervalMs)
timer.unref()
void renew()
parentPort?.on('message', async (message) => {
  if (message?.type !== 'stop' || stopped) return
  stopped = true
  clearInterval(timer)
  await pool.end()
  parentPort?.postMessage({ type: 'stopped' })
})
