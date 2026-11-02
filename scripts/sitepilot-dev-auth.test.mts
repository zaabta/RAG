import { createServer as createHttpServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { authenticateUploadToken } from '../src/sitepilot/api/sitepilot-upload-server.mjs'
import { createDevAuthServer, issueDevelopmentToken, validateDevAuthConfig, type DevelopmentIdentity } from './sitepilot-dev-auth.mjs'

const SECRET = 'local-development-test-secret-with-more-than-32-characters'
const identity: DevelopmentIdentity = { id: 'test-user-a', label: 'Test User A', tenantId: 'tenant_a', userId: 'user_a', groupId: 'group_a' }
const servers: Array<ReturnType<typeof createHttpServer>> = []
async function listen(server: ReturnType<typeof createHttpServer>): Promise<string> {
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))) })

describe('local development auth issuer', () => {
  it('refuses disabled and production configurations', () => {
    expect(() => validateDevAuthConfig({ secret: SECRET, identities: [identity], allowedOrigins: ['http://127.0.0.1:5173'], enabled: false })).toThrow('requires SITEPILOT_ENABLE_DEV_AUTH=true')
    expect(() => validateDevAuthConfig({ secret: SECRET, identities: [identity], allowedOrigins: ['http://127.0.0.1:5173'], enabled: true, nodeEnv: 'production' })).toThrow('disabled in production')
  })
  it('issues only allowlisted tenant, user, and group claims with a short expiry', () => {
    const now = 1_800_000_000
    const result = issueDevelopmentToken(SECRET, identity, now)
    const verified = authenticateUploadToken(`Bearer ${result.accessToken}`, SECRET, now)
    expect(verified).toEqual({ tenantId: 'tenant_a', userId: 'user_a', groupId: 'group_a' })
    expect(result.expiresAt).toBe((now + 600) * 1000)
    expect(() => authenticateUploadToken(`Bearer ${result.accessToken}`, SECRET, now + 601)).toThrow('TOKEN_EXPIRED')
  })
  it('lists configured identities and rejects unallowlisted identity requests', async () => {
    const server = createDevAuthServer({ secret: SECRET, identities: [identity], allowedOrigins: ['http://127.0.0.1:5173'], enabled: true, nodeEnv: 'test' })
    const base = await listen(server)
    const listed = await fetch(`${base}/__dev/auth/identities`)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({ identities: [identity] })
    const login = await fetch(`${base}/__dev/auth/login`, { method: 'POST', headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' }, body: JSON.stringify({ identityId: 'other-user' }) })
    expect(login.status).toBe(403)
    expect(await login.json()).toEqual({ error: 'IDENTITY_NOT_ALLOWLISTED' })
  })
  it('issues a backend-verifiable token only for a configured identity and trusted origin', async () => {
    const server = createDevAuthServer({ secret: SECRET, identities: [identity], allowedOrigins: ['http://127.0.0.1:5173'], enabled: true, nodeEnv: 'test' })
    const base = await listen(server)
    const denied = await fetch(`${base}/__dev/auth/login`, { method: 'POST', headers: { origin: 'http://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify({ identityId: identity.id }) })
    expect(denied.status).toBe(403)
    const response = await fetch(`${base}/__dev/auth/login`, { method: 'POST', headers: { origin: 'http://127.0.0.1:5173', 'content-type': 'application/json' }, body: JSON.stringify({ identityId: identity.id }) })
    const value = await response.json() as { accessToken: string; expiresAt: number; identity: DevelopmentIdentity }
    expect(response.status).toBe(200)
    expect(authenticateUploadToken(`Bearer ${value.accessToken}`, SECRET)).toEqual({ tenantId: identity.tenantId, userId: identity.userId, groupId: identity.groupId })
    expect(value.identity.id).toBe(identity.id)
  })
})
