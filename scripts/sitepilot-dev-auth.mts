import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'dotenv'

export interface DevelopmentIdentity {
  id: string
  label: string
  tenantId: string
  userId: string
  groupId: string
}
export interface DevAuthConfig {
  secret: string
  identities: DevelopmentIdentity[]
  allowedOrigins: string[]
  enabled: boolean
  nodeEnv?: string
  port?: number
  host?: string
  now?: () => number
}
const TOKEN_TTL_SECONDS = 10 * 60
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function validateDevAuthConfig(config: DevAuthConfig): void {
  if (!config.enabled) throw new Error('Development auth requires SITEPILOT_ENABLE_DEV_AUTH=true')
  if ((config.nodeEnv ?? process.env.NODE_ENV) === 'production') throw new Error('Development auth is disabled in production')
  if (config.secret.length < 32) throw new Error('The backend JWT secret is invalid')
  if (!config.identities.length) throw new Error('No authorized development identities are configured')
  if (!config.allowedOrigins.length) throw new Error('At least one local frontend origin is required')
  const ids = new Set<string>()
  for (const identity of config.identities) {
    if (!identity.id || ids.has(identity.id) || !identity.label ||
      ![identity.tenantId, identity.userId, identity.groupId].every((part) => ID_PATTERN.test(part))) {
      throw new Error('The development identity allowlist is invalid')
    }
    ids.add(identity.id)
  }
  for (const origin of config.allowedOrigins) {
    const parsed = new URL(origin)
    if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new Error('Development auth origins must be loopback origins')
    }
  }
}

export function issueDevelopmentToken(secret: string, identity: DevelopmentIdentity, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (secret.length < 32) throw new Error('The backend JWT secret is invalid')
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const payload = encode({
    aud: 'sitepilot-upload',
    sub: identity.userId,
    tenant_id: identity.tenantId,
    sitepilot_group_id: identity.groupId,
    groups: [identity.groupId],
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  })
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return { accessToken: `${header}.${payload}.${signature}`, expiresAt: (nowSeconds + TOKEN_TTL_SECONDS) * 1000 }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  response.end(JSON.stringify(value))
}
function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}
async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > 4096) throw Object.assign(new Error('BODY_TOO_LARGE'), { status: 413 })
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw Object.assign(new Error('INVALID_JSON'), { status: 400 }) }
}

export function createDevAuthServer(config: DevAuthConfig): Server {
  validateDevAuthConfig(config)
  const allowedOrigins = new Set(config.allowedOrigins)
  const identities = new Map(config.identities.map((identity) => [identity.id, identity]))
  const attempts = new Map<string, { count: number; until: number }>()
  const now = config.now ?? Date.now
  const server = createServer(async (request, response) => {
    if (!isLoopbackAddress(request.socket.remoteAddress)) { send(response, 403, { error: 'LOOPBACK_ONLY' }); return }
    const origin = request.headers.origin
    if (origin && !allowedOrigins.has(origin)) { send(response, 403, { error: 'ORIGIN_NOT_ALLOWED' }); return }
    if (request.headers['sec-fetch-site'] === 'cross-site') { send(response, 403, { error: 'CROSS_SITE_REQUEST_DENIED' }); return }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method === 'GET' && url.pathname === '/__dev/auth/identities') {
      send(response, 200, { identities: config.identities })
      return
    }
    if (request.method === 'POST' && url.pathname === '/__dev/auth/login') {
      if (!origin || !allowedOrigins.has(origin)) { send(response, 403, { error: 'ORIGIN_REQUIRED' }); return }
      const ip = request.socket.remoteAddress ?? 'unknown'
      const current = attempts.get(ip)
      if (current && current.until > now() && current.count >= 10) { send(response, 429, { error: 'DEV_AUTH_RATE_LIMITED' }); return }
      attempts.set(ip, current && current.until > now() ? { ...current, count: current.count + 1 } : { count: 1, until: now() + 60_000 })
      try {
        if (!(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          send(response, 415, { error: 'JSON_REQUIRED' }); return
        }
        const body = await readJson(request) as { identityId?: unknown }
        if (!body || typeof body.identityId !== 'string') { send(response, 400, { error: 'IDENTITY_REQUIRED' }); return }
        const identity = identities.get(body.identityId)
        if (!identity) {
          send(response, 403, { error: 'IDENTITY_NOT_ALLOWLISTED' }); return
        }
        send(response, 200, { ...issueDevelopmentToken(config.secret, identity, Math.floor(now() / 1000)), identity })
      } catch (error) {
        const status = typeof error === 'object' && error !== null && 'status' in error ? Number((error as { status: unknown }).status) : 400
        const code = error instanceof Error ? error.message : 'INVALID_REQUEST'
        send(response, status, { error: code })
      }
      return
    }
    send(response, 404, { error: 'NOT_FOUND' })
  })
  return server
}

async function main(): Promise<void> {
  if (process.env.SITEPILOT_ENABLE_DEV_AUTH !== 'true') throw new Error('Set SITEPILOT_ENABLE_DEV_AUTH=true to start the local development issuer')
  if (process.env.NODE_ENV === 'production') throw new Error('Development auth is disabled in production')
  const envPath = resolve(process.env.SITEPILOT_DEV_AUTH_ENV_FILE ?? '.env.docker')
  const fileValues = parse(await readFile(envPath, 'utf8'))
  const secret = process.env.SITEPILOT_JWT_SECRET ?? fileValues.SITEPILOT_JWT_SECRET
  const rawIdentities = process.env.SITEPILOT_DEV_AUTH_IDENTITIES
  if (!rawIdentities) throw new Error('Set SITEPILOT_DEV_AUTH_IDENTITIES to an operator-approved JSON identity allowlist')
  let identities: DevelopmentIdentity[]
  try { identities = JSON.parse(rawIdentities) as DevelopmentIdentity[] }
  catch { throw new Error('SITEPILOT_DEV_AUTH_IDENTITIES must be valid JSON') }
  const origins = (process.env.SITEPILOT_DEV_AUTH_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((value) => value.trim()).filter(Boolean)
  const port = Number(process.env.SITEPILOT_DEV_AUTH_PORT ?? 3211)
  const server = createDevAuthServer({ secret: secret ?? '', identities, allowedOrigins: origins, enabled: true, nodeEnv: process.env.NODE_ENV })
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Local development auth issuer listening on 127.0.0.1:${port}\n`))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : 'Development auth failed'}\n`); process.exitCode = 1 })
}
