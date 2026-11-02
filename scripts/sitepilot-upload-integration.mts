import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { Pool } from 'pg'

import 'dotenv/config'

import { startUploadService } from '../src/sitepilot/api/sitepilot-upload-server.mjs'
import { SitePilotUploadJobs, stableUploadFileId } from '../src/sitepilot/documents/sitepilot-upload-jobs.mjs'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
let currentStage = 'configuration'

function jwt(
  secret: string,
  identity: { tenantId: string; groupId: string; userId: string },
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const payload = encode({
    aud: 'sitepilot-upload',
    sub: identity.userId,
    tenant_id: identity.tenantId,
    sitepilot_group_id: identity.groupId,
    groups: [identity.groupId],
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  })
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

async function upload(
  baseUrl: string,
  bearer: string,
  name: string,
  bytes: Buffer,
): Promise<Response> {
  const form = new FormData()
  const backing = new ArrayBuffer(bytes.length)
  new Uint8Array(backing).set(bytes)
  form.append('file', new Blob([backing], { type: XLSX_MIME }), name)
  return fetch(`${baseUrl}/api/documents/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: form,
  })
}

async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  if (!response.ok || !response.body)
    throw new Error(`SSE request failed with status ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<Record<string, unknown>> = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      const data = block
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6)
      if (data) events.push(JSON.parse(data) as Record<string, unknown>)
    }
  }
  return events
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const workbookPath = resolve(
    process.argv.slice(2).find((argument) => argument !== '--') ??
      'test-data/İhtar Tablosu_Kontrol.xlsx',
  )
  const bytes = await readFile(workbookPath)
  const cpuStart = process.cpuUsage()
  let peakRssBytes = process.memoryUsage.rss()
  const resourceSampler = setInterval(() => {
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage.rss())
  }, 200)
  const secret = randomBytes(48).toString('base64url')
  const identity = {
    tenantId: `upload_it_${randomUUID().replaceAll('-', '')}`,
    groupId: 'sitepilot_upload_integration',
    userId: `integration_${randomUUID().replaceAll('-', '')}`,
  }
  const bearer = jwt(secret, identity)
  const unaffiliated = jwt(secret, { ...identity, tenantId: `${identity.tenantId}_other` })
  const otherGroup = jwt(secret, { ...identity, groupId: `${identity.groupId}_other` })
  currentStage = 'start-api-without-workers'
  let service = await startUploadService({
    databaseUrl,
    jwtSecret: secret,
    host: '127.0.0.1',
    port: 0,
    workerConcurrency: 0,
  })
  let jobId = ''
  try {
    currentStage = 'queue-fencing-and-retry'
    const queue = new SitePilotUploadJobs(databaseUrl)
    currentStage = 'queue-test-db-connection'
    const sql = new Pool({
      connectionString: databaseUrl,
      max: 1,
      application_name: 'sitepilot-upload-it',
    })
    const queueIdentity = {
      tenantId: `queue_it_${randomUUID().replaceAll('-', '')}`,
      groupId: 'queue_it_group',
      userId: `queue_it_user_${randomUUID().replaceAll('-', '')}`,
    }
    const storageRoot =
      process.env.SITEPILOT_UPLOAD_STORAGE_DIR ??
      join(process.cwd(), 'var/sitepilot-upload-storage')
    const fencingHash = createHash('sha256').update(randomUUID()).digest('hex')
    currentStage = 'queue-test-enqueue'
    const queueJob = await queue.enqueue({
      identity: queueIdentity,
      originalName: 'fencing-test.xlsx',
      tempPath: join(storageRoot, 'queue-test', `${randomUUID()}.xlsx`),
      fileSha256: fencingHash,
    })
    const competingClaims = await Promise.all([
      queue.claimNext('worker-one', 1_000, queueIdentity.tenantId),
      queue.claimNext('worker-two', 1_000, queueIdentity.tenantId),
    ])
    currentStage = 'queue-concurrent-claims'
    const firstOwner = competingClaims.find((claim) => claim !== null)
    if (!firstOwner || competingClaims.filter(Boolean).length !== 1)
      throw new Error('Concurrent workers did not claim exactly one job')
    if (!(await queue.renewLease(firstOwner, 1_000)))
      throw new Error('Current lease owner could not renew')
    currentStage = 'queue-lease-takeover'
    await sql.query(
      `UPDATE sitepilot_excel_test.sitepilot_upload_jobs SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE job_id = $1`,
      [queueJob.job.jobId],
    )
    const newOwner = await queue.claimNext('worker-two', 5_000, queueIdentity.tenantId)
    if (
      !newOwner ||
      newOwner.lease_token === firstOwner.lease_token ||
      newOwner.lease_generation <= firstOwner.lease_generation
    )
      throw new Error('Expired lease was not taken over with a new fencing generation')
    currentStage = 'queue-stale-worker-fencing'
    let staleProgressRejected = false
    try {
      await queue.updateProgress(firstOwner, 'indexing', 1, 1)
    } catch {
      staleProgressRejected = true
    }
    if (!staleProgressRejected || (await queue.complete(firstOwner, {})) !== null)
      throw new Error('Stale worker mutated or published after lease takeover')
    if (!(await queue.complete(newOwner, { fileId: 'fencing-test' })))
      throw new Error('Current lease owner could not publish completion')
    currentStage = 'queue-publication-filter'
    const published = await queue.visibleUploadFileIds(queueIdentity, [
      stableUploadFileId(queueIdentity.tenantId, queueIdentity.groupId, fencingHash),
    ])
    if (published.active.size !== 1)
      throw new Error('Completed upload version was not published atomically')

    const retryJob = await queue.enqueue({
      identity: queueIdentity,
      originalName: 'retry-test.xlsx',
      tempPath: join(storageRoot, 'queue-test', `${randomUUID()}.xlsx`),
      fileSha256: createHash('sha256').update(randomUUID()).digest('hex'),
    })
    currentStage = 'queue-retry-exhaustion'
    for (let attempt = 1; attempt <= 3; attempt++) {
      currentStage = `retry-attempt-${attempt}-claim`
      await sql.query(
        `UPDATE sitepilot_excel_test.sitepilot_upload_jobs SET next_attempt_at = clock_timestamp() WHERE job_id = $1`,
        [retryJob.job.jobId],
      )
      const owner = await queue.claimNext(`retry-worker-${attempt}`, 5_000, queueIdentity.tenantId)
      if (!owner || owner.job_id !== retryJob.job.jobId)
        throw new Error('Retry job was not claimable')
      const cleanupPath = await queue.failOrRetry(owner, 'PROCESSING_FAILED', true)
      currentStage = `retry-attempt-${attempt}-result`
      if (attempt < 3 && cleanupPath !== null)
        throw new Error('Retry exhaustion happened too early')
      if (attempt === 3 && cleanupPath === null)
        throw new Error('Retry limit did not reach terminal failure')
    }
    const exhausted = await queue.getOwned(retryJob.job.jobId, queueIdentity)
    currentStage = 'retry-exhaustion-state'
    if (exhausted?.status !== 'failed' || exhausted.attempt !== 3)
      throw new Error('Retry exhaustion state was not persisted')
    const failedVersion = await queue.visibleUploadFileIds(queueIdentity, [
      stableUploadFileId(
        queueIdentity.tenantId,
        queueIdentity.groupId,
        (
          await sql.query<{ file_sha256: string }>(
            `SELECT file_sha256 FROM sitepilot_excel_test.sitepilot_upload_jobs WHERE job_id = $1`,
            [retryJob.job.jobId],
          )
        ).rows[0]!.file_sha256,
      ),
    ])
    currentStage = 'retry-publication-filter'
    if (failedVersion.active.size !== 0) throw new Error('Failed upload version became visible')
    await Promise.all([queue.close(), sql.end()])

    const url = `http://127.0.0.1:${service.port}`
    const health = await fetch(`${url}/health`)
    const healthBody = (await health.json()) as { status: string; workers: number }
    if (!health.ok || healthBody.status !== 'ok' || healthBody.workers !== 0)
      throw new Error('Queue health metrics endpoint did not report service state')
    currentStage = 'concurrent-upload'
    const [first, concurrent] = await Promise.all([
      upload(url, bearer, basename(workbookPath), bytes),
      upload(url, bearer, basename(workbookPath), bytes),
    ])
    if (![200, 202].includes(first.status) || ![200, 202].includes(concurrent.status)) {
      throw new Error('Concurrent upload requests were not accepted')
    }
    const firstBody = (await first.json()) as { jobId: string; status: string; duplicate: boolean }
    const secondBody = (await concurrent.json()) as {
      jobId: string
      status: string
      duplicate: boolean
    }
    if (!firstBody.jobId || firstBody.jobId !== secondBody.jobId)
      throw new Error('Concurrent identical uploads did not deduplicate')
    jobId = firstBody.jobId

    currentStage = 'invalid-upload'
    const invalid = await upload(url, bearer, 'invalid.xlsx', Buffer.from('not an xlsx archive'))
    if (invalid.status !== 400) throw new Error('Invalid workbook upload was not rejected')
    currentStage = 'tenant-isolation'
    const forbidden = await fetch(`${url}/api/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${unaffiliated}` },
    })
    if (forbidden.status !== 404) throw new Error('Cross-tenant job access was not hidden')
    const forbiddenStream = await fetch(`${url}/api/jobs/${jobId}/events`, {
      headers: { authorization: `Bearer ${otherGroup}` },
    })
    if (forbiddenStream.status !== 404)
      throw new Error('Cross-group event stream access was not hidden')

    currentStage = 'queued-persistence'
    const queued = await fetch(`${url}/api/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${bearer}` },
    })
    const queuedJob = (await queued.json()) as { status: string }
    if (queuedJob.status !== 'queued')
      throw new Error('Job was not persisted as queued before worker restart')
    await service.close()

    currentStage = 'restart-api-and-worker'
    service = await startUploadService({
      databaseUrl,
      jwtSecret: secret,
      host: '127.0.0.1',
      port: 0,
      workerConcurrency: 1,
      testHooks: { failAfterProgressStage: 'indexing', failOnAttempt: 1 },
    })
    const restartedUrl = `http://127.0.0.1:${service.port}`
    currentStage = 'sse-and-poll'
    const ssePromise = fetch(`${restartedUrl}/api/jobs/${jobId}/events`, {
      headers: { authorization: `Bearer ${bearer}` },
    }).then(readSse)
    let finalJob:
      | {
          status: string
          attempt: number
          progress: { processed: number; total: number | null; percent: number | null }
          errorCode?: string
        }
      | undefined
    let stagedVersionHidden = false
    const deadline = Date.now() + 15 * 60_000
    while (Date.now() < deadline) {
      const response = await fetch(`${restartedUrl}/api/jobs/${jobId}`, {
        headers: { authorization: `Bearer ${bearer}` },
      })
      if (!response.ok) throw new Error('Authorized job polling failed')
      finalJob = (await response.json()) as typeof finalJob
      if (finalJob?.status === 'queued' && finalJob.attempt === 1 && !stagedVersionHidden) {
        currentStage = 'staged-version-visibility'
        const stagedSearch = await fetch(
          `${restartedUrl}/api/documents/search?q=${encodeURIComponent('KKD ihlali')}`,
          { headers: { authorization: `Bearer ${bearer}` } },
        )
        if (!stagedSearch.ok) throw new Error('Search failed while a version awaited publication')
        const stagedResult = (await stagedSearch.json()) as { results: unknown[] }
        if (stagedResult.results.length !== 0)
          throw new Error('Unpublished version became visible before job completion')
        stagedVersionHidden = true
        currentStage = 'sse-and-poll'
      }
      if (finalJob?.status === 'completed' || finalJob?.status === 'failed') break
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500))
    }
    if (finalJob?.status !== 'completed')
      throw new Error(
        `Upload worker ended without completion (${finalJob?.errorCode ?? 'timeout'})`,
      )
    if (finalJob.attempt !== 2 || !stagedVersionHidden)
      throw new Error('Injected indexing failure did not recover with the staged version hidden')
    const events = await ssePromise
    currentStage = 'sse-progress-coalescing'
    const observed = events.map((event) => String(event.status))
    if (events.length >= 909)
      throw new Error('SSE progress events exceeded the previous 909-event baseline')
    const requiredOrder = [
      'queued',
      'parsing',
      'chunking',
      'structured_import',
      'embedding',
      'indexing',
      'completed',
    ]
    let previous = -1
    for (const status of requiredOrder) {
      const index = observed.indexOf(status)
      if (index < 0 || index <= previous) throw new Error(`SSE omitted or reordered ${status}`)
      previous = index
    }
    currentStage = 'sse-progress-values'
    for (const event of events) {
      const progress = event.progress as {
        processed: number
        total: number | null
        percent: number | null
      }
      if (progress.total === null && progress.percent !== null)
        throw new Error('Unknown progress total was assigned a percentage')
      if (progress.percent !== null && (progress.percent < 0 || progress.percent > 100))
        throw new Error('Progress percentage was outside its measured range')
    }
    for (const attempt of [...new Set(events.map((event) => Number(event.attempt)))]) {
      for (const stage of requiredOrder) {
        let prior = -1
        for (const event of events.filter(
          (item) => Number(item.attempt) === attempt && item.status === stage,
        )) {
          const progress = event.progress as { processed: number }
          if (progress.processed < prior)
            throw new Error('Progress moved backwards within one attempt')
          prior = progress.processed
        }
      }
    }
    currentStage = 'sse-reconnect'
    const lastEventId = String(events.at(-1)?.id ?? '')
    if (!/^\d+$/.test(lastEventId)) throw new Error('SSE event IDs were missing')
    const reconnect = await fetch(`${restartedUrl}/api/jobs/${jobId}/events`, {
      headers: { authorization: `Bearer ${bearer}`, 'last-event-id': lastEventId },
    })
    const resumedEvents = await readSse(reconnect)
    if (resumedEvents.at(-1)?.status !== 'completed')
      throw new Error('SSE reconnect did not return a terminal snapshot')

    currentStage = 'duplicate-upload'
    const duplicate = await upload(restartedUrl, bearer, basename(workbookPath), bytes)
    const duplicateBody = (await duplicate.json()) as { jobId: string; duplicate: boolean }
    if (duplicate.status !== 200 || !duplicateBody.duplicate || duplicateBody.jobId !== jobId) {
      throw new Error('Completed duplicate upload did not return its existing job')
    }
    currentStage = 'post-import-search'
    const search = await fetch(
      `${restartedUrl}/api/documents/search?q=${encodeURIComponent('KKD ihlali')}`,
      {
        headers: { authorization: `Bearer ${bearer}` },
      },
    )
    if (!search.ok) throw new Error('Post-completion TypeGraph search failed')
    const searchResult = (await search.json()) as {
      results: Array<{ content: string; citation: { sheet?: string; rowStart?: number } }>
    }
    if (
      !searchResult.results.some(
        (result) => result.content.includes('KKD') && typeof result.citation.rowStart === 'number',
      )
    ) {
      throw new Error('Post-completion search returned no relevant cited record')
    }

    const cpuUsage = process.cpuUsage(cpuStart)
    console.log('SitePilot upload integration passed:', {
      checks: [
        'concurrent workers claim once',
        'lease heartbeat and expiry takeover',
        'stale worker fencing',
        'retry exhaustion',
        'concurrent duplicate upload',
        'invalid archive rejection',
        'tenant isolation',
        'restart recovery',
        'failure after vector indexing before atomic publication',
        'unpublished version hidden from search',
        'ordered SSE',
        'SSE terminal reconnect',
        'safe unknown progress',
        'completed duplicate',
        'retrieval with citation',
      ],
      stages: requiredOrder,
      progressEvents: events.length,
      progressEventLimit: 909,
      terminalStatus: finalJob.status,
      retrievalResults: searchResult.results.length,
      peakRssMiB: Math.round((peakRssBytes / 1024 / 1024) * 10) / 10,
      cpuSeconds: Math.round(((cpuUsage.user + cpuUsage.system) / 1_000_000) * 100) / 100,
      rawWorkbookValuesLogged: false,
    })
  } finally {
    clearInterval(resourceSampler)
    await service.close()
  }
}

main().catch((error: unknown) => {
  const databaseCode =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined
  console.error(
    `SitePilot upload integration failed at ${currentStage} (${error instanceof Error ? error.name : 'UnknownError'}${databaseCode ? `, code ${databaseCode}` : ''}).`,
  )
  process.exitCode = 1
})
