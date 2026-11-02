import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parse } from 'dotenv'

const env = parse(await readFile('.env.docker'))
const secret = env.SITEPILOT_JWT_SECRET
if (!secret || secret.length < 32) throw new Error('Configured backend JWT secret is unavailable')
const id = `workspace_test_${randomUUID().replaceAll('-', '')}`
const identity = { tenantId: id, userId: id, groupId: id }
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const h = encode({ alg: 'HS256', typ: 'JWT' })
const p = encode({
  aud: 'sitepilot-upload',
  sub: id,
  tenant_id: id,
  sitepilot_group_id: id,
  groups: [id],
  exp: Math.floor(Date.now() / 1000) + 300,
})
const token = `${h}.${p}.${createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url')}`
const base = `http://127.0.0.1:${process.env.SITEPILOT_API_PORT ?? '3210'}`
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
async function request(path: string, init: RequestInit = {}) {
  return fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } })
}
function ensure(ok: boolean, message: string) {
  if (!ok) throw new Error(message)
}
let conversationId = ''
let historyId = ''
try {
  const unauthorized = await fetch(`${base}/api/agent/conversations`)
  ensure(unauthorized.status === 401, 'unauthenticated Agent request was not rejected')
  const created = await request('/api/agent/conversations', {
    method: 'POST',
    body: JSON.stringify({ title: 'Synthetic workspace test' }),
  })
  ensure(created.status === 201, 'conversation creation failed')
  const conversation = (await created.json()) as { id: string }
  conversationId = conversation.id
  const listed = await request('/api/agent/conversations')
  ensure(
    ((await listed.json()) as { conversations: Array<{ id: string }> }).conversations.some(
      (item) => item.id === conversationId,
    ),
    'conversation list did not recover persisted conversation',
  )
  const answer = await request(`/api/agent/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: 'What is this synthetic test about?' }),
  })
  ensure([200, 503].includes(answer.status), 'Agent message endpoint returned an unexpected error')
  const body = (await answer.json()) as { status?: string; content?: string }
  ensure(
    body.status === 'failed' && typeof body.content === 'string',
    'Agent did not save an explicit unavailable/insufficient-evidence state',
  )
  const restored = await request(`/api/agent/conversations/${conversationId}`)
  const messages = (
    (await restored.json()) as { messages: Array<{ role: string; status: string }> }
  ).messages
  ensure(
    messages.length === 2 && messages[1]?.status === 'failed',
    'conversation history did not restore both turns',
  )
  const streamed = await request(`/api/agent/conversations/${conversationId}/messages/stream`, {
    method: 'POST',
    headers: { accept: 'text/event-stream' },
    body: JSON.stringify({ content: 'Answer using only available evidence.' }),
  })
  const streamText = await streamed.text()
  ensure(
    streamed.status === 200 && streamText.includes('event: error'),
    'stream endpoint did not emit the safely configured provider failure',
  )
  ensure(
    !streamText.includes('GEMINI_API_KEY') && !streamText.includes('api_key'),
    'stream error exposed provider configuration secrets',
  )
  const messagePage = await request(`/api/agent/conversations/${conversationId}/messages?limit=1`)
  const page = (await messagePage.json()) as {
    messages: Array<{ id: string }>
    messagesNextCursor: string | null
  }
  ensure(
    page.messages.length === 1 && page.messagesNextCursor !== null,
    'message pagination did not return the next cursor',
  )
  const saved = await request('/api/search/history', {
    method: 'POST',
    body: JSON.stringify({ query: 'synthetic history smoke test', resultCount: 0 }),
  })
  ensure(saved.status === 201, 'search history insert failed')
  historyId = ((await saved.json()) as { id: string }).id
  const history = await request('/api/search/history')
  ensure(
    ((await history.json()) as { history: Array<{ id: string }> }).history.some(
      (item) => item.id === historyId,
    ),
    'search history list failed',
  )
  const documents = await request('/api/documents')
  ensure(
    documents.status === 200 &&
      Array.isArray(((await documents.json()) as { documents: unknown[] }).documents),
    'document library list failed',
  )
  console.log(
    'Workspace integration passed: auth rejection, persisted conversations, safe unavailable-provider SSE, message pagination, search history, and document listing.',
  )
} finally {
  if (historyId) await request(`/api/search/history/${historyId}`, { method: 'DELETE' })
  if (conversationId)
    await request(`/api/agent/conversations/${conversationId}`, { method: 'DELETE' })
}
