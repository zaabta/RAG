import { createHash, createHmac } from 'node:crypto'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'

import {
  authenticateUploadToken,
  UploadRequestError,
  resolveStoredUploadPath,
  readVerifiedUpload,
  validateXlsxArchive,
} from '../src/sitepilot/api/sitepilot-upload-server.mjs'

const SECRET = 'sitepilot-upload-unit-test-secret-which-is-over-32-bytes'

function token(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

function validClaims(now = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  return {
    aud: 'sitepilot-upload',
    sub: 'test_user',
    tenant_id: 'test_tenant',
    sitepilot_group_id: 'test_group',
    groups: ['test_group'],
    exp: now + 60,
  }
}

async function xlsxFixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('Synthetic')
  worksheet.addRow(['FORM NO', 'AÇIKLAMA'])
  worksheet.addRow([1, 'Sanitized fixture only'])
  return Buffer.from(await workbook.xlsx.writeBuffer())
}

describe('SitePilot upload authentication and XLSX safety', () => {
  it('derives tenant, group, and user identity only from a valid signed JWT', () => {
    const identity = authenticateUploadToken(`Bearer ${token(validClaims())}`, SECRET)
    expect(identity).toEqual({
      tenantId: 'test_tenant',
      groupId: 'test_group',
      userId: 'test_user',
    })
  })

  it('rejects invalid, expired, and ungrouped tokens', () => {
    expect(() => authenticateUploadToken(undefined, SECRET)).toThrowError(UploadRequestError)
    expect(() =>
      authenticateUploadToken(`Bearer ${token(validClaims(Date.now() / 1000 - 120))}`, SECRET),
    ).toThrow('TOKEN_EXPIRED')
    const ungrouped = { ...validClaims(), groups: [] }
    expect(() => authenticateUploadToken(`Bearer ${token(ungrouped)}`, SECRET)).toThrow(
      'UPLOAD_ACCESS_DENIED',
    )
    const valid = token(validClaims())
    const [header, payload, signature] = valid.split('.')
    const tamperedSignature = `${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`
    expect(() => authenticateUploadToken(`Bearer ${header}.${payload}.${tamperedSignature}`, SECRET))
      .toThrow('INVALID_TOKEN')
  })

  it('accepts a structurally valid XLSX without reading cell values into logs', async () => {
    const stats = validateXlsxArchive(await xlsxFixture())
    expect(stats.entries).toBeGreaterThan(0)
    expect(stats.worksheetCount).toBe(1)
    expect(stats.uncompressedBytes).toBeGreaterThan(stats.compressedBytes)
  })

  it('rejects non-ZIP data and archives with an oversized entry', async () => {
    expect(() => validateXlsxArchive(Buffer.from('not an excel archive'))).toThrow(
      'INVALID_XLSX_ARCHIVE',
    )
    const bytes = await xlsxFixture()
    const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
    const centralDirectory = bytes.indexOf(signature)
    expect(centralDirectory).toBeGreaterThanOrEqual(0)
    bytes.writeUInt32LE(51 * 1024 * 1024, centralDirectory + 24)
    expect(() => validateXlsxArchive(bytes)).toThrow('ARCHIVE_ENTRY_TOO_LARGE')
  })

  it('verifies durable upload paths and checksums before parsing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sitepilot-upload-path-test-'))
    try {
      const jobDir = join(root, 'job')
      await mkdir(jobDir, { mode: 0o700 })
      const path = join(jobDir, 'source.xlsx')
      const bytes = Buffer.from('synthetic upload bytes')
      await writeFile(path, bytes, { mode: 0o600 })
      const hash = createHash('sha256').update(bytes).digest('hex')
      await expect(readVerifiedUpload(path, root, hash)).resolves.toEqual(bytes)
      await expect(readVerifiedUpload(path, root, '0'.repeat(64))).rejects.toThrow(
        'UPLOAD_CHECKSUM_MISMATCH',
      )
      await expect(readVerifiedUpload(join(jobDir, 'missing.xlsx'), root, hash)).rejects.toThrow(
        'UPLOAD_FILE_MISSING',
      )
      const outside = join(root, 'outside.xlsx')
      await writeFile(outside, bytes)
      const link = join(jobDir, 'linked.xlsx')
      await symlink(outside, link)
      await expect(readVerifiedUpload(link, root, hash)).rejects.toThrow('UPLOAD_FILE_MISSING')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves shared-volume storage keys and rejects traversal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sitepilot-upload-volume-test-'))
    try {
      const key = 'sitepilot-upload-test/source.xlsx'
      expect(resolveStoredUploadPath(root, key)).toBe(join(root, key))
      expect(
        resolveStoredUploadPath(root, '/previous-host/storage/sitepilot-upload-legacy/source.xlsx'),
      ).toBe(join(root, 'sitepilot-upload-legacy/source.xlsx'))
      expect(() => resolveStoredUploadPath(root, '../outside.xlsx')).toThrow('UPLOAD_FILE_MISSING')
      expect(() => resolveStoredUploadPath(root, '/etc/passwd')).toThrow('UPLOAD_FILE_MISSING')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
