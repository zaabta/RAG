import { createHmac, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import ExcelJS from 'exceljs'
import { parse } from 'dotenv'

const COMPOSE = ['compose', '--env-file', '.env.docker', '-f', 'compose.yaml']
const API_URL = `http://127.0.0.1:${process.env.SITEPILOT_API_PORT ?? '3210'}`

function compose(args: string[]): string {
  return execFileSync('docker', [...COMPOSE, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function token(
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

async function health(): Promise<boolean> {
  try {
    const response = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(3_000) })
    return response.ok
  } catch {
    return false
  }
}

async function waitForHealth(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await health()) return
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error('API did not become healthy in time')
}

async function uploadCount(): Promise<number> {
  const output = compose([
    'exec',
    '-T',
    'api',
    'node',
    '-e',
    'const fs=require("node:fs/promises"); async function count(p){let n=0;for(const e of await fs.readdir(p,{withFileTypes:true})){const q=require("node:path").join(p,e.name);n+=e.isDirectory()?await count(q):1;}return n;} count("/app/storage/uploads").then(files=>console.log(JSON.stringify({files}))).catch(()=>{console.log(JSON.stringify({files:-1}));process.exitCode=1;});',
  ])
  return Number((JSON.parse(output) as { files: number }).files)
}

async function readSse(response: Response): Promise<Array<Record<string, unknown>>> {
  if (!response.ok || !response.body) throw new Error('SSE connection failed')
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

const dockerEnv = parse(await readFile('.env.docker'))
const secret = dockerEnv.SITEPILOT_JWT_SECRET
if (!secret || secret.length < 32) throw new Error('Configured upload JWT secret is invalid')

const unique = randomUUID().replaceAll('-', '')
const identity = {
  tenantId: `docker_e2e_${unique}`,
  groupId: `docker_e2e_${unique}`,
  userId: `docker_e2e_${unique}`,
}
const bearer = token(secret, identity)
const marker = `sitepilot docker synthetic persistence marker ${unique}`
let workerStopped = false

try {
  await waitForHealth()
  const beforeHealth = (await (await fetch(`${API_URL}/health`)).json()) as {
    queued: number
    active: number
  }
  if (beforeHealth.queued !== 0 || beforeHealth.active !== 0)
    throw new Error('Queue is busy; refusing to stop the worker during unrelated work')

  const filesBefore = await uploadCount()
  compose(['stop', 'worker'])
  workerStopped = true

  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Synthetic Docker Test')
  sheet.addRow(['FORM NO', 'AÇIKLAMA'])
  sheet.addRow([1, marker])
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const form = new FormData()
  const arrayBuffer = new ArrayBuffer(bytes.length)
  new Uint8Array(arrayBuffer).set(bytes)
  form.append(
    'file',
    new Blob([arrayBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    `sitepilot-docker-synthetic-${unique}.xlsx`,
  )

  const uploadResponse = await fetch(`${API_URL}/api/documents/upload`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}` },
    body: form,
  })
  if (uploadResponse.status !== 202)
    throw new Error(`Upload was rejected (${uploadResponse.status})`)
  const created = (await uploadResponse.json()) as { jobId: string; status: string }
  if (!created.jobId || created.status !== 'queued')
    throw new Error('Upload did not create a queued job')

  const filesAfterUpload = await uploadCount()
  if (filesBefore >= 0 && filesAfterUpload !== filesBefore + 1)
    throw new Error('Uploaded file was not written to the shared named volume')

  compose(['restart', 'api'])
  await waitForHealth()
  const queuedResponse = await fetch(`${API_URL}/api/jobs/${created.jobId}`, {
    headers: { authorization: `Bearer ${bearer}` },
  })
  const queued = (await queuedResponse.json()) as { status: string }
  if (!queuedResponse.ok || queued.status !== 'queued')
    throw new Error('Queued job did not persist across API restart')
  const restoredOriginal = await fetch(`${API_URL}/api/documents/${created.jobId}/download`, {
    headers: { authorization: `Bearer ${bearer}` },
  })
  const restoredBytes = Buffer.from(await restoredOriginal.arrayBuffer())
  if (!restoredOriginal.ok || restoredBytes.length !== bytes.length)
    throw new Error('Uploaded original file was not accessible after API restart')

  const sseResponsePromise = fetch(`${API_URL}/api/jobs/${created.jobId}/events`, {
    headers: { authorization: `Bearer ${bearer}` },
  })
  const sseResponse = await sseResponsePromise
  const eventsPromise = readSse(sseResponse)
  compose(['start', 'worker'])
  workerStopped = false

  const deadline = Date.now() + 10 * 60_000
  let status = 'queued'
  while (Date.now() < deadline && status !== 'completed' && status !== 'failed') {
    const response = await fetch(`${API_URL}/api/jobs/${created.jobId}`, {
      headers: { authorization: `Bearer ${bearer}` },
    })
    if (!response.ok) throw new Error('Authenticated job polling failed')
    status = ((await response.json()) as { status: string }).status
    if (status !== 'completed' && status !== 'failed')
      await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  if (status !== 'completed') throw new Error(`Job did not complete (${status})`)

  const events = await eventsPromise
  const observed = events.map((event) => String(event.status))
  const orderedStages = [
    'queued',
    'parsing',
    'chunking',
    'structured_import',
    'embedding',
    'indexing',
    'completed',
  ]
  let previous = -1
  for (const stage of orderedStages) {
    const index = observed.indexOf(stage)
    if (index < 0 || index <= previous)
      throw new Error(`SSE stage missing or out of order: ${stage}`)
    previous = index
  }

  const search = async (saveHistory = false) => {
    const response = await fetch(
      `${API_URL}/api/documents/search?q=${encodeURIComponent(marker)}${saveHistory ? '&saveHistory=true' : ''}`,
      {
        headers: { authorization: `Bearer ${bearer}` },
      },
    )
    if (!response.ok) throw new Error('Authenticated search failed')
    return (await response.json()) as {
      results: Array<{ content: string; citation: { rowStart?: number; sheet?: string } }>
    }
  }
  const results = await search(true)
  if (
    !results.results.some((result) => result.content.includes(marker) && result.citation.rowStart)
  )
    throw new Error('Completed upload was not retrievable with a row citation')

  const libraryResponse = await fetch(`${API_URL}/api/documents`, { headers: { authorization: `Bearer ${bearer}` } })
  const library = (await libraryResponse.json()) as { documents: Array<{id:string;fileName:string;sizeBytes:number;downloadAvailable:boolean}> }
  const listed = library.documents.find(document=>document.id===created.jobId)
  if (!libraryResponse.ok || !listed || !listed.downloadAvailable || listed.sizeBytes!==bytes.length)
    throw new Error('Uploaded original was not present in the authenticated document library')
  const download = await fetch(`${API_URL}/api/documents/${created.jobId}/download`, { headers: { authorization: `Bearer ${bearer}` } })
  const downloaded = Buffer.from(await download.arrayBuffer())
  if (!download.ok || downloaded.length!==bytes.length || downloaded.readUInt32LE(0)!==0x04034b50 || !download.headers.get('content-disposition')?.includes('attachment'))
    throw new Error('Secure document download did not stream the uploaded XLSX original')
  const otherIdentity = { tenantId:`other_${unique}`, groupId:`other_${unique}`, userId:`other_${unique}` }
  const inaccessible = await fetch(`${API_URL}/api/documents/${created.jobId}/download`, { headers: { authorization:`Bearer ${token(secret,otherIdentity)}` } })
  if (inaccessible.status!==404) throw new Error('Cross-tenant document download was not denied')
  const historyResponse = await fetch(`${API_URL}/api/search/history`, { headers: { authorization: `Bearer ${bearer}` } })
  const history = (await historyResponse.json()) as {history:Array<{query:string}>}
  if (!historyResponse.ok || !history.history.some(entry=>entry.query===marker)) throw new Error('Explicit search history was not stored')

  compose(['restart', 'api', 'worker'])
  await waitForHealth()
  const persistentJobResponse = await fetch(`${API_URL}/api/jobs/${created.jobId}`, {
    headers: { authorization: `Bearer ${bearer}` },
  })
  const persistentJob = (await persistentJobResponse.json()) as { status: string }
  if (!persistentJobResponse.ok || persistentJob.status !== 'completed')
    throw new Error('Completed job metadata did not persist across API/worker restart')
  const persistentResults = await search()
  if (!persistentResults.results.some((result) => result.content.includes(marker)))
    throw new Error('Indexed document was not searchable after API/worker restart')
  const persistentLibraryResponse = await fetch(`${API_URL}/api/documents`, { headers: { authorization: `Bearer ${bearer}` } })
  const persistentLibrary = (await persistentLibraryResponse.json()) as {documents:Array<{id:string;downloadAvailable:boolean}>}
  if (!persistentLibrary.documents.some(document=>document.id===created.jobId&&document.downloadAvailable)) throw new Error('Document library metadata did not persist across restart')

  console.log(
    JSON.stringify({
      passed: [
        'authenticated upload and job creation',
        'queued job and original file persisted through API restart on the shared volume',
        'worker ingestion and ordered SSE progress',
        'local embedding and TypeGraph indexing',
        'search retrieval with row citation',
        'authorized document library and streamed original download',
        'cross-tenant download rejection and persisted explicit search history',
        'job and search persistence after API/worker restart',
      ],
      status: 'completed',
      eventCount: events.length,
      searchResultCount: results.results.length,
      workbook: 'synthetic, one-row fixture; contents not logged',
    }),
  )
} finally {
  if (workerStopped) compose(['start', 'worker'])
}
