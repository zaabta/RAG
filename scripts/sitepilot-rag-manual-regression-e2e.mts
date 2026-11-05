import { createHmac, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

import { parse } from 'dotenv'

const COMPOSE = ['compose', '--env-file', '.env.docker', '-f', 'compose.yaml']
const env = parse(await readFile('.env.docker'))
const apiUrl = `http://127.0.0.1:${env.SITEPILOT_API_PORT || '3210'}`
const secret = env.SITEPILOT_JWT_SECRET
if (!secret || secret.length < 32) throw new Error('Configured JWT secret is unavailable')

function compose(args: string[]) {
  return execFileSync('docker', [...COMPOSE, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function makeToken(identity: { tenantId: string; groupId: string; userId: string }) {
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
  return `${header}.${payload}.${signature}`
}

async function streamEvents(response: Response) {
  if (!response.ok || !response.body) throw new Error(`SSE returned HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const events: Array<Record<string, any>> = []
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })
    const frames = buffer.split(/\r?\n\r?\n/u)
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/u)
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim()
      if (data) events.push(JSON.parse(data) as Record<string, any>)
    }
    if (done) break
  }
  if (buffer.trim()) {
    const data = buffer
      .split(/\r?\n/u)
      .find((line) => line.startsWith('data:'))
      ?.slice(5)
      .trim()
    if (data) events.push(JSON.parse(data) as Record<string, any>)
  }
  return events
}

async function main() {
  const unique = randomUUID().replaceAll('-', '')
  const tenantId = `rag_manual_${unique}`
  const identity = { tenantId, groupId: tenantId, userId: tenantId }
  const bearer = makeToken(identity)
  const files = [
    {
      fileName: '02-data-upload-and-requirements.md',
      content: `# Required accounting information\n\n## Initial financial analysis\n\nVCFO AI needs the chart of accounts, a trial balance for the requested period, income statement, balance sheet, cash-flow statement when available, the financial period, currency, and company or branch context. Source reports should include opening and closing balances and be reconciled to the trial balance.\n\n## Ordered processing stages\n\n1. Upload source files and record the reporting period.\n2. Validate file structure, required fields, and totals.\n3. Extract and normalize account and transaction values.\n4. Map source accounts to the approved chart of accounts.\n5. Reconcile balances and identify missing or inconsistent values.\n6. Calculate financial indicators for the selected period.\n7. Prepare the analysis and cite the source data.\n`,
    },
    {
      fileName: '07-pricing-plans-and-commercial.md',
      content: `# Pricing and commercial terms\n\n## Official quotes\n\nThe current monthly Enterprise price in US dollars is not confirmed in this document. A customer should request a current written quote from the VCFO AI sales team. Do not invent a price, infer a monthly amount from another plan, or treat an estimate as an approved price.\n\n## Plan information\n\nThe customer can learn which plans and included services are currently available by contacting sales and requesting the current commercial schedule. This document does not publish a confirmed Enterprise amount.\n`,
    },
    {
      fileName: '08-sales-and-integrations.md',
      content: `# Sales, custom integrations, and service commitments\n\n## Custom development\n\nA request for an Enterprise quote with a custom integration must be reviewed by the technical and sales teams. The assistant may explain that the customer should submit the integration requirements for review. It must not promise that development will be delivered, quote a custom development price, or confirm a delivery date without an approved written proposal.\n\n## Service level agreements\n\nSLA availability and terms require an official written agreement. The assistant must not claim that an SLA is included or confirm response times unless an approved source states the terms.\n`,
    },
    {
      fileName: '06-security-and-privacy.md',
      content: `# Security and privacy\n\n## Customer information and model training\n\nThe available security documentation describes customer data access controls but does not state whether customer data is used to train artificial intelligence models. The policy does not confirm either that customer data is used for model training or that it is never used. An answer must say that this point is not confirmed by the available documentation and must not claim yes or no.\n\n## Access controls\n\nAccess to customer financial data is limited by tenant, company, group, and assigned role. Users should only access information authorized for their organization and role.\n`,
    },
    {
      fileName: '05-companies-and-branches.md',
      content: `# Managing companies and branches\n\n## Organization structure\n\nAn authorized workspace can manage multiple companies and their branches. Company and branch identifiers scope financial records and reports. Users receive roles and group permissions that limit which companies, branches, and records they can access. Reports can be prepared for an authorized company or branch without granting access to another company.\n`,
    },
  ]

  const health = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(5_000) })
  if (!health.ok) throw new Error(`API health returned HTTP ${health.status}`)
  const service = (await health.json()) as { status?: string; active?: number; queued?: number }
  if (service.status !== 'ok' || service.active !== 0 || service.queued !== 0)
    throw new Error('API is unhealthy or the shared ingestion queue is busy')

  const jobs: Array<{ fileName: string; jobId: string; status: string }> = []
  for (const file of files) {
    const form = new FormData()
    form.append('file', new Blob([file.content], { type: 'text/markdown' }), file.fileName)
    const upload = await fetch(`${apiUrl}/api/documents/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}` },
      body: form,
      signal: AbortSignal.timeout(30_000),
    })
    if (upload.status !== 202) throw new Error(`Upload failed for synthetic ${file.fileName}`)
    const created = (await upload.json()) as { jobId: string }
    const deadline = Date.now() + 10 * 60_000
    let status = ''
    while (Date.now() < deadline) {
      const response = await fetch(`${apiUrl}/api/jobs/${created.jobId}`, {
        headers: { authorization: `Bearer ${bearer}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Job status failed for synthetic ${file.fileName}`)
      const current = (await response.json()) as { status?: string }
      status = current.status ?? ''
      if (status === 'completed' || status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    jobs.push({ fileName: file.fileName, jobId: created.jobId, status })
    if (status !== 'completed') throw new Error(`Ingestion failed for synthetic ${file.fileName}`)
  }

  const conversationIds: string[] = []
  async function newConversation(title: string) {
    const response = await fetch(`${apiUrl}/api/agent/conversations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    if (response.status !== 201)
      throw new Error(`Conversation creation returned HTTP ${response.status}`)
    const conversation = (await response.json()) as { id: string }
    conversationIds.push(conversation.id)
    return conversation.id
  }

  async function readDiagnostics(messageId: string) {
    const code = `import pg from 'pg';const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query('SELECT tool_metadata FROM sitepilot_excel_test.agent_messages WHERE id=$1',[process.argv[1]]);console.log(JSON.stringify(r.rows[0]?.tool_metadata??{}));await c.end()`
    return JSON.parse(
      compose(['exec', '-T', 'api', 'node', '--input-type=module', '-e', code, messageId]),
    ) as { agent?: Record<string, any>; usage?: Record<string, number> | null; errorCode?: string }
  }

  const results: Array<Record<string, any>> = []
  async function ask(
    name: string,
    question: string,
    accepts: (answer: string, citations: any[], diagnostics: Record<string, any>) => boolean,
  ) {
    const conversationId = await newConversation(`Synthetic manual regression: ${name}`)
    const startedAt = performance.now()
    try {
      const response = await fetch(
        `${apiUrl}/api/agent/conversations/${conversationId}/messages/stream`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify({ content: question }),
          signal: AbortSignal.timeout(360_000),
        },
      )
      const events = await streamEvents(response)
      const error = events.find((event) => event.type === 'error')
      const complete = events.find((event) => event.type === 'complete')
      if (error) {
        results.push({
          name,
          question,
          pass: false,
          errorCode: error.code,
          latencyMs: Math.round(performance.now() - startedAt),
        })
        return
      }
      const message = complete?.message as Record<string, any> | undefined
      if (!message) throw new Error('SSE ended without a completion message')
      const metadata = await readDiagnostics(String(message.id))
      const diagnostics = metadata.agent ?? {}
      const answer = String(message.content ?? '')
      const citations = Array.isArray(message.citations) ? message.citations : []
      results.push({
        name,
        question,
        pass: message.status === 'complete' && accepts(answer, citations, diagnostics),
        answer,
        citations,
        selectedIntent: diagnostics.intent ?? null,
        selectedTools: diagnostics.tools ?? [],
        retrieved: diagnostics.retrievedSources ?? [],
        scores: diagnostics.topScores ?? [],
        timings: {
          routingMs: diagnostics.routingMs ?? null,
          retrievalMs: diagnostics.retrievalMs ?? null,
          answerMs: diagnostics.answerMs ?? null,
          verificationMs: diagnostics.verificationMs ?? null,
          totalMs: diagnostics.totalMs ?? Math.round(performance.now() - startedAt),
        },
        latencyMs: Math.round(performance.now() - startedAt),
      })
    } catch (error) {
      results.push({
        name,
        question,
        pass: false,
        error: error instanceof Error ? error.name : 'UNKNOWN',
        latencyMs: Math.round(performance.now() - startedAt),
      })
    }
  }

  const hasSource = (citations: any[], fileName: string) =>
    citations.some((citation) => citation.source === fileName)
  const docs = new Set(files.map((file) => file.fileName))
  const unsupportedCertainty = (text: string) =>
    /(?:لا\s+يمكن\s+تأكيد|غير\s+مؤكد|غير\s+متاح|لم\s+يتم\s+تأكيد|لا\s+تؤكد|ليس\s+محدد|لا\s+توجد\s+معلومات|لا\s+تتوفر\s+معلومات|اطلب\s+عرض|طلب\s+عرض|not confirmed|unconfirmed|contact sales|written quote)/iu.test(
      text,
    )

  await ask(
    'A accounting inputs',
    'ما البيانات المحاسبية التي يحتاجها VCFO AI لبدء التحليل المالي؟',
    (answer, citations, diagnostic) =>
      diagnostic.tools?.includes('typegraph_hybrid_search') &&
      hasSource(citations, '02-data-upload-and-requirements.md') &&
      /ميزان|حساب|تقارير|فترة|currency|trial balance/iu.test(answer),
  )
  await ask(
    'B ordered processing stages',
    'اشرح مراحل معالجة البيانات المالية داخل VCFO AI بالترتيب.',
    (answer, citations, diagnostic) =>
      diagnostic.tools?.includes('typegraph_hybrid_search') &&
      hasSource(citations, '02-data-upload-and-requirements.md') &&
      /تحقق|رفع|تطبيع|تحليل|reconcil|validate/iu.test(answer),
  )
  await ask(
    'C Enterprise quote, integration, and SLA',
    'إذا طلب العميل عرض سعر Enterprise مع تطوير تكامل مخصص وSLA، كيف يجب أن يجيب المساعد؟',
    (answer, citations, diagnostic) =>
      diagnostic.tools?.includes('typegraph_hybrid_search') &&
      hasSource(citations, '07-pricing-plans-and-commercial.md') &&
      hasSource(citations, '08-sales-and-integrations.md') &&
      /لا\s+يمكن|غير\s+مؤكد|اعتماد|المبيعات|لا\s+يجب|cannot|approved/iu.test(answer),
  )
  await ask(
    'D Enterprise monthly price routing',
    'كم سعر باقة Enterprise بالدولار شهريًا؟',
    (answer, citations, diagnostic) =>
      diagnostic.tools?.includes('typegraph_hybrid_search') &&
      !diagnostic.tools?.includes('structured_excel_query') &&
      hasSource(citations, '07-pricing-plans-and-commercial.md') &&
      !/109\s+records/iu.test(answer) &&
      unsupportedCertainty(answer),
  )
  await ask(
    'E customer data model training policy',
    'هل يستخدم VCFO AI بيانات العملاء لتدريب نماذج الذكاء الاصطناعي؟',
    (answer, citations, diagnostic) =>
      diagnostic.tools?.includes('typegraph_hybrid_search') &&
      hasSource(citations, '06-security-and-privacy.md') &&
      unsupportedCertainty(answer),
  )
  await ask(
    'F privacy and multi-company permissions',
    'كيف تتكامل قواعد الخصوصية والصلاحيات مع إمكانية إدارة عدة شركات وفروع في VCFO AI؟',
    (answer, citations, diagnostic) =>
      diagnostic.tools?.includes('typegraph_hybrid_search') &&
      hasSource(citations, '06-security-and-privacy.md') &&
      hasSource(citations, '05-companies-and-branches.md'),
  )
  const pricingQuestion = 'كيف يمكن للعميل معرفة أسعار وباقات VCFO AI؟'
  const pricingCheck = (answer: string, citations: any[], diagnostic: Record<string, any>) =>
    diagnostic.tools?.includes('typegraph_hybrid_search') &&
    hasSource(citations, '07-pricing-plans-and-commercial.md') &&
    unsupportedCertainty(answer)
  await ask('G pricing answer repeat 1', pricingQuestion, pricingCheck)
  await ask('G pricing answer repeat 2', pricingQuestion, pricingCheck)
  await ask(
    'H general conversation',
    'hi how are you ? and what can you do it',
    (answer, citations, diagnostic) =>
      diagnostic.intent === 'conversation' &&
      diagnostic.tools?.includes('conversation_reply') &&
      diagnostic.retrievedCount === 0 &&
      citations.length === 0 &&
      /help|documents|spreadsheet|answer/i.test(answer),
  )

  const isolationId = `other_${unique}`
  const otherBearer = makeToken({
    tenantId: isolationId,
    groupId: isolationId,
    userId: isolationId,
  })
  const isolatedSearch = await fetch(`${apiUrl}/api/documents/search?q=Enterprise+pricing`, {
    headers: { authorization: `Bearer ${otherBearer}` },
  })
  const leaked = isolatedSearch.ok
    ? (
        (await isolatedSearch.json()) as { results?: Array<{ citation?: { source?: string } }> }
      ).results?.some((item) => docs.has(String(item.citation?.source)))
    : true

  console.log(
    JSON.stringify({
      passed: results.filter((result) => result.pass).map((result) => result.name),
      failed: results.filter((result) => !result.pass),
      tenantIsolation: { pass: !leaked },
      provider: env.SITEPILOT_LLM_PROVIDER,
      model: env.SITEPILOT_LLM_MODEL,
      jobs,
      testData: { tenantId, fileCount: files.length, conversationCount: conversationIds.length },
      note: 'All uploaded files and conversations are synthetic and retained. No existing records or volumes were modified.',
    }),
  )
  if (results.some((result) => !result.pass) || leaked) process.exitCode = 1
}

await main()
