import { createHmac, randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { parse } from 'dotenv'

const env = parse(await readFile('.env.docker'))
const secret = env.SITEPILOT_JWT_SECRET
if (!secret || secret.length < 32) throw new Error('Configured backend JWT secret is unavailable')

const statePath =
  process.env.SITEPILOT_PERSISTENCE_STATE ?? '/private/tmp/sitepilot-agent-persistence.json'
const base = `http://127.0.0.1:${process.env.SITEPILOT_API_PORT ?? '3210'}`
const phase = process.argv[2]
const priorState =
  phase === 'verify'
    ? (JSON.parse(await readFile(statePath, 'utf8')) as {
        identity: string
        conversationId: string
        historyId: string
      })
    : undefined
const id = priorState?.identity ?? `agent_persist_${randomUUID().replaceAll('-', '')}`
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const header = encode({ alg: 'HS256', typ: 'JWT' })
const payload = encode({
  aud: 'sitepilot-upload',
  sub: id,
  tenant_id: id,
  sitepilot_group_id: id,
  groups: [id],
  exp: Math.floor(Date.now() / 1000) + 900,
})
const token = `${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
const request = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } })
const ensure = (ok: boolean, message: string) => {
  if (!ok) throw new Error(message)
}

if (phase === 'create') {
  const existing = await readFile(statePath).then(
    () => true,
    () => false,
  )
  ensure(!existing, 'A previous synthetic persistence fixture must be verified or cleaned first')
  const conversationResponse = await request('/api/agent/conversations', {
    method: 'POST',
    body: JSON.stringify({ title: 'Synthetic restart persistence fixture' }),
  })
  ensure(conversationResponse.status === 201, 'Could not create the synthetic conversation')
  const conversation = (await conversationResponse.json()) as { id: string }
  const historyResponse = await request('/api/search/history', {
    method: 'POST',
    body: JSON.stringify({ query: 'synthetic restart persistence query', resultCount: 0 }),
  })
  ensure(historyResponse.status === 201, 'Could not create the synthetic search history row')
  const history = (await historyResponse.json()) as { id: string }
  await writeFile(
    statePath,
    JSON.stringify({ identity: id, conversationId: conversation.id, historyId: history.id }),
    {
      mode: 0o600,
      flag: 'wx',
    },
  )
  console.log(
    'Synthetic conversation and search history created for the restart persistence check.',
  )
} else if (phase === 'verify') {
  const state = priorState!
  let verified = false
  try {
    const conversationResponse = await request(
      `/api/agent/conversations/${encodeURIComponent(state.conversationId)}`,
    )
    const conversation = (await conversationResponse.json()) as { id?: string; title?: string }
    ensure(
      conversationResponse.ok && conversation.id === state.conversationId,
      'Conversation was not available after container restart',
    )
    const historyResponse = await request('/api/search/history?limit=100')
    const history = (await historyResponse.json()) as {
      history?: Array<{ id: string; query: string }>
    }
    ensure(
      historyResponse.ok &&
        Boolean(
          history.history?.some(
            (item) =>
              item.id === state.historyId && item.query === 'synthetic restart persistence query',
          ),
        ),
      'Search history was not available after container restart',
    )
    verified = true
    console.log('Synthetic conversation and search history survived the container restart.')
  } finally {
    if (verified) {
      await request(`/api/search/history/${encodeURIComponent(state.historyId)}`, {
        method: 'DELETE',
      })
      await request(`/api/agent/conversations/${encodeURIComponent(state.conversationId)}`, {
        method: 'DELETE',
      })
      await unlink(statePath).catch(() => {})
    }
  }
} else {
  throw new Error('Usage: tsx scripts/sitepilot-agent-persistence.integration.mts create|verify')
}
