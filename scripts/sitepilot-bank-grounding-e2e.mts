import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

import ExcelJS from 'exceljs'
import { parse } from 'dotenv'

const config = parse(await readFile('.env.docker'))
const apiUrl = `http://127.0.0.1:${config.SITEPILOT_API_PORT || process.env.SITEPILOT_API_PORT || '3210'}`
const secret = config.SITEPILOT_JWT_SECRET
if (!secret || secret.length < 32)
  throw new Error('Configured JWT secret is unavailable or invalid')

function bearerFor(identity: { tenantId: string; groupId: string; userId: string }) {
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
  const signature = createHmac('sha256', secret!).update(`${header}.${payload}`).digest('base64url')
  return `Bearer ${header}.${payload}.${signature}`
}

async function readSse(response: Response) {
  if (!response.ok || !response.body) throw new Error(`Agent SSE returned HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: Array<Record<string, unknown>> = []
  let pending = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    const frames = pending.split('\n\n')
    pending = frames.pop() ?? ''
    for (const frame of frames) {
      const data = frame
        .split('\n')
        .find((line) => line.startsWith('data: '))
        ?.slice(6)
      if (data) events.push(JSON.parse(data) as Record<string, unknown>)
    }
  }
  return events
}

async function main() {
  const unique = randomUUID().replaceAll('-', '')
  const identity = {
    tenantId: `bank_grounding_e2e_${unique}`,
    groupId: `bank_grounding_e2e_${unique}`,
    userId: `bank_grounding_e2e_${unique}`,
  }
  const authorization = bearerFor(identity)
  const fileName = `sitepilot-bank-grounding-synthetic-${unique}.xlsx`
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Synthetic Accounts')
  sheet.addRow(['Account Title', 'Account Type', 'Account Code', 'Notes'])
  sheet.addRow([
    'بنك - دولار أمريكي',
    'USD bank account',
    '1010',
    'Synthetic ledger category; no real financial institution is identified.',
  ])
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer())
  const arrayBuffer = new ArrayBuffer(bytes.length)
  new Uint8Array(arrayBuffer).set(bytes)
  const form = new FormData()
  form.append(
    'file',
    new Blob([arrayBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    fileName,
  )

  const healthResponse = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5_000) })
  if (!healthResponse.ok) throw new Error(`API health returned HTTP ${healthResponse.status}`)
  const health = (await healthResponse.json()) as { status: string; queued: number; active: number }
  if (health.status !== 'ok' || health.queued !== 0 || health.active !== 0)
    throw new Error('API unhealthy or queue busy; refusing to create the synthetic account fixture')

  const upload = await fetch(`${apiUrl}/api/documents/upload`, {
    method: 'POST',
    headers: { authorization },
    body: form,
    signal: AbortSignal.timeout(30_000),
  })
  if (upload.status !== 202)
    throw new Error(`Synthetic account upload returned HTTP ${upload.status}`)
  const job = (await upload.json()) as { jobId: string; status: string }
  if (!job.jobId || job.status !== 'queued')
    throw new Error('Synthetic account upload did not queue')

  const deadline = Date.now() + 5 * 60_000
  let status = 'queued'
  while (Date.now() < deadline && status !== 'completed' && status !== 'failed') {
    const response = await fetch(`${apiUrl}/api/jobs/${job.jobId}`, {
      headers: { authorization },
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`Authenticated job poll returned HTTP ${response.status}`)
    status = String(((await response.json()) as { status: string }).status)
    if (status !== 'completed' && status !== 'failed')
      await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  if (status !== 'completed') throw new Error(`Synthetic account ingestion ended with ${status}`)

  const retrievedResponse = await fetch(
    `${apiUrl}/api/documents/search?q=${encodeURIComponent('بنك دولار أمريكي حساب USD')}`,
    { headers: { authorization }, signal: AbortSignal.timeout(60_000) },
  )
  if (!retrievedResponse.ok)
    throw new Error(`Authenticated TypeGraph search returned HTTP ${retrievedResponse.status}`)
  const search = (await retrievedResponse.json()) as {
    results: Array<{ content: string; citation: Record<string, unknown> }>
  }
  const sourceEvidence = search.results.find(
    (result) =>
      result.content.includes('بنك - دولار أمريكي') &&
      result.citation.source === fileName &&
      result.citation.sheet === 'Synthetic Accounts' &&
      result.citation.rowStart === 2,
  )
  if (!sourceEvidence)
    throw new Error(
      'TypeGraph did not return the synthetic generic account label with its row citation',
    )

  const conversationResponse = await fetch(`${apiUrl}/api/agent/conversations`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ title: `Synthetic bank evidence ${unique.slice(0, 8)}` }),
  })
  if (conversationResponse.status !== 201)
    throw new Error(`Synthetic Agent conversation returned HTTP ${conversationResponse.status}`)
  const conversation = (await conversationResponse.json()) as { id: string }
  const response = await fetch(
    `${apiUrl}/api/agent/conversations/${conversation.id}/messages/stream`,
    {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: 'ما اسم البنك الفعلي الذي تملك فيه الشركة حسابًا بالدولار؟',
      }),
      signal: AbortSignal.timeout(30_000),
    },
  )
  const events = await readSse(response)
  const error = events.find((event) => event.type === 'error') as
    | { code?: string; message?: string }
    | undefined
  if (
    error?.code !== 'INSUFFICIENT_EVIDENCE' ||
    !error.message?.includes('available documents do not contain enough evidence') ||
    events.some((event) => event.type === 'complete' || event.type === 'delta')
  )
    throw new Error('Agent did not abstain from an unsupported named-entity claim')

  const historyResponse = await fetch(
    `${apiUrl}/api/agent/conversations/${conversation.id}/messages`,
    { headers: { authorization } },
  )
  if (!historyResponse.ok)
    throw new Error(`Conversation history returned HTTP ${historyResponse.status}`)
  const history = (await historyResponse.json()) as {
    messages: Array<{ role: string; status: string; content: string; citations: unknown[] }>
  }
  const assistant = history.messages.find((message) => message.role === 'assistant')
  if (
    !assistant ||
    assistant.status !== 'failed' ||
    assistant.citations.length !== 0 ||
    !assistant.content.includes('available documents do not contain enough evidence')
  )
    throw new Error('Abstention was not persisted without unsupported citations')

  console.log(
    JSON.stringify({
      passed: [
        'authenticated synthetic upload and ingestion',
        'TypeGraph returned the generic account label with its exact row citation',
        'general grounded-answer verifier abstained with INSUFFICIENT_EVIDENCE and no citations',
        'failed abstention persisted in conversation history',
      ],
      evidence: {
        source: fileName,
        sheet: 'Synthetic Accounts',
        row: 2,
        label: 'بنك - دولار أمريكي',
      },
      verification: 'general evidence checking; no bank-specific production rule',
      note: 'One synthetic upload and conversation are retained; no existing records or volumes were modified.',
    }),
  )
}

await main()
