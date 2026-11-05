import { createHmac, createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  realpath,
  rm,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

import 'dotenv/config'
import { typegraphInit } from '@typegraph-ai/sdk'

import { parseExcelFile } from '../excel/sitepilot-excel-core.mjs'
import { syncParsedExcelWorkbook } from '../excel/sitepilot-excel-pipeline.mjs'
import { selectAgentTools, SitePilotWorkspace } from '../agent/sitepilot-workspace.mjs'
import {
  SITEPILOT_EXCEL_BUCKET_ID,
  createSitePilotExcelConfig,
  type SitePilotIdentity,
} from '../excel/sitepilot-excel-config.mjs'
import {
  SitePilotUploadJobs,
  type ClaimedUploadJob,
  type UploadJobIdentity,
  type UploadJobStage,
  stableUploadFileId,
} from '../documents/sitepilot-upload-jobs.mjs'
import { parseTextDocument } from '../documents/sitepilot-document-parser.mjs'
import { indexParsedDocument } from '../documents/sitepilot-document-pipeline.mjs'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_BATCH_FILES = 4
const MAX_BATCH_MULTIPART_BYTES = MAX_UPLOAD_BYTES * 2 + 2 * 1024 * 1024
const MAX_MULTIPART_BYTES = MAX_BATCH_MULTIPART_BYTES
const MAX_ZIP_ENTRIES = 1000
const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
const MAX_ZIP_ENTRY_BYTES = 50 * 1024 * 1024
const MAX_COMPRESSION_RATIO = 200
const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

export class UploadRequestError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'UploadRequestError'
  }
}

export async function readVerifiedUpload(
  filePath: string,
  storageDirectory: string,
  expectedSha256: string,
): Promise<Buffer> {
  try {
    const storageRealPath = await realpath(storageDirectory)
    const uploadRealPath = await realpath(filePath)
    const uploadStat = await lstat(filePath)
    const uploadRelativePath = relative(storageRealPath, uploadRealPath)
    if (
      uploadStat.isSymbolicLink() ||
      !uploadStat.isFile() ||
      uploadRelativePath.startsWith(`..${sep}`) ||
      uploadRelativePath === '..' ||
      isAbsolute(uploadRelativePath)
    )
      throw new UploadRequestError(400, 'UPLOAD_FILE_MISSING')
    const bytes = await readFile(uploadRealPath)
    if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256)
      throw new UploadRequestError(422, 'UPLOAD_CHECKSUM_MISMATCH')
    return bytes
  } catch (error) {
    if (error instanceof UploadRequestError) throw error
    throw new UploadRequestError(400, 'UPLOAD_FILE_MISSING')
  }
}

export function resolveStoredUploadPath(storageDirectory: string, storageKey: string): string {
  // Older queued rows contain an absolute path. Continue to accept them only
  // when they resolve beneath this storage root or can be rebased by their
  // generated upload-directory suffix after copying into the named volume.
  let resolved = isAbsolute(storageKey)
    ? resolve(storageKey)
    : resolve(storageDirectory, storageKey)
  let relativePath = relative(resolve(storageDirectory), resolved)
  if (
    isAbsolute(storageKey) &&
    (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath))
  ) {
    const suffix = storageKey.match(
      /(?:^|[\\/])(sitepilot-upload-[A-Za-z0-9_-]+)[\\/]source\.(xlsx|docx|txt|md)$/i,
    )
    if (suffix) {
      resolved = resolve(storageDirectory, suffix[1]!, `source.${suffix[2]!.toLowerCase()}`)
      relativePath = relative(resolve(storageDirectory), resolved)
    }
  }
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    throw new UploadRequestError(400, 'UPLOAD_FILE_MISSING')
  }
  return resolved
}

export interface AuthenticatedUploadIdentity extends UploadJobIdentity {}

interface JwtClaims {
  aud?: unknown
  sub?: unknown
  tenant_id?: unknown
  sitepilot_group_id?: unknown
  groups?: unknown
  exp?: unknown
  nbf?: unknown
}

function base64UrlJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

export function authenticateUploadToken(
  authorization: string | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): AuthenticatedUploadIdentity {
  if (!authorization?.startsWith('Bearer '))
    throw new UploadRequestError(401, 'AUTHENTICATION_REQUIRED')
  const token = authorization.slice(7).trim()
  const parts = token.split('.')
  if (parts.length !== 3 || secret.length < 32) throw new UploadRequestError(401, 'INVALID_TOKEN')
  let header: unknown
  let claims: JwtClaims
  try {
    header = base64UrlJson(parts[0]!)
    claims = base64UrlJson(parts[1]!) as JwtClaims
  } catch {
    throw new UploadRequestError(401, 'INVALID_TOKEN')
  }
  if (!header || typeof header !== 'object' || (header as { alg?: string }).alg !== 'HS256') {
    throw new UploadRequestError(401, 'INVALID_TOKEN')
  }
  const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest()
  const actual = Buffer.from(parts[2]!, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new UploadRequestError(401, 'INVALID_TOKEN')
  }
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) {
    throw new UploadRequestError(401, 'TOKEN_EXPIRED')
  }
  if (typeof claims.nbf === 'number' && claims.nbf > nowSeconds) {
    throw new UploadRequestError(401, 'TOKEN_NOT_YET_VALID')
  }
  const tenantId = typeof claims.tenant_id === 'string' ? claims.tenant_id : ''
  const userId = typeof claims.sub === 'string' ? claims.sub : ''
  const groupId = typeof claims.sitepilot_group_id === 'string' ? claims.sitepilot_group_id : ''
  const groups = Array.isArray(claims.groups) ? claims.groups : []
  const audiences =
    typeof claims.aud === 'string' ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : []
  if (
    !audiences.includes('sitepilot-upload') ||
    !tenantId ||
    !userId ||
    !groupId ||
    !groups.includes(groupId)
  ) {
    throw new UploadRequestError(403, 'UPLOAD_ACCESS_DENIED')
  }
  if (![tenantId, userId, groupId].every((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value))) {
    throw new UploadRequestError(403, 'INVALID_AUTHENTICATED_IDENTITY')
  }
  return { tenantId, userId, groupId }
}

export interface XlsxArchiveStats {
  entries: number
  worksheetCount: number
  uncompressedBytes: number
  compressedBytes: number
}

export function validateXlsxArchive(bytes: Buffer): XlsxArchiveStats {
  if (bytes.length < 22) throw new UploadRequestError(400, 'INVALID_XLSX_ARCHIVE')
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadRequestError(413, 'UPLOAD_TOO_LARGE')
  const lowerBound = Math.max(0, bytes.length - 65_557)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= lowerBound; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new UploadRequestError(400, 'INVALID_XLSX_ARCHIVE')
  const diskNumber = bytes.readUInt16LE(eocd + 4)
  const centralDisk = bytes.readUInt16LE(eocd + 6)
  const diskEntries = bytes.readUInt16LE(eocd + 8)
  const entryCount = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  const commentLength = bytes.readUInt16LE(eocd + 20)
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    eocd + 22 + commentLength !== bytes.length ||
    centralOffset + centralSize > eocd ||
    entryCount === 0 ||
    entryCount > MAX_ZIP_ENTRIES
  )
    throw new UploadRequestError(400, 'UNSUPPORTED_XLSX_ARCHIVE')

  let cursor = centralOffset
  let uncompressedBytes = 0
  let compressedBytes = 0
  const names = new Set<string>()
  let worksheetCount = 0
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralOffset + centralSize || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new UploadRequestError(400, 'INVALID_XLSX_ARCHIVE')
    }
    const flags = bytes.readUInt16LE(cursor + 8)
    const compressedSize = bytes.readUInt32LE(cursor + 20)
    const uncompressedSize = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const entryCommentLength = bytes.readUInt16LE(cursor + 32)
    const next = cursor + 46 + nameLength + extraLength + entryCommentLength
    if (
      next > centralOffset + centralSize ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff
    ) {
      throw new UploadRequestError(400, 'UNSUPPORTED_XLSX_ARCHIVE')
    }
    if (flags & 0x0001) throw new UploadRequestError(400, 'ENCRYPTED_ARCHIVE_NOT_ALLOWED')
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    names.add(name)
    if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) worksheetCount++
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES)
      throw new UploadRequestError(413, 'ARCHIVE_ENTRY_TOO_LARGE')
    uncompressedBytes += uncompressedSize
    compressedBytes += compressedSize
    if (uncompressedBytes > MAX_ZIP_UNCOMPRESSED_BYTES)
      throw new UploadRequestError(413, 'ARCHIVE_EXPANSION_LIMIT')
    if (
      compressedSize === 0
        ? uncompressedSize > 0
        : uncompressedSize / compressedSize > MAX_COMPRESSION_RATIO
    ) {
      throw new UploadRequestError(413, 'ARCHIVE_COMPRESSION_RATIO_LIMIT')
    }
    cursor = next
  }
  if (
    cursor !== centralOffset + centralSize ||
    !names.has('[Content_Types].xml') ||
    !names.has('xl/workbook.xml') ||
    worksheetCount === 0 ||
    worksheetCount > 100
  )
    throw new UploadRequestError(400, 'NOT_A_SUPPORTED_XLSX_WORKBOOK')
  return { entries: entryCount, worksheetCount, uncompressedBytes, compressedBytes }
}

async function readBoundedBody(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Buffer | null> {
  const contentLength = Number(request.headers['content-length'] ?? 0)
  if (contentLength > MAX_MULTIPART_BYTES) {
    request.resume()
    sendJson(response, 413, { error: 'UPLOAD_TOO_LARGE' })
    return null
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += chunk.length
    if (size > MAX_MULTIPART_BYTES) {
      request.resume()
      sendJson(response, 413, { error: 'UPLOAD_TOO_LARGE' })
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size)
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown): void {
  if (response.headersSent) return
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    size += chunk.length
    if (size > 16 * 1024) throw new UploadRequestError(413, 'REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new UploadRequestError(400, 'INVALID_JSON_BODY')
  }
}

function makeJwtClaims(
  authorization: string | undefined,
  secret: string,
): AuthenticatedUploadIdentity {
  return authenticateUploadToken(authorization, secret)
}

export function safeFileName(name: string): string {
  const clean = basename(name.replace(/\\/g, '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '_')
    .slice(0, 255)
  const extension = extname(clean).toLocaleLowerCase('en-US')
  if (extension === '.doc') throw new UploadRequestError(415, 'LEGACY_DOC_UNSUPPORTED')
  if (!clean || !['.xlsx', '.docx', '.txt', '.md'].includes(extension))
    throw new UploadRequestError(415, 'UNSUPPORTED_DOCUMENT_FORMAT')
  return clean
}

export function validateDocxArchive(bytes: Buffer) {
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadRequestError(413, 'UPLOAD_TOO_LARGE')
  const lowerBound = Math.max(0, bytes.length - 65_557)
  let eocd = -1
  for (let offset = bytes.length - 22; offset >= lowerBound; offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) throw new UploadRequestError(400, 'INVALID_DOCX_ARCHIVE')
  const disk = bytes.readUInt16LE(eocd + 4)
  const centralDisk = bytes.readUInt16LE(eocd + 6)
  const diskEntries = bytes.readUInt16LE(eocd + 8)
  const entryCount = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  const commentLength = bytes.readUInt16LE(eocd + 20)
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    eocd + 22 + commentLength !== bytes.length ||
    centralOffset + centralSize > eocd ||
    entryCount === 0 ||
    entryCount > MAX_ZIP_ENTRIES
  )
    throw new UploadRequestError(400, 'UNSUPPORTED_DOCX_ARCHIVE')

  const names = new Set<string>()
  let cursor = centralOffset
  let totalUncompressed = 0
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralOffset + centralSize || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new UploadRequestError(400, 'INVALID_DOCX_ARCHIVE')
    const flags = bytes.readUInt16LE(cursor + 8)
    const compressed = bytes.readUInt32LE(cursor + 20)
    const uncompressed = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28)
    const extraLength = bytes.readUInt16LE(cursor + 30)
    const commentLength = bytes.readUInt16LE(cursor + 32)
    const next = cursor + 46 + nameLength + extraLength + commentLength
    if (
      next > centralOffset + centralSize ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff
    )
      throw new UploadRequestError(400, 'UNSUPPORTED_DOCX_ARCHIVE')
    if (flags & 0x0001) throw new UploadRequestError(400, 'ENCRYPTED_ARCHIVE_NOT_ALLOWED')
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    if (name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))
      throw new UploadRequestError(400, 'UNSAFE_DOCX_ARCHIVE_PATH')
    names.add(name)
    if (uncompressed > MAX_ZIP_ENTRY_BYTES)
      throw new UploadRequestError(413, 'ARCHIVE_ENTRY_TOO_LARGE')
    totalUncompressed += uncompressed
    if (totalUncompressed > MAX_ZIP_UNCOMPRESSED_BYTES)
      throw new UploadRequestError(413, 'ARCHIVE_EXPANSION_LIMIT')
    if (compressed === 0 ? uncompressed > 0 : uncompressed / compressed > MAX_COMPRESSION_RATIO)
      throw new UploadRequestError(413, 'ARCHIVE_COMPRESSION_RATIO_LIMIT')
    cursor = next
  }
  if (
    cursor !== centralOffset + centralSize ||
    !names.has('[Content_Types].xml') ||
    !names.has('word/document.xml')
  )
    throw new UploadRequestError(400, 'NOT_A_SUPPORTED_DOCX_DOCUMENT')
  return { entries: entryCount, uncompressedBytes: totalUncompressed }
}

export function validateSupportedUpload(name: string, mimeType: string, bytes: Buffer) {
  const filename = safeFileName(name)
  if (bytes.length === 0) throw new UploadRequestError(400, 'EMPTY_DOCUMENT')
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadRequestError(413, 'UPLOAD_TOO_LARGE')
  const extension = extname(filename).toLocaleLowerCase('en-US')
  const mime = mimeType.split(';', 1)[0]!.trim().toLocaleLowerCase('en-US')
  const allowedMimeTypes: Record<string, string[]> = {
    '.xlsx': [MIME_XLSX],
    '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    '.txt': ['text/plain'],
    '.md': ['text/markdown', 'text/x-markdown', 'text/plain'],
  }
  if (!allowedMimeTypes[extension]?.includes(mime))
    throw new UploadRequestError(415, 'DOCUMENT_MIME_TYPE_MISMATCH')
  if (extension === '.xlsx') validateXlsxArchive(bytes)
  else if (extension === '.docx') validateDocxArchive(bytes)
  else {
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new UploadRequestError(400, 'INVALID_UTF8_DOCUMENT')
    }
    if (!text.replace(/\u0000/gu, '').trim()) throw new UploadRequestError(400, 'EMPTY_DOCUMENT')
    if (text.includes('\u0000')) throw new UploadRequestError(400, 'BINARY_TEXT_DOCUMENT')
  }
  return { filename, extension, sizeBytes: bytes.length }
}

function formatSse(event: {
  id: string
  status: UploadJobStage
  progress: unknown
  errorCode?: string
  createdAt: string
  kind?: string
}): string {
  return `id: ${event.id}\nevent: ${event.kind ?? 'progress'}\ndata: ${JSON.stringify(event)}\n\n`
}

function integerSetting(
  value: number | undefined,
  environmentValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const configured = value ?? (environmentValue === undefined ? fallback : Number(environmentValue))
  if (!Number.isSafeInteger(configured) || configured < min || configured > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`)
  }
  return configured
}

export interface UploadServiceOptions {
  databaseUrl: string
  jwtSecret: string
  port?: number
  host?: string
  workerConcurrency?: number
  storageDirectory?: string
  leaseDurationMs?: number
  heartbeatIntervalMs?: number
  maxQueuedJobs?: number
  storageReserveBytes?: number
  testHooks?: {
    failAfterProgressStage?: UploadJobStage
    failOnAttempt?: number
  }
}

export interface RunningUploadService {
  server: Server
  port: number
  close(): Promise<void>
}

export async function startUploadService(
  options: UploadServiceOptions,
): Promise<RunningUploadService> {
  if (options.jwtSecret.length < 32)
    throw new Error('SITEPILOT_JWT_SECRET must contain at least 32 characters')
  const databaseUrl = options.databaseUrl
  const jobs = new SitePilotUploadJobs(databaseUrl)
  await jobs.migrate()
  const storageDirectory = resolve(
    options.storageDirectory ??
      process.env.FILE_STORAGE_ROOT ??
      process.env.SITEPILOT_UPLOAD_STORAGE_DIR ??
      join(process.cwd(), 'var/sitepilot-upload-storage'),
  )
  const workspace = new SitePilotWorkspace(
    databaseUrl,
    async (query, identity) => {
      const typegraph = await typegraphInit(createSitePilotExcelConfig(databaseUrl, identity))
      try {
        const result = await typegraph.search(query, {
          graph: 'public',
          buckets: [SITEPILOT_EXCEL_BUCKET_ID],
          resources: ['documents'],
          weights: { semantic: 0.6, bm25: 0.4, graph: false, recency: false },
          fusion: { method: 'rrf', k: 60 },
          limit: 5,
          explain: false,
          context: { groupId: identity.groupId, userId: identity.userId },
        })
        const ids = result.results.chunks
          .map((hit) => hit.metadata.fileId)
          .filter((value): value is string => typeof value === 'string')
        const visible = await jobs.visibleUploadFileIds(identity, ids)
        return result.results.chunks
          .filter(
            (hit) =>
              typeof hit.metadata.fileId !== 'string' ||
              !visible.known.has(hit.metadata.fileId) ||
              visible.active.has(hit.metadata.fileId),
          )
          .slice(0, 5)
          .map((hit) => ({
            content: hit.content,
            score: hit.score,
            citation: {
              source: String(hit.metadata.sourceFile ?? hit.metadata.fileName ?? 'Source document'),
              sheet: typeof hit.metadata.sheetName === 'string' ? hit.metadata.sheetName : null,
              rowStart: typeof hit.metadata.rowStart === 'number' ? hit.metadata.rowStart : null,
              rowEnd: typeof hit.metadata.rowEnd === 'number' ? hit.metadata.rowEnd : null,
              sourceRange:
                typeof hit.metadata.sourceRange === 'string' ? hit.metadata.sourceRange : null,
              section: Array.isArray(hit.metadata.headingPath)
                ? hit.metadata.headingPath.filter(Boolean).join(' > ')
                : null,
              lineStart: typeof hit.metadata.lineStart === 'number' ? hit.metadata.lineStart : null,
              lineEnd: typeof hit.metadata.lineEnd === 'number' ? hit.metadata.lineEnd : null,
              paragraphStart:
                typeof hit.metadata.paragraphStart === 'number'
                  ? hit.metadata.paragraphStart
                  : null,
              paragraphEnd:
                typeof hit.metadata.paragraphEnd === 'number' ? hit.metadata.paragraphEnd : null,
            },
          }))
      } finally {
        await typegraph.destroy()
      }
    },
    storageDirectory,
    undefined,
    selectAgentTools,
  )
  const leaseDurationMs = integerSetting(
    options.leaseDurationMs,
    process.env.SITEPILOT_UPLOAD_LEASE_MS,
    120_000,
    15_000,
    3_600_000,
    'SITEPILOT_UPLOAD_LEASE_MS',
  )
  const heartbeatIntervalMs = Math.min(
    Math.floor(leaseDurationMs / 3),
    integerSetting(
      options.heartbeatIntervalMs,
      process.env.SITEPILOT_UPLOAD_HEARTBEAT_MS,
      20_000,
      1_000,
      1_200_000,
      'SITEPILOT_UPLOAD_HEARTBEAT_MS',
    ),
  )
  const maxQueuedJobs = integerSetting(
    options.maxQueuedJobs,
    process.env.SITEPILOT_UPLOAD_MAX_QUEUED,
    50,
    1,
    1_000,
    'SITEPILOT_UPLOAD_MAX_QUEUED',
  )
  const storageReserveBytes = integerSetting(
    options.storageReserveBytes,
    process.env.SITEPILOT_UPLOAD_STORAGE_RESERVE_BYTES,
    128 * 1024 * 1024,
    16 * 1024 * 1024,
    1024 * 1024 * 1024 * 1024,
    'SITEPILOT_UPLOAD_STORAGE_RESERVE_BYTES',
  )
  // Original user uploads are retained indefinitely by default. Automatic deletion
  // requires an explicit SITEPILOT_DELETE_ORIGINALS_AFTER_HOURS policy.
  const retentionHours = process.env.SITEPILOT_DELETE_ORIGINALS_AFTER_HOURS
    ? integerSetting(
        undefined,
        process.env.SITEPILOT_DELETE_ORIGINALS_AFTER_HOURS,
        0,
        1,
        8_760,
        'SITEPILOT_DELETE_ORIGINALS_AFTER_HOURS',
      )
    : 0
  await mkdir(storageDirectory, { recursive: true, mode: 0o700 })
  await chmod(storageDirectory, 0o700)
  const expiredStorageKeys = retentionHours
    ? await jobs.clearExpiredTerminalStorageKeys(retentionHours * 60 * 60_000)
    : []
  for (const key of expiredStorageKeys) await removeProtectedTemp(key, storageDirectory)
  await cleanupOrphanedUploads(storageDirectory, jobs)
  let stopping = false
  let leaseRenewalFailures = 0
  let activeUploadRequests = 0
  let activeSseStreams = 0
  let didInjectFault = false
  const workerPromises: Promise<void>[] = []
  let lastRetentionCleanupAt = Date.now()

  async function processJob(job: ClaimedUploadJob): Promise<void> {
    console.log('Upload job claimed:', { jobId: job.job_id, attempt: job.attempt_count })
    let processingStage = 'read_upload'
    const identity: SitePilotIdentity = {
      tenantId: job.tenant_id,
      groupId: job.group_id,
      userId: job.user_id,
    }
    const progress = async (stage: UploadJobStage, processed: number, total: number | null) => {
      if (leaseLost) throw new Error('Job lease was lost')
      await jobs.updateProgress(job, stage, processed, total)
      if (
        !didInjectFault &&
        options.testHooks?.failAfterProgressStage === stage &&
        (options.testHooks.failOnAttempt === undefined ||
          options.testHooks.failOnAttempt === job.attempt_count)
      ) {
        didInjectFault = true
        throw new Error('Injected integration failure')
      }
    }
    let heartbeat: Worker | undefined
    let leaseLost = false
    let heartbeatErrorCode: string | undefined
    let successfulHeartbeats = 0
    try {
      if (!job.temp_path) throw new UploadRequestError(400, 'UPLOAD_FILE_MISSING')
      const uploadPath = resolveStoredUploadPath(storageDirectory, job.temp_path)
      const bytes = await readVerifiedUpload(uploadPath, storageDirectory, job.file_sha256)
      heartbeat = new Worker(
        new URL('../workers/sitepilot-upload-heartbeat.mjs', import.meta.url),
        {
          workerData: {
            databaseUrl,
            jobId: job.job_id,
            leaseOwner: job.lease_owner,
            leaseToken: job.lease_token,
            leaseGeneration: job.lease_generation,
            leaseDurationMs,
            heartbeatIntervalMs,
          },
        },
      )
      heartbeat.on('message', (message: { type?: string; code?: string }) => {
        if (message.type === 'lost') leaseLost = true
        if (message.type === 'error') {
          leaseRenewalFailures++
          heartbeatErrorCode = message.code ?? 'HEARTBEAT_ERROR'
        }
        if (message.type === 'renewed') successfulHeartbeats++
      })
      heartbeat.on('error', (error) => {
        leaseLost = true
        leaseRenewalFailures++
        heartbeatErrorCode =
          error.name === 'Error' ? 'HEARTBEAT_WORKER_ERROR' : 'HEARTBEAT_WORKER_START_FAILED'
      })
      const fileId = stableUploadFileId(job.tenant_id, job.group_id, job.file_sha256)
      const extension = extname(job.original_name).toLocaleLowerCase('en-US')
      let completion: Record<string, unknown>
      if (extension === '.xlsx') {
        validateXlsxArchive(bytes)
        let workbook
        try {
          processingStage = 'parse_workbook'
          await progress('parsing', 0, null)
          workbook = await parseExcelFile(uploadPath, {
            fileId,
            fileName: job.original_name,
            accessScope: `group:${job.group_id}`,
            maxFileBytes: MAX_UPLOAD_BYTES,
          })
        } catch {
          throw new UploadRequestError(422, 'INVALID_OR_UNSUPPORTED_WORKBOOK')
        }
        await progress('parsing', 1, 1)
        console.log('Upload workbook parsed:', {
          jobId: job.job_id,
          sheets: workbook.sheets.length,
          records: workbook.totalRecords,
          chunks: workbook.totalChunks,
        })
        await progress('chunking', workbook.totalChunks, workbook.totalChunks)
        await progress('structured_import', 0, workbook.totalRecords)
        const result = await syncParsedExcelWorkbook(
          workbook,
          databaseUrl,
          identity,
          async (stage, processed, total) => {
            await progress(stage, processed, total)
          },
        )
        completion = {
          sheetCount: workbook.sheets.length,
          recordCount: workbook.totalRecords,
          chunkCount: workbook.totalChunks,
          indexedRecords: result.indexed,
          fileId,
        }
      } else {
        if (extension === '.docx') validateDocxArchive(bytes)
        else if (extension === '.doc') throw new UploadRequestError(415, 'LEGACY_DOC_UNSUPPORTED')
        else if (extension !== '.txt' && extension !== '.md')
          throw new UploadRequestError(415, 'UNSUPPORTED_DOCUMENT_FORMAT')
        processingStage = 'parse_document'
        await progress('parsing', 0, null)
        let parsed
        try {
          parsed = await parseTextDocument(bytes, { fileId, fileName: job.original_name })
        } catch (error) {
          const code = error instanceof Error ? error.message : 'INVALID_DOCUMENT'
          throw new UploadRequestError(
            422,
            /^[A-Z0-9_]{2,64}$/.test(code) ? code : 'INVALID_DOCUMENT',
          )
        }
        await progress('parsing', 1, 1)
        await progress('chunking', parsed.chunks.length, parsed.chunks.length)
        await progress('embedding', 0, parsed.chunks.length)
        processingStage = 'index_document'
        const result = await indexParsedDocument(
          parsed,
          databaseUrl,
          identity,
          async (stage, processed, total) => progress(stage, processed, total),
        )
        completion = {
          sheetCount: 0,
          recordCount: 1,
          chunkCount: parsed.chunks.length,
          indexedRecords: result.indexed,
          fileId,
          fileType: parsed.fileType,
        }
      }
      console.log('Upload TypeGraph sync finished:', {
        jobId: job.job_id,
        indexed: completion.indexedRecords,
      })
      const completedStorageKey = await jobs.complete(job, completion)
      if (!completedStorageKey) throw new Error('Job lease was lost before publication')
      console.log('Upload job completed:', {
        jobId: job.job_id,
        heartbeatRenewals: successfulHeartbeats,
        heartbeatErrorCode,
      })
    } catch (error) {
      const validation = error instanceof UploadRequestError
      const code = validation ? error.code : 'PROCESSING_FAILED'
      console.error('Upload job processing stopped:', {
        jobId: job.job_id,
        stage: processingStage,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        retryable: !validation,
        heartbeatRenewals: successfulHeartbeats,
        failureCode: validation
          ? error.code
          : error instanceof Error && error.message === 'Job lease was lost'
            ? 'LEASE_LOST'
            : error instanceof Error && error.message === 'Job lease was lost before publication'
              ? 'LEASE_LOST_BEFORE_PUBLICATION'
              : 'PROCESSING_FAILED',
        heartbeatErrorCode,
      })
      await jobs.failOrRetry(job, code, !validation)
    } finally {
      if (heartbeat) {
        heartbeat.postMessage({ type: 'stop' })
        await new Promise<void>((resolveStop) => {
          const timeout = setTimeout(() => {
            void heartbeat?.terminate()
            resolveStop()
          }, 2_000)
          heartbeat!.once('exit', () => {
            clearTimeout(timeout)
            resolveStop()
          })
        })
      }
      // Terminal originals remain in shared storage until the configured retention expires.
    }
  }

  async function workerLoop(workerId: string): Promise<void> {
    while (!stopping) {
      try {
        if (retentionHours && Date.now() - lastRetentionCleanupAt >= 60_000) {
          lastRetentionCleanupAt = Date.now()
          const expired = await jobs.clearExpiredTerminalStorageKeys(retentionHours * 60 * 60_000)
          for (const key of expired) await removeProtectedTemp(key, storageDirectory)
        }
        await jobs.failExpiredExhausted()
        // Exhausted jobs retain originals until the explicit retention policy expires.
        const job = await jobs.claimNext(workerId, leaseDurationMs)
        if (job) await processJob(job)
        else await new Promise((resolve) => setTimeout(resolve, 500))
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      const known = error instanceof UploadRequestError ? error : undefined
      sendJson(response, known?.statusCode ?? 500, {
        error: known?.code ?? 'INTERNAL_SERVER_ERROR',
      })
    })
  })

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method === 'GET' && url.pathname === '/health') {
      sendJson(response, 200, {
        status: 'ok',
        workers: workerCount,
        leaseRenewalFailures,
        ...(await jobs.metrics()),
      })
      return
    }
    const identity = makeJwtClaims(request.headers.authorization, options.jwtSecret)
    const agentStream = url.pathname.match(
      /^\/api\/agent\/conversations\/([0-9a-f-]{36})\/messages\/stream$/i,
    )
    if (request.method === 'POST' && agentStream) {
      const body = await readJsonBody(request)
      const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
      const abortController = new AbortController()
      const onClose = () => {
        if (!response.writableEnded) abortController.abort()
      }
      response.once('close', onClose)
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      })
      response.flushHeaders()
      const sseHeartbeat = setInterval(() => {
        if (!response.destroyed && !response.writableEnded) response.write(': keepalive\n\n')
      }, 15_000)
      sseHeartbeat.unref()
      const emit = (event: Parameters<Parameters<SitePilotWorkspace['streamMessage']>[4]>[0]) => {
        if (!abortController.signal.aborted && !response.destroyed)
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      try {
        await workspace.streamMessage(
          agentStream[1]!,
          input.content,
          identity,
          abortController.signal,
          emit,
        )
      } catch {
        emit({
          type: 'error',
          code: 'AGENT_REQUEST_FAILED',
          message: 'The document assistant is unavailable.',
        })
      } finally {
        clearInterval(sseHeartbeat)
        response.off('close', onClose)
        if (!response.destroyed) response.end()
      }
      return
    }
    const libraryPath =
      url.pathname === '/api/documents' ||
      /^\/api\/documents\/[0-9a-f-]{36}\/download$/i.test(url.pathname)
    if (
      url.pathname.startsWith('/api/agent/') ||
      url.pathname === '/api/agent/conversations' ||
      url.pathname.startsWith('/api/search/history') ||
      (libraryPath && request.method === 'GET')
    ) {
      const body =
        request.method === 'POST' || request.method === 'PATCH'
          ? await readJsonBody(request)
          : undefined
      const result = await workspace.handle(
        request.method ?? 'GET',
        url.pathname,
        url,
        identity,
        body,
      )
      if (result.file) {
        const safeName = result.file.name.replace(/[\r\n"\\]/g, '_')
        response.writeHead(200, {
          'content-type': MIME_XLSX,
          'content-disposition': `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(result.file.name)}`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        })
        await pipeline(createReadStream(result.file.path), response)
      } else if (result.status === 204) {
        response.writeHead(204, { 'cache-control': 'no-store' })
        response.end()
      } else sendJson(response, result.status, result.body ?? {})
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/documents/upload') {
      if (activeUploadRequests >= 4) {
        request.resume()
        sendJson(response, 429, { error: 'UPLOAD_CAPACITY_REACHED' })
        return
      }
      activeUploadRequests++
      try {
        const contentType = request.headers['content-type'] ?? ''
        if (!contentType.toLocaleLowerCase('en-US').startsWith('multipart/form-data;')) {
          request.resume()
          throw new UploadRequestError(415, 'MULTIPART_FORM_DATA_REQUIRED')
        }
        const body = await readBoundedBody(request, response)
        if (!body) return
        let form: FormData
        try {
          const webRequest = new Request('http://localhost/api/documents/upload', {
            method: 'POST',
            headers: { 'content-type': contentType },
            body: body as unknown as BodyInit,
          })
          form = await webRequest.formData()
        } catch {
          throw new UploadRequestError(400, 'INVALID_MULTIPART_BODY')
        }
        const fileParts = [...form.getAll('file'), ...form.getAll('files')]
        if (
          fileParts.length === 0 ||
          fileParts.length > MAX_BATCH_FILES ||
          fileParts.some((part) => typeof part === 'string' || !(part instanceof File))
        )
          throw new UploadRequestError(400, 'ONE_TO_FOUR_DOCUMENT_FILES_REQUIRED')
        const uploads: Array<{ originalName: string; extension: string; bytes: Buffer }> = []
        let totalBytes = 0
        for (const part of fileParts) {
          const file = part as File
          const bytes = Buffer.from(await file.arrayBuffer())
          const validated = validateSupportedUpload(file.name, file.type, bytes)
          totalBytes += bytes.length
          if (totalBytes > MAX_UPLOAD_BYTES * 2)
            throw new UploadRequestError(413, 'BATCH_UPLOAD_TOO_LARGE')
          uploads.push({ originalName: validated.filename, extension: validated.extension, bytes })
        }
        if ((await jobs.queuedCount()) + uploads.length > maxQueuedJobs)
          throw new UploadRequestError(429, 'UPLOAD_QUEUE_CAPACITY_REACHED')
        const filesystem = await statfs(storageDirectory)
        if (filesystem.bavail * filesystem.bsize < totalBytes + storageReserveBytes)
          throw new UploadRequestError(507, 'UPLOAD_STORAGE_CAPACITY_REACHED')
        const queuedJobs: Array<{
          originalName: string
          queued: Awaited<ReturnType<SitePilotUploadJobs['enqueue']>>
        }> = []
        for (const upload of uploads) {
          const directory = await mkdtemp(join(storageDirectory, 'sitepilot-upload-'))
          await chmod(directory, 0o700)
          const tempPath = join(directory, `source${upload.extension}`)
          const partialPath = `${tempPath}.part`
          try {
            await writeFile(partialPath, upload.bytes, { mode: 0o600, flag: 'wx' })
            await rename(partialPath, tempPath)
            const storageKey = relative(storageDirectory, tempPath)
            const fileSha256 = createHash('sha256').update(upload.bytes).digest('hex')
            const queued = await jobs.enqueue({
              identity,
              originalName: upload.originalName,
              tempPath: storageKey,
              fileSha256,
              fileSizeBytes: upload.bytes.length,
            })
            if (queued.tempPathToDelete)
              await removeProtectedTemp(queued.tempPathToDelete, storageDirectory)
            queuedJobs.push({ originalName: upload.originalName, queued })
          } catch (error) {
            await removeProtectedTemp(tempPath, storageDirectory)
            await rm(partialPath, { force: true }).catch(() => undefined)
            throw error
          }
        }
        if (queuedJobs.length === 1) {
          const { queued } = queuedJobs[0]!
          sendJson(response, queued.duplicate ? 200 : 202, {
            jobId: queued.job.jobId,
            status: queued.job.status,
            duplicate: queued.duplicate,
            progress: queued.job.progress,
          })
        } else {
          sendJson(response, queuedJobs.every((item) => item.queued.duplicate) ? 200 : 202, {
            jobs: queuedJobs.map(({ originalName, queued }) => ({
              fileName: originalName,
              jobId: queued.job.jobId,
              status: queued.job.status,
              duplicate: queued.duplicate,
              progress: queued.job.progress,
            })),
          })
        }
        return
      } finally {
        activeUploadRequests--
      }
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(\/events)?$/i)
    if (request.method === 'GET' && jobMatch) {
      const jobId = jobMatch[1]!
      const job = await jobs.getOwned(jobId, identity)
      if (!job) throw new UploadRequestError(404, 'JOB_NOT_FOUND')
      if (!jobMatch[2]) {
        sendJson(response, 200, job)
        return
      }
      if (activeSseStreams >= 50) throw new UploadRequestError(429, 'EVENT_STREAM_CAPACITY_REACHED')
      activeSseStreams++
      try {
        const lastEventHeader = request.headers['last-event-id']
        let lastId =
          url.searchParams.get('after') ??
          (Array.isArray(lastEventHeader) ? lastEventHeader[0] : lastEventHeader) ??
          '0'
        if (!/^\d+$/.test(lastId)) throw new UploadRequestError(400, 'INVALID_EVENT_CURSOR')
        const hasResumeCursor = url.searchParams.has('after') || lastEventHeader !== undefined
        let snapshot = hasResumeCursor ? null : await jobs.snapshotOwned(jobId, identity)
        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        response.flushHeaders()
        let disconnected = false
        response.on('close', () => {
          disconnected = true
        })
        if (snapshot && !disconnected) {
          let terminalInHistory = false
          const history = await jobs.eventsAfter(jobId, identity, '0')
          for (const event of history) {
            response.write(formatSse(event))
            lastId = event.id
            if (event.status === 'completed' || event.status === 'failed') terminalInHistory = true
          }
          snapshot = await jobs.snapshotOwned(jobId, identity)
          if (snapshot) {
            response.write(formatSse(snapshot))
            lastId = snapshot.id
            disconnected =
              terminalInHistory || snapshot.status === 'completed' || snapshot.status === 'failed'
          }
        }
        while (!disconnected && !response.destroyed) {
          const events = await jobs.eventsAfter(jobId, identity, lastId)
          for (const event of events) {
            response.write(formatSse(event))
            lastId = event.id
            if (event.status === 'completed' || event.status === 'failed') disconnected = true
          }
          if (events.length === 0) {
            const current = await jobs.snapshotOwned(jobId, identity)
            if (current?.status === 'completed' || current?.status === 'failed') {
              response.write(formatSse(current))
              disconnected = true
            }
          }
          if (disconnected) break
          response.write(': keep-alive\n\n')
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
        response.end()
        return
      } finally {
        activeSseStreams--
      }
    }
    if (request.method === 'GET' && url.pathname === '/api/documents/search') {
      const query = url.searchParams.get('q')?.trim() ?? ''
      if (!query || query.length > 1000) throw new UploadRequestError(400, 'INVALID_SEARCH_QUERY')
      const typegraphIdentity: SitePilotIdentity = identity
      const typegraph = await typegraphInit(
        createSitePilotExcelConfig(databaseUrl, typegraphIdentity),
      )
      try {
        const result = await typegraph.search(query, {
          graph: 'public',
          buckets: [SITEPILOT_EXCEL_BUCKET_ID],
          resources: ['documents'],
          weights: { semantic: 0.6, bm25: 0.4, graph: false, recency: false },
          fusion: { method: 'rrf', k: 60 },
          limit: 50,
          explain: true,
          context: { groupId: identity.groupId, userId: identity.userId },
        })
        const candidateIds = result.results.chunks
          .map((hit) => hit.metadata.fileId)
          .filter((value): value is string => typeof value === 'string')
        const visibility = await jobs.visibleUploadFileIds(identity, candidateIds)
        const visibleHits = result.results.chunks.filter((hit) => {
          const fileId = hit.metadata.fileId
          return (
            typeof fileId !== 'string' ||
            !visibility.known.has(fileId) ||
            visibility.active.has(fileId)
          )
        })
        if (url.searchParams.get('saveHistory') === 'true')
          await workspace.saveSearch(identity, query, Math.min(5, visibleHits.length))
        sendJson(response, 200, {
          results: visibleHits.slice(0, 5).map((hit) => ({
            content: hit.content,
            score: hit.score,
            matchedBy: hit.matchedBy,
            citation: {
              source: hit.metadata.sourceFile ?? hit.metadata.fileName,
              sheet: hit.metadata.sheetName,
              rowStart: hit.metadata.rowStart,
              rowEnd: hit.metadata.rowEnd,
              sourceRange: hit.metadata.sourceRange,
              ...(Array.isArray(hit.metadata.headingPath)
                ? { section: hit.metadata.headingPath.filter(Boolean).join(' > ') }
                : {}),
              ...(typeof hit.metadata.lineStart === 'number'
                ? { lineStart: hit.metadata.lineStart }
                : {}),
              ...(typeof hit.metadata.lineEnd === 'number'
                ? { lineEnd: hit.metadata.lineEnd }
                : {}),
              ...(typeof hit.metadata.paragraphStart === 'number'
                ? { paragraphStart: hit.metadata.paragraphStart }
                : {}),
              ...(typeof hit.metadata.paragraphEnd === 'number'
                ? { paragraphEnd: hit.metadata.paragraphEnd }
                : {}),
            },
          })),
          explanation: result.explanation,
        })
      } finally {
        await typegraph.destroy()
      }
      return
    }
    sendJson(response, 404, { error: 'NOT_FOUND' })
  }

  const role = process.env.SITEPILOT_ROLE ?? 'all'
  if (!['all', 'api', 'worker'].includes(role))
    throw new Error('SITEPILOT_ROLE must be api, worker, or all')
  const workerCount =
    role === 'api'
      ? 0
      : role === 'worker'
        ? integerSetting(
            undefined,
            process.env.SITEPILOT_UPLOAD_WORKERS,
            1,
            1,
            2,
            'SITEPILOT_UPLOAD_WORKERS',
          )
        : Math.max(0, Math.min(2, options.workerConcurrency ?? 1))
  for (let index = 0; index < workerCount; index++) {
    workerPromises.push(workerLoop(`${process.pid}-${randomUUID()}`))
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 3210, options.host ?? '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : (options.port ?? 3210)

  return {
    server,
    port,
    async close() {
      stopping = true
      const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await serverClosed
      await Promise.all(workerPromises)
      await workspace.close()
      await jobs.close()
    },
  }
}

async function removeProtectedTemp(filePath: string, storageDirectory: string): Promise<void> {
  let resolvedFilePath: string
  try {
    resolvedFilePath = resolveStoredUploadPath(storageDirectory, filePath)
  } catch {
    return
  }
  const directory = dirname(resolvedFilePath)
  try {
    const storageRoot = await realpath(storageDirectory)
    const uploadDirectory = await realpath(directory)
    const pathFromRoot = relative(storageRoot, uploadDirectory)
    if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === '..' || isAbsolute(pathFromRoot))
      return
  } catch {
    return
  }
  await rm(filePath, { force: true }).catch(() => undefined)
  await rm(directory, { recursive: false, force: true }).catch(() => undefined)
}

async function cleanupOrphanedUploads(
  storageDirectory: string,
  jobs: SitePilotUploadJobs,
): Promise<void> {
  const cutoff = Date.now() - 60 * 60_000
  let entries: string[]
  try {
    entries = await readdir(storageDirectory)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.startsWith('sitepilot-upload-')) continue
    const directory = join(storageDirectory, entry)
    try {
      const info = await lstat(directory)
      if (info.isSymbolicLink() || !info.isDirectory() || info.mtimeMs > cutoff) continue
      const files = await readdir(directory)
      const referenced = await Promise.all(
        files.flatMap((file) => [
          jobs.isTempPathReferenced(join(entry, file)),
          jobs.isTempPathReferenced(join(directory, file)), // legacy absolute-path rows
        ]),
      )
      if (referenced.some(Boolean)) continue
      await rm(directory, { recursive: true, force: true })
    } catch {
      // Startup cleanup is best effort; active jobs remain protected by DB references.
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  const jwtSecret = process.env.SITEPILOT_JWT_SECRET
  if (!databaseUrl || !jwtSecret)
    throw new Error('DATABASE_URL and SITEPILOT_JWT_SECRET are required')
  const service = await startUploadService({
    databaseUrl,
    jwtSecret,
    port: Number(process.env.PORT ?? 3210),
    host: process.env.HOST ?? '0.0.0.0',
    workerConcurrency: integerSetting(
      undefined,
      process.env.SITEPILOT_UPLOAD_WORKERS,
      1,
      1,
      2,
      'SITEPILOT_UPLOAD_WORKERS',
    ),
    storageDirectory: process.env.FILE_STORAGE_ROOT ?? process.env.SITEPILOT_UPLOAD_STORAGE_DIR,
    leaseDurationMs: Number(process.env.SITEPILOT_UPLOAD_LEASE_MS ?? 120_000),
    heartbeatIntervalMs: Number(process.env.SITEPILOT_UPLOAD_HEARTBEAT_MS ?? 20_000),
  })
  console.log(
    `SitePilot ${process.env.SITEPILOT_ROLE ?? 'service'} listening on ${process.env.HOST ?? '0.0.0.0'}:${service.port}`,
  )
  const shutdown = () => {
    void service.close().then(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

if (process.argv[1]?.includes('sitepilot-upload-server')) {
  main().catch(() => {
    console.error(
      'SitePilot upload server failed to start (configuration or service dependency error).',
    )
    process.exitCode = 1
  })
}
