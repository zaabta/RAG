import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import 'dotenv/config'

import {
  SitePilotWorkspace,
  type WorkspaceIdentity,
  type WorkspaceStreamEvent,
} from '../src/sitepilot/agent/sitepilot-workspace.mjs'
import {
  OllamaProvider,
  type LlmChatMessage,
  type LlmProvider,
} from '../src/sitepilot/agent/sitepilot-llm-provider.mjs'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required')

const runId = randomUUID()
const tenantId = `workspace_fixture_${runId.replaceAll('-', '')}`
const groupId = `${tenantId}_group`
const userId = `${tenantId}_user`
const identity: WorkspaceIdentity = { tenantId, groupId, userId }
const fileId = `fixture_${runId.replaceAll('-', '')}`
const jobId = randomUUID()
const importRunId = randomUUID()
const conversationIds: string[] = []
const historyQueries: string[] = []
const pool = new Pool({
  connectionString: databaseUrl,
  max: 2,
  application_name: 'sitepilot-workspace-fixture-test',
})

const fixtureRows = [
  { region: 'North', amount: 10, category: 'A' },
  { region: 'North', amount: 20, category: 'B' },
  { region: 'South', amount: 30, category: 'A' },
  { region: 'South', amount: 40, category: 'B' },
]

const provider: LlmProvider = {
  name: 'mock',
  model: 'synthetic-mock',
  async generate() {
    return { text: 'Verified synthetic answer.', provider: this.name, model: this.model }
  },
  async stream(_prompt, onText) {
    onText('Verified ')
    onText('synthetic answer.')
    return { text: 'Verified synthetic answer.', provider: this.name, model: this.model }
  },
}

const workspace = new SitePilotWorkspace(
  databaseUrl,
  async () => [
    {
      content: 'A synthetic fixture contains four records in two regions.',
      citation: {
        source: 'synthetic-agent-fixture.xlsx',
        sheet: 'Fixture',
        rowStart: 2,
        rowEnd: 5,
        sourceRange: 'A2:C5',
      },
    },
  ],
  join(tmpdir(), 'sitepilot-workspace-fixtures'),
  () => provider,
)

async function insertFile(owner: WorkspaceIdentity, suffix: string, rows: typeof fixtureRows) {
  const fId = `${fileId}_${suffix}`
  const jId = randomUUID()
  const rId = randomUUID()
  const name = `synthetic-agent-fixture-${suffix}.xlsx`
  await pool.query(
    `INSERT INTO sitepilot_excel_test.excel_files(file_id,file_name,content_hash,latest_run_id,sheet_count,record_count)
     VALUES($1,$2,$3,$4,1,$5)`,
    [fId, name, runId, rId, rows.length],
  )
  await pool.query(
    `INSERT INTO sitepilot_excel_test.excel_import_runs(run_id,file_id,content_hash,status,sheet_count,record_count,finished_at)
     VALUES($1,$2,$3,'complete',1,$4,NOW())`,
    [rId, fId, runId, rows.length],
  )
  await pool.query(
    `INSERT INTO sitepilot_excel_test.sitepilot_upload_jobs(job_id,tenant_id,group_id,user_id,original_name,file_sha256,status)
     VALUES($1,$2,$3,$4,$5,$6,'completed')`,
    [jId, owner.tenantId, owner.groupId, owner.userId, name, runId],
  )
  await pool.query(
    `INSERT INTO sitepilot_excel_test.sitepilot_upload_file_versions(job_id,tenant_id,group_id,user_id,original_name,file_sha256,file_id,is_active,published_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,NOW())`,
    [jId, owner.tenantId, owner.groupId, owner.userId, name, runId, fId],
  )
  for (const [index, row] of rows.entries()) {
    await pool.query(
      `INSERT INTO sitepilot_excel_test.excel_records
       (record_id,file_id,sheet_name,record_key,source_row_start,source_row_end,source_range,normalized_fields,original_headers,cell_states,record_hash,document_content,is_active,sync_status,last_seen_run)
       VALUES($1,$2,'Fixture',$3,$4,$4,$5,$6::jsonb,$7::jsonb,'{}'::jsonb,$8,$9,TRUE,'synced',$10)`,
      [
        `${fId}_${index}`,
        fId,
        `row_${index}`,
        index + 2,
        `A${index + 2}:C${index + 2}`,
        JSON.stringify(row),
        JSON.stringify({ region: 'Region', amount: 'Amount', category: 'Category' }),
        `${runId}_${index}`,
        `Region: ${row.region}; Amount: ${row.amount}; Category: ${row.category}`,
        rId,
      ],
    )
  }
  return { fileId: fId, jobId: jId, importRunId: rId }
}

async function createConversation(owner: WorkspaceIdentity) {
  const id = randomUUID()
  conversationIds.push(id)
  await pool.query(
    `INSERT INTO sitepilot_excel_test.agent_conversations(id,tenant_id,group_id,user_id,title)
     VALUES($1,$2,$3,$4,'Synthetic test')`,
    [id, owner.tenantId, owner.groupId, owner.userId],
  )
  return id
}

let files: Array<{ fileId: string; jobId: string; importRunId: string }> = []
try {
  await mkdir(join(tmpdir(), 'sitepilot-workspace-fixtures'), { recursive: true })
  files.push(await insertFile(identity, 'authorized', fixtureRows))
  files.push(
    await insertFile({ tenantId: `${tenantId}_other`, groupId, userId }, 'unauthorized', [
      { region: 'North', amount: 999, category: 'Private' },
    ]),
  )

  const count = (await workspace.structuredQuery('How many records?', identity)) as {
    value: number
  }
  const group = (await workspace.structuredQuery('Count by Region', identity)) as {
    groups: Array<{ value: string; count: number }>
  }
  const exact = (await workspace.structuredQuery(
    'Count records where Region = "North"',
    identity,
  )) as { value: number }
  const sum = (await workspace.structuredQuery('Sum Amount', identity)) as {
    value: number
    numericRows: number
  }
  const filteredSum = (await workspace.structuredQuery(
    'Sum Amount where Region = "North"',
    identity,
  )) as {
    value: number
    numericRows: number
  }
  if (count.value !== 4) throw new Error('COUNT did not use all authorized active fixture rows')
  if (
    JSON.stringify(group.groups) !==
    JSON.stringify([
      { value: 'North', count: 2 },
      { value: 'South', count: 2 },
    ])
  )
    throw new Error('GROUP BY did not aggregate the complete authorized fixture')
  if (exact.value !== 2) throw new Error('Exact equality filtering returned an incorrect count')
  if (sum.value !== 100 || sum.numericRows !== 4)
    throw new Error('Numeric SUM did not include every authorized fixture row')
  if (filteredSum.value !== 30 || filteredSum.numericRows !== 2)
    throw new Error('Filtered numeric aggregation did not respect exact filter and tenant scope')

  const paginationConversations = await Promise.all([
    createConversation(identity),
    createConversation(identity),
    createConversation(identity),
  ])
  const conversationPage1 = await workspace.handle(
    'GET',
    '/api/agent/conversations',
    new URL('http://local/api/agent/conversations?limit=2'),
    identity,
  )
  const conversationBody1 = conversationPage1.body as {
    conversations: Array<{ id: string }>
    nextCursor: string | null
  }
  if (conversationBody1.conversations.length !== 2 || !conversationBody1.nextCursor)
    throw new Error('Conversation pagination did not return a bounded first page')
  const conversationPage2 = await workspace.handle(
    'GET',
    '/api/agent/conversations',
    new URL(`http://local/api/agent/conversations?limit=2&cursor=${conversationBody1.nextCursor}`),
    identity,
  )
  const conversationBody2 = conversationPage2.body as {
    conversations: Array<{ id: string }>
    nextCursor: string | null
  }
  if (
    conversationBody2.conversations.length !== 1 ||
    conversationBody2.nextCursor !== null ||
    new Set(
      [...conversationBody1.conversations, ...conversationBody2.conversations].map(
        (item) => item.id,
      ),
    ).size !== 3
  )
    throw new Error('Conversation pagination skipped or repeated entries')

  const pagedConversation = paginationConversations[0]!
  for (let index = 0; index < 3; index++) {
    await pool.query(
      `INSERT INTO sitepilot_excel_test.agent_messages(id,conversation_id,role,content,status,created_at)
       VALUES($1,$2,'user',$3,'complete',NOW() + ($4::int * INTERVAL '1 millisecond'))`,
      [randomUUID(), pagedConversation, `synthetic message ${index}`, index],
    )
  }
  const messagesPage1 = await workspace.handle(
    'GET',
    `/api/agent/conversations/${pagedConversation}/messages`,
    new URL(`http://local/api/agent/conversations/${pagedConversation}/messages?limit=2`),
    identity,
  )
  const messageBody1 = messagesPage1.body as {
    messages: Array<{ id: string }>
    messagesNextCursor: string | null
  }
  const messagesPage2 = await workspace.handle(
    'GET',
    `/api/agent/conversations/${pagedConversation}/messages`,
    new URL(
      `http://local/api/agent/conversations/${pagedConversation}/messages?limit=2&cursor=${messageBody1.messagesNextCursor}`,
    ),
    identity,
  )
  const messageBody2 = messagesPage2.body as {
    messages: Array<{ id: string }>
    messagesNextCursor: string | null
  }
  if (
    messageBody1.messages.length !== 2 ||
    messageBody2.messages.length !== 1 ||
    messageBody2.messagesNextCursor !== null
  )
    throw new Error('Conversation message pagination did not return all fixture messages')

  for (let index = 0; index < 3; index++) {
    const query = `${tenantId} synthetic history ${index}`
    historyQueries.push(query)
    await workspace.saveSearch(identity, query, index)
  }
  const historyPage1 = await workspace.handle(
    'GET',
    '/api/search/history',
    new URL('http://local/api/search/history?limit=2'),
    identity,
  )
  const historyBody1 = historyPage1.body as {
    history: Array<{ id: string }>
    nextCursor: string | null
  }
  const historyPage2 = await workspace.handle(
    'GET',
    '/api/search/history',
    new URL(`http://local/api/search/history?limit=2&cursor=${historyBody1.nextCursor}`),
    identity,
  )
  const historyBody2 = historyPage2.body as {
    history: Array<{ id: string }>
    nextCursor: string | null
  }
  if (
    historyBody1.history.length !== 2 ||
    historyBody2.history.length !== 1 ||
    historyBody2.nextCursor !== null
  )
    throw new Error('Search history pagination did not return all fixture entries')

  const conversationId = await createConversation(identity)
  const events: WorkspaceStreamEvent[] = []
  await workspace.streamMessage(
    conversationId,
    'Describe the synthetic fixture.',
    identity,
    new AbortController().signal,
    (event) => events.push(event),
  )
  const deltas = events.filter((event) => event.type === 'delta')
  const completed = events.find(
    (event): event is Extract<WorkspaceStreamEvent, { type: 'complete' }> =>
      event.type === 'complete',
  )
  if (
    deltas.length !== 2 ||
    completed?.message.status !== 'complete' ||
    completed.message.provider !== provider.name ||
    completed.message.model !== provider.model ||
    !completed.message.citations.length
  )
    throw new Error('Mocked streaming answer did not emit incremental text with verified citations')

  const ollamaRequests: Array<{
    model: string
    stream: boolean
    think?: boolean
    messages: LlmChatMessage[]
  }> = []
  const ollamaProvider = new OllamaProvider(
    'http://127.0.0.1:11434',
    'qwen3:8b',
    5_000,
    async (_input, init) => {
      ollamaRequests.push(JSON.parse(String(init?.body)) as (typeof ollamaRequests)[number])
      const chunks = [
        { message: { content: 'Ollama synthetic ' }, done: false },
        { message: { content: 'answer.', thinking: 'synthetic hidden reasoning' }, done: false },
        { message: { content: '' }, done: true, prompt_eval_count: 18, eval_count: 4 },
      ]
      return new Response(chunks.map((item) => JSON.stringify(item)).join('\n') + '\n', {
        headers: { 'content-type': 'application/x-ndjson' },
      })
    },
  )
  const ollamaWorkspace = new SitePilotWorkspace(
    databaseUrl,
    async () => [
      {
        content: 'A synthetic fixture contains four records in two regions.',
        citation: {
          source: 'synthetic-agent-fixture.xlsx',
          sheet: 'Fixture',
          rowStart: 2,
          rowEnd: 5,
          sourceRange: 'A2:C5',
        },
      },
    ],
    join(tmpdir(), 'sitepilot-workspace-fixtures'),
    () => ollamaProvider,
  )
  const ollamaConversation = await createConversation(identity)
  for (const question of ['Summarize the synthetic fixture.', 'What did you just summarize?']) {
    const ollamaEvents: WorkspaceStreamEvent[] = []
    await ollamaWorkspace.streamMessage(
      ollamaConversation,
      question,
      identity,
      new AbortController().signal,
      (event) => ollamaEvents.push(event),
    )
    const deltasText = ollamaEvents
      .filter(
        (event): event is Extract<WorkspaceStreamEvent, { type: 'delta' }> =>
          event.type === 'delta',
      )
      .map((event) => event.text)
      .join('')
    const complete = ollamaEvents.find(
      (event): event is Extract<WorkspaceStreamEvent, { type: 'complete' }> =>
        event.type === 'complete',
    )
    if (
      deltasText !== 'Ollama synthetic answer.' ||
      complete?.message.status !== 'complete' ||
      complete.message.provider !== 'ollama' ||
      complete.message.model !== 'qwen3:8b' ||
      !complete.message.citations.length
    )
      throw new Error('Mocked Ollama Agent response did not persist and stream with citations')
  }
  await ollamaWorkspace.close()
  if (
    ollamaRequests.length !== 2 ||
    ollamaRequests.some(
      (request) => request.model !== 'qwen3:8b' || !request.stream || request.think !== false,
    ) ||
    !ollamaRequests[0]?.messages.some((message) => message.role === 'system') ||
    !ollamaRequests[1]?.messages.some(
      (message) => message.role === 'assistant' && message.content === 'Ollama synthetic answer.',
    )
  )
    throw new Error('Mocked Ollama chat payload omitted Qwen3 settings or conversation history')
  const ollamaSavedMessages = await pool.query(
    `SELECT status,provider,model,citations FROM sitepilot_excel_test.agent_messages
     WHERE conversation_id=$1 AND role='assistant' ORDER BY created_at`,
    [ollamaConversation],
  )
  if (
    ollamaSavedMessages.rows.length !== 2 ||
    ollamaSavedMessages.rows.some(
      (row) =>
        row.status !== 'complete' ||
        row.provider !== 'ollama' ||
        row.model !== 'qwen3:8b' ||
        !row.citations.length,
    )
  )
    throw new Error(
      'Mocked Ollama conversation did not persist provider, model, status, and citations',
    )

  const unavailableModelWorkspace = new SitePilotWorkspace(
    databaseUrl,
    async () => [
      {
        content: 'A synthetic fixture contains four records in two regions.',
        citation: { source: 'synthetic-agent-fixture.xlsx', sheet: 'Fixture', rowStart: 2 },
      },
    ],
    join(tmpdir(), 'sitepilot-workspace-fixtures'),
    () =>
      new OllamaProvider(
        'http://127.0.0.1:11434',
        'qwen3:8b',
        5_000,
        async () =>
          new Response(JSON.stringify({ error: "model 'qwen3:8b' not found" }), { status: 404 }),
      ),
  )
  const unavailableModelConversation = await createConversation(identity)
  const unavailableModelEvents: WorkspaceStreamEvent[] = []
  await unavailableModelWorkspace.streamMessage(
    unavailableModelConversation,
    'Summarize the synthetic fixture.',
    identity,
    new AbortController().signal,
    (event) => unavailableModelEvents.push(event),
  )
  await unavailableModelWorkspace.close()
  const unavailableModelMessage = await pool.query(
    `SELECT status,provider,model,tool_metadata->>'errorCode' AS code
     FROM sitepilot_excel_test.agent_messages WHERE conversation_id=$1 AND role='assistant'`,
    [unavailableModelConversation],
  )
  const unavailableModelEvent = unavailableModelEvents.find(
    (event): event is Extract<WorkspaceStreamEvent, { type: 'error' }> => event.type === 'error',
  )
  if (
    unavailableModelEvent?.code !== 'MODEL_NOT_INSTALLED' ||
    !unavailableModelEvent.message.toLowerCase().includes('not installed') ||
    unavailableModelMessage.rows[0]?.status !== 'failed' ||
    unavailableModelMessage.rows[0]?.provider !== 'ollama' ||
    unavailableModelMessage.rows[0]?.model !== 'qwen3:8b' ||
    unavailableModelMessage.rows[0]?.code !== 'MODEL_NOT_INSTALLED'
  )
    throw new Error('Missing Ollama model was not reported and persisted as MODEL_NOT_INSTALLED')

  const cancelledConversation = await createConversation(identity)
  const controller = new AbortController()
  const cancelledEvents: WorkspaceStreamEvent[] = []
  await workspace.streamMessage(
    cancelledConversation,
    'Describe the synthetic fixture.',
    identity,
    controller.signal,
    (event) => {
      cancelledEvents.push(event)
      if (event.type === 'delta') controller.abort()
    },
  )
  const cancelled = await pool.query(
    `SELECT status,tool_metadata->>'errorCode' AS code FROM sitepilot_excel_test.agent_messages
     WHERE conversation_id=$1 AND role='assistant'`,
    [cancelledConversation],
  )
  if (cancelled.rows[0]?.status !== 'failed' || cancelled.rows[0]?.code !== 'PROVIDER_CANCELLED')
    throw new Error('Streaming cancellation was not persisted as a safe failed turn')

  const failingProvider: LlmProvider = {
    name: 'gemini',
    model: 'synthetic-gemini-model',
    async generate() {
      throw Object.assign(new Error('synthetic timeout'), { code: 'PROVIDER_TIMEOUT' })
    },
  }
  const failingWorkspace = new SitePilotWorkspace(
    databaseUrl,
    async () => [
      {
        content: 'Synthetic fixture only.',
        citation: { source: 'synthetic-agent-fixture.xlsx', sheet: 'Fixture', rowStart: 2 },
      },
    ],
    join(tmpdir(), 'sitepilot-workspace-fixtures'),
    () => failingProvider,
  )
  const failedConversation = await createConversation(identity)
  await failingWorkspace.streamMessage(
    failedConversation,
    'Describe the synthetic fixture.',
    identity,
    new AbortController().signal,
    () => undefined,
  )
  await failingWorkspace.close()
  const failedProviderMessage = await pool.query(
    `SELECT status,provider,model,tool_metadata->>'errorCode' AS code
     FROM sitepilot_excel_test.agent_messages WHERE conversation_id=$1 AND role='assistant'`,
    [failedConversation],
  )
  if (
    failedProviderMessage.rows[0]?.status !== 'failed' ||
    failedProviderMessage.rows[0]?.provider !== 'gemini' ||
    failedProviderMessage.rows[0]?.model !== 'synthetic-gemini-model' ||
    failedProviderMessage.rows[0]?.code !== 'PROVIDER_TIMEOUT'
  )
    throw new Error('Provider failure did not persist its safe code, provider, and model metadata')

  const insufficientWorkspace = new SitePilotWorkspace(
    databaseUrl,
    async () => [],
    join(tmpdir(), 'sitepilot-workspace-fixtures'),
    () => provider,
  )
  const insufficientConversation = await createConversation(identity)
  await insufficientWorkspace.streamMessage(
    insufficientConversation,
    'What color is the sky?',
    identity,
    new AbortController().signal,
    (event) => events.push(event),
  )
  await insufficientWorkspace.close()
  const insufficient = await pool.query(
    `SELECT status,tool_metadata->>'errorCode' AS code FROM sitepilot_excel_test.agent_messages
     WHERE conversation_id=$1 AND role='assistant'`,
    [insufficientConversation],
  )
  if (
    insufficient.rows[0]?.status !== 'failed' ||
    insufficient.rows[0]?.code !== 'INSUFFICIENT_EVIDENCE'
  )
    throw new Error('Agent did not refuse an unsupported answer')

  console.log(
    JSON.stringify({
      passed: [
        'full-scope COUNT',
        'GROUP BY',
        'exact filtering',
        'full-scope numeric SUM',
        'filtered numeric aggregation',
        'conversation pagination',
        'message pagination',
        'search-history pagination',
        'mocked incremental Agent stream with citations',
        'mocked Ollama /api/chat streaming with Qwen3 reasoning suppression',
        'mocked Ollama system prompt and persisted conversation history',
        'Ollama provider/model/status/citation persistence',
        'missing Ollama model reported as MODEL_NOT_INSTALLED',
        'stream cancellation persistence',
        'provider failure metadata persistence',
        'insufficient evidence refusal',
        'tenant isolation',
      ],
      fixtureRows: fixtureRows.length,
      unauthorizedRowsExcluded: 1,
    }),
  )
} finally {
  await Promise.all(
    conversationIds.map((id) =>
      pool.query('DELETE FROM sitepilot_excel_test.agent_conversations WHERE id=$1', [id]),
    ),
  )
  if (files.length) {
    const jobIds = files.map((file) => file.jobId)
    const fileIds = files.map((file) => file.fileId)
    const runIds = files.map((file) => file.importRunId)
    await pool.query(
      'DELETE FROM sitepilot_excel_test.sitepilot_upload_file_versions WHERE job_id=ANY($1::uuid[])',
      [jobIds],
    )
    await pool.query(
      'DELETE FROM sitepilot_excel_test.sitepilot_upload_jobs WHERE job_id=ANY($1::uuid[])',
      [jobIds],
    )
    await pool.query(
      'DELETE FROM sitepilot_excel_test.excel_records WHERE file_id=ANY($1::text[])',
      [fileIds],
    )
    await pool.query(
      'DELETE FROM sitepilot_excel_test.excel_import_runs WHERE run_id=ANY($1::uuid[])',
      [runIds],
    )
    await pool.query('DELETE FROM sitepilot_excel_test.excel_files WHERE file_id=ANY($1::text[])', [
      fileIds,
    ])
  }
  if (historyQueries.length)
    await pool.query(
      'DELETE FROM sitepilot_excel_test.document_search_history WHERE user_id=$1 AND query=ANY($2::text[])',
      [userId, historyQueries],
    )
  await workspace.close()
  await pool.end()
}
