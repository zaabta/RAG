import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import 'dotenv/config'

import {
  SitePilotWorkspace,
  type WorkspaceCitation,
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
const pendingDocumentJobId = randomUUID()
const importRunId = randomUUID()
const conversationIds: string[] = []
const historyQueries: string[] = []
const retrievalInputs: string[] = []
let retrievalCalls = 0
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

let lastPrompt = ''
const provider: LlmProvider = {
  name: 'mock',
  model: 'synthetic-mock',
  async generate(prompt) {
    if (prompt.includes('Return only one JSON object with status'))
      return { text: '{"status":"supported"}', provider: this.name, model: this.model }
    return {
      text: 'A synthetic fixture contains four records in two regions [1].',
      provider: this.name,
      model: this.model,
    }
  },
  async stream(prompt, onText) {
    lastPrompt = prompt
    const text = prompt.includes('Region: North; Amount: 10; Category: A')
      ? 'The amount is 10 for North [1].'
      : 'A synthetic fixture contains four records in two regions [1].'
    onText(text.slice(0, 24))
    onText(text.slice(24))
    return { text, provider: this.name, model: this.model }
  },
}

const workspace = new SitePilotWorkspace(
  databaseUrl,
  async (question) => {
    retrievalCalls++
    retrievalInputs.push(question)
    if (/amount|numeric value/iu.test(question))
      return [
        {
          content: 'Region: North; Amount: 10; Category: A',
          citation: {
            source: 'synthetic-agent-fixture-authorized.xlsx',
            sheet: 'Fixture',
            rowStart: 2,
            rowEnd: 2,
            sourceRange: 'A2:C2',
          },
        },
      ]
    return [
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
    ]
  },
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
    `INSERT INTO sitepilot_excel_test.excel_sheets(file_id,sheet_name,row_count,column_count,header_row,last_seen_run)
     VALUES($1,'Fixture',$2,3,1,$3)`,
    [fId, rows.length + 1, rId],
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
  await pool.query(
    `INSERT INTO sitepilot_excel_test.sitepilot_upload_jobs
     (job_id,tenant_id,group_id,user_id,original_name,file_sha256,status,file_size_bytes)
     VALUES($1,$2,$3,$4,'synthetic-pending.csv',$5,'queued',23)`,
    [
      pendingDocumentJobId,
      identity.tenantId,
      identity.groupId,
      identity.userId,
      `${runId}_pending`,
    ],
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

  const listedDocuments = await workspace.listAuthorizedDocuments(identity)
  if (
    listedDocuments.length !== 2 ||
    !listedDocuments.some(
      (document) =>
        document.fileName === 'synthetic-agent-fixture-authorized.xlsx' &&
        document.fileType === 'XLSX' &&
        document.mimeType === null &&
        document.sheets.join(',') === 'Fixture',
    ) ||
    !listedDocuments.some(
      (document) =>
        document.fileName === 'synthetic-pending.csv' &&
        document.fileType === 'CSV' &&
        document.status === 'queued' &&
        document.sizeBytes === 23 &&
        document.sheets.length === 0,
    )
  )
    throw new Error(
      `Document discovery did not return authorized XLSX metadata and sheets: ${JSON.stringify(listedDocuments)}`,
    )
  if (listedDocuments.some((document) => document.fileName.includes('unauthorized')))
    throw new Error('Document discovery exposed a file from another tenant')

  const retrievalCountBeforeInventory = retrievalCalls
  const agentToolsIdentity = { ...identity, userId: `${userId}_agent_tools` }
  const inventoryConversation = await createConversation(agentToolsIdentity)
  const inventoryEvents: WorkspaceStreamEvent[] = []
  await workspace.streamMessage(
    inventoryConversation,
    'What kind of files we have?',
    agentToolsIdentity,
    new AbortController().signal,
    (event) => inventoryEvents.push(event),
  )
  const inventoryComplete = inventoryEvents.find((event) => event.type === 'complete')
  if (
    !inventoryComplete ||
    inventoryComplete.message.provider !== 'sitepilot-documents' ||
    !inventoryComplete.message.content.includes('XLSX') ||
    inventoryComplete.message.citations.some(
      (citation: WorkspaceCitation) => citation.rowStart != null,
    )
  )
    throw new Error('Inventory question did not return document metadata citations')
  if (retrievalCalls !== retrievalCountBeforeInventory)
    throw new Error('Inventory question unnecessarily invoked TypeGraph RAG')

  const smallTalkConversation = await createConversation(agentToolsIdentity)
  const smallTalkEvents: WorkspaceStreamEvent[] = []
  await workspace.streamMessage(
    smallTalkConversation,
    'How are you?',
    agentToolsIdentity,
    new AbortController().signal,
    (event) => smallTalkEvents.push(event),
  )
  const smallTalkComplete = smallTalkEvents.find((event) => event.type === 'complete')
  if (
    !smallTalkComplete ||
    smallTalkComplete.message.citations.length !== 0 ||
    smallTalkComplete.message.provider !== 'sitepilot-chat' ||
    retrievalCalls !== retrievalCountBeforeInventory
  )
    throw new Error('Small talk invoked document retrieval or received irrelevant citations')

  const metadataConversation = await createConversation(agentToolsIdentity)
  const metadataEvents: WorkspaceStreamEvent[] = []
  await workspace.streamMessage(
    metadataConversation,
    'List sheets and file size for synthetic-agent-fixture-authorized.xlsx',
    agentToolsIdentity,
    new AbortController().signal,
    (event) => metadataEvents.push(event),
  )
  const metadataComplete = metadataEvents.find((event) => event.type === 'complete')
  if (
    !metadataComplete ||
    !metadataComplete.message.content.includes('Sheets: Fixture') ||
    metadataComplete.message.citations.length !== 1 ||
    metadataComplete.message.citations[0]?.rowStart != null
  )
    throw new Error(
      'Specific Excel metadata lookup returned missing data or spreadsheet row citations',
    )
  if (retrievalCalls !== retrievalCountBeforeInventory)
    throw new Error('Metadata question unnecessarily invoked TypeGraph RAG')

  const followUpConversation = await createConversation(agentToolsIdentity)
  const firstFollowUpQuestion = 'Which numeric value is stored in the North record?'
  const firstFollowUpEvents: WorkspaceStreamEvent[] = []
  await workspace.streamMessage(
    followUpConversation,
    firstFollowUpQuestion,
    agentToolsIdentity,
    new AbortController().signal,
    (event) => firstFollowUpEvents.push(event),
  )
  const secondFollowUpEvents: WorkspaceStreamEvent[] = []
  await workspace.streamMessage(
    followUpConversation,
    'What value did you just tell me? Please cite the same source.',
    agentToolsIdentity,
    new AbortController().signal,
    (event) => secondFollowUpEvents.push(event),
  )
  if (
    !firstFollowUpEvents.some((event) => event.type === 'complete') ||
    !secondFollowUpEvents.some((event) => event.type === 'complete') ||
    !retrievalInputs.at(-1)?.includes(firstFollowUpQuestion)
  )
    throw new Error('Contextual follow-up did not reuse the preceding user question for retrieval')

  const evidenceConversation = await createConversation(agentToolsIdentity)
  const evidenceEvents: WorkspaceStreamEvent[] = []
  await workspace.streamMessage(
    evidenceConversation,
    'What is the amount in the North row?',
    agentToolsIdentity,
    new AbortController().signal,
    (event) => evidenceEvents.push(event),
  )
  const evidenceComplete = evidenceEvents.find((event) => event.type === 'complete')
  if (
    !evidenceComplete ||
    !evidenceComplete.message.content.includes('10') ||
    evidenceComplete.message.citations.length !== 1 ||
    evidenceComplete.message.citations[0]?.sourceRange !== 'A2:C2' ||
    !lastPrompt.includes('Region: North; Amount: 10; Category: A')
  )
    throw new Error(
      'Excel content answer did not receive exact authorized row evidence and citation',
    )

  const unsupportedProvider: LlmProvider = {
    name: 'mock-unsupported',
    model: 'synthetic-unsupported',
    async generate() {
      return {
        text: 'The account balance is 999 dollars [1].',
        provider: this.name,
        model: this.model,
      }
    },
    async stream(_prompt, onText) {
      const text = 'The account balance is 999 dollars [1].'
      onText(text)
      return { text, provider: this.name, model: this.model }
    },
  }
  const unsupportedWorkspace = new SitePilotWorkspace(
    databaseUrl,
    async () => [
      {
        content: 'Account label: Operating account; recorded balance: 500 dollars.',
        citation: {
          source: 'synthetic-account-fixture.xlsx',
          sheet: 'Accounts',
          rowStart: 2,
          rowEnd: 2,
          sourceRange: 'A2:B2',
        },
      },
    ],
    join(tmpdir(), 'sitepilot-workspace-fixtures'),
    () => unsupportedProvider,
  )
  const unsupportedConversation = await createConversation(agentToolsIdentity)
  const unsupportedEvents: WorkspaceStreamEvent[] = []
  await unsupportedWorkspace.streamMessage(
    unsupportedConversation,
    'What is the account balance?',
    agentToolsIdentity,
    new AbortController().signal,
    (event) => unsupportedEvents.push(event),
  )
  await unsupportedWorkspace.close()
  const unsupportedSaved = await pool.query(
    `SELECT content,status,citations,tool_metadata->>'errorCode' AS code
     FROM sitepilot_excel_test.agent_messages WHERE conversation_id=$1 AND role='assistant'`,
    [unsupportedConversation],
  )
  if (
    unsupportedSaved.rows[0]?.status !== 'failed' ||
    unsupportedSaved.rows[0]?.code !== 'INSUFFICIENT_EVIDENCE' ||
    (unsupportedSaved.rows[0]?.citations as unknown[]).length !== 0 ||
    unsupportedEvents.some((event) => event.type === 'delta' && event.text.includes('999'))
  )
    throw new Error('Unsupported model claim was streamed or persisted with an irrelevant citation')

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
      const request = JSON.parse(String(init?.body)) as (typeof ollamaRequests)[number]
      ollamaRequests.push(request)
      if (!request.stream)
        return new Response(
          JSON.stringify({
            message: { role: 'assistant', content: '{"status":"supported"}' },
            done: true,
            prompt_eval_count: 100,
            eval_count: 3,
          }),
          { headers: { 'content-type': 'application/json' } },
        )
      const chunks = [
        { message: { content: 'A synthetic fixture contains ' }, done: false },
        {
          message: { content: 'four records [1].', thinking: 'synthetic hidden reasoning' },
          done: false,
        },
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
      deltasText !== 'A synthetic fixture contains four records.' ||
      complete?.message.status !== 'complete' ||
      complete.message.provider !== 'ollama' ||
      complete.message.model !== 'qwen3:8b' ||
      !complete.message.citations.length
    )
      throw new Error('Mocked Ollama Agent response did not persist and stream with citations')
  }
  await ollamaWorkspace.close()
  if (
    ollamaRequests.length !== 4 ||
    ollamaRequests.some((request) => request.model !== 'qwen3:8b' || request.think !== false) ||
    JSON.stringify(ollamaRequests.map((request) => request.stream)) !==
      JSON.stringify([true, false, true, false]) ||
    !ollamaRequests[0]?.messages.some((message) => message.role === 'system') ||
    !ollamaRequests[2]?.messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.content === 'A synthetic fixture contains four records.',
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

  const syntheticAccountCitation = {
    source: 'synthetic-accounts.xlsx',
    sheet: 'Accounts',
    rowStart: 2,
    rowEnd: 2,
    sourceRange: 'A2:C2',
  }
  const runVerifiedEvidenceCase = async (
    question: string,
    answer: string,
    decision: 'supported' | 'insufficient' | 'conflicting',
    retrieved: Array<{ content: string; citation: Record<string, unknown> }>,
  ) => {
    const testProvider: LlmProvider = {
      name: 'synthetic-verifier',
      model: 'fixture-verifier-v1',
      async generate(prompt) {
        return {
          text: prompt.includes('Return only one JSON object with status')
            ? JSON.stringify({ status: decision })
            : answer,
          provider: this.name,
          model: this.model,
        }
      },
      async stream(_prompt, onText) {
        onText(answer)
        return { text: answer, provider: this.name, model: this.model }
      },
    }
    const testWorkspace = new SitePilotWorkspace(
      databaseUrl,
      async () => retrieved as never,
      join(tmpdir(), 'sitepilot-workspace-fixtures'),
      () => testProvider,
    )
    const conversation = await createConversation(identity)
    const caseEvents: WorkspaceStreamEvent[] = []
    await testWorkspace.streamMessage(
      conversation,
      question,
      identity,
      new AbortController().signal,
      (event) => caseEvents.push(event),
    )
    await testWorkspace.close()
    const saved = await pool.query(
      `SELECT status,provider,model,citations,content,tool_metadata->>'errorCode' AS code
       FROM sitepilot_excel_test.agent_messages WHERE conversation_id=$1 AND role='assistant'`,
      [conversation],
    )
    return { events: caseEvents, saved: saved.rows[0] as Record<string, unknown> }
  }
  const genericAccount = await runVerifiedEvidenceCase(
    'What is the actual bank for the USD account?',
    'The actual bank is Synthetic Trust Bank [1].',
    'supported',
    [
      {
        content: 'Account title: بنك - دولار أمريكي; Account type: USD bank account; code: 1010.',
        citation: syntheticAccountCitation,
      },
    ],
  )
  if (
    genericAccount.saved.status !== 'failed' ||
    genericAccount.saved.code !== 'INSUFFICIENT_EVIDENCE' ||
    (genericAccount.saved.citations as unknown[]).length !== 0 ||
    genericAccount.events.some((event) => event.type === 'delta')
  )
    throw new Error('Generic ledger evidence was accepted as proof of a named entity')

  const supportedEntity = await runVerifiedEvidenceCase(
    'Which bank is named for the USD account?',
    'Synthetic Trust Bank is named for the USD account [1].',
    'supported',
    [
      {
        content: 'USD account; Bank name: Synthetic Trust Bank.',
        citation: syntheticAccountCitation,
      },
    ],
  )
  if (
    supportedEntity.saved.status !== 'complete' ||
    !String(supportedEntity.saved.content).includes('Synthetic Trust Bank') ||
    (supportedEntity.saved.citations as unknown[]).length !== 1
  )
    throw new Error('Directly stated synthetic entity was not verified and cited')

  const conflictingFacts = await runVerifiedEvidenceCase(
    'Which institution is identified?',
    'The first source identifies Synthetic Trust Bank [1]. The second identifies Example Credit Union [2].',
    'conflicting',
    [
      {
        content: 'The account is held at Synthetic Trust Bank.',
        citation: syntheticAccountCitation,
      },
      {
        content: 'The account is held at Example Credit Union.',
        citation: { ...syntheticAccountCitation, sourceRange: 'A3:C3', rowStart: 3, rowEnd: 3 },
      },
    ],
  )
  if (
    conflictingFacts.saved.status !== 'failed' ||
    conflictingFacts.saved.code !== 'CONFLICTING_EVIDENCE' ||
    (conflictingFacts.saved.citations as unknown[]).length !== 0 ||
    conflictingFacts.events.some((event) => event.type === 'delta')
  )
    throw new Error('Conflicting evidence was presented as a resolved claim')

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
        'small-talk routing answers How are you without RAG or citations',
        'contextual follow-up retrieval uses the prior user question',
        'unsupported generated claim is blocked before SSE and persisted as insufficient evidence',
        'permission-scoped document inventory and file type listing',
        'Excel metadata and sheet lookup without row citations or RAG',
        'inventory routing skips RAG and uses document references',
        'exact authorized spreadsheet row evidence and source range citation',
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
        'generic ledger labels do not ground unsupported named entities',
        'explicitly stated entities pass general evidence verification',
        'conflicting source claims abstain without emitting an answer',
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
      'DELETE FROM sitepilot_excel_test.excel_sheets WHERE file_id=ANY($1::text[])',
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
  await pool.query('DELETE FROM sitepilot_excel_test.sitepilot_upload_jobs WHERE job_id=$1', [
    pendingDocumentJobId,
  ])
  if (historyQueries.length)
    await pool.query(
      'DELETE FROM sitepilot_excel_test.document_search_history WHERE user_id=$1 AND query=ANY($2::text[])',
      [userId, historyQueries],
    )
  await workspace.close()
  await pool.end()
}
