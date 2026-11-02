import { createHash } from 'node:crypto'
import { basename } from 'node:path'

import ExcelJS from 'exceljs'

export type ExcelScalar = string | number | boolean | Date | null
export type CellState =
  | 'missing'
  | 'empty'
  | 'value'
  | 'formula'
  | 'formula_without_cached_value'
  | 'merged_non_anchor'

export interface ExcelWarning {
  code: string
  sheetName: string
  rowNumber?: number
  cellRef?: string
  message: string
}

export interface SmartExcelChunk {
  chunkId: string
  documentId: string
  sheetName: string
  rowStart: number
  rowEnd: number
  recordKey: string
  chunkType: 'violation_record' | 'reference_record' | 'narrative_continuation'
  chunkIndex: number
  sourceCells: string[]
  contentHash: string
  accessScope: string
  content: string
  narrativeField?: string
}

export interface ParsedExcelRecord {
  fileId: string
  fileName: string
  sheetName: string
  headerRow: number | null
  rowStart: number
  rowEnd: number
  sourceCells: string[]
  sourceRange: string
  recordKey: string
  recordId: string
  originalHeaders: Record<string, string | null>
  normalizedFields: Record<string, ExcelScalar | '[REDACTED]'>
  cellStates: Record<string, CellState>
  sensitiveFieldsRedacted: string[]
  recordHash: string
  documentContent: string
  chunks: SmartExcelChunk[]
}

export interface ParsedExcelSheet {
  name: string
  rowCount: number
  columnCount: number
  headerRow: number | null
  headers: Array<{ column: number; key: string; original: string | null; sensitive: boolean }>
  records: ParsedExcelRecord[]
}

export interface ParsedExcelWorkbook {
  fileId: string
  fileName: string
  contentHash: string
  sheets: ParsedExcelSheet[]
  warnings: ExcelWarning[]
  totalRecords: number
  totalChunks: number
}

export interface ParseWorkbookOptions {
  fileId?: string
  fileName?: string
  accessScope?: string
  maxNarrativeChars?: number
  maxFileBytes?: number
}

interface HeaderCell {
  column: number
  key: string
  original: string | null
  sensitive: boolean
}

interface RowCandidate {
  rowNumber: number
  cellValues: Array<{ value: ExcelScalar; state: CellState; formula: boolean; cellRef: string }>
}

const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024
const DEFAULT_MAX_NARRATIVE_CHARS = 1800
const NARRATIVE_HEADER = /(?:aciklama|savunma|description|remarks?|notes?)/
const IDENTIFIER_HEADER = /(?:^|_)(?:form_no|record_id|kks|code|id)(?:_|$)/

export function normalizeHeaderKey(header: string): string {
  const ascii = header
    .normalize('NFKD')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
  return ascii.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'column'
}

export function isSensitiveHeader(header: string): boolean {
  const key = normalizeHeaderKey(header)
  return /(?:personel|employee|staff|soyad|surname|adi_soyadi|full_name|kimlik|tckn|tc_no|telefon|phone|email|e_posta|iban|adres|address|uyruk|nationality|mudur|manager|reporter|talep_eden|yazan_personel)/.test(
    key,
  )
}

function isSensitiveNumber(value: ExcelScalar): boolean {
  return (
    typeof value === 'number' && Number.isFinite(value) && String(Math.trunc(value)).length >= 5
  )
}

function excelValue(value: ExcelJS.CellValue | undefined): ExcelScalar {
  if (value == null) return null
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value
  if ('formula' in value || 'sharedFormula' in value) {
    const cached = 'result' in value ? value.result : null
    return excelValue(cached as ExcelJS.CellValue)
  }
  if ('richText' in value) return value.richText.map((part) => part.text).join('')
  if ('text' in value && typeof value.text === 'string') return value.text
  return null
}

function columnLetters(column: number): string {
  let result = ''
  let current = column
  while (current > 0) {
    const remainder = (current - 1) % 26
    result = String.fromCharCode(65 + remainder) + result
    current = Math.floor((current - 1) / 26)
  }
  return result
}

function columnFromAddress(address: string): number {
  const letters = address.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? ''
  let column = 0
  for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64
  return column
}

function detectHeaderRow(sheet: ExcelJS.Worksheet): number | null {
  let bestRow: number | null = null
  let bestScore = -Infinity
  const scanTo = Math.min(sheet.rowCount || 1, 100)
  for (let rowNumber = 1; rowNumber <= scanTo; rowNumber++) {
    const values = sheet.getRow(rowNumber).values as unknown as Array<ExcelJS.CellValue | undefined>
    const labels: string[] = []
    for (let column = 1; column <= sheet.columnCount; column++) {
      const value = excelValue(values[column])
      if (typeof value === 'string' && value.trim()) labels.push(value.trim())
    }
    const unique = new Set(labels.map((label) => normalizeHeaderKey(label))).size
    const headerLikeSingle =
      labels.length === 1 &&
      /^(?:kks|id|code|name|active|location|region|type|date|status)$/i.test(labels[0]!)
    if (labels.length < 2 && !headerLikeSingle) continue
    const score = labels.length * 5 + unique * 2 - rowNumber * 0.01
    if (score > bestScore) {
      bestScore = score
      bestRow = rowNumber
    }
  }
  return bestRow
}

function headerCells(sheet: ExcelJS.Worksheet, headerRow: number | null): HeaderCell[] {
  const values = headerRow
    ? (sheet.getRow(headerRow).values as unknown as Array<ExcelJS.CellValue | undefined>)
    : []
  const seen = new Map<string, number>()
  return Array.from({ length: sheet.columnCount }, (_, index) => {
    const column = index + 1
    const raw = headerRow ? excelValue(values[column]) : null
    const original = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    const base = original
      ? normalizeHeaderKey(original)
      : `column_${columnLetters(column).toLowerCase()}`
    const occurrence = (seen.get(base) ?? 0) + 1
    seen.set(base, occurrence)
    return {
      column,
      key: occurrence === 1 ? base : `${base}__${occurrence}`,
      original,
      sensitive: original ? isSensitiveHeader(original) : false,
    }
  })
}

function rowCandidate(
  sheet: ExcelJS.Worksheet,
  rowNumber: number,
  headers: HeaderCell[],
  warnings: ExcelWarning[],
): RowCandidate {
  const row = sheet.getRow(rowNumber)
  const modelCells = new Map((row.model?.cells ?? []).map((cell) => [String(cell.address), cell]))
  const cellValues = headers.map((header) => {
    const cell = row.getCell(header.column)
    const cellRef = cell.address
    const modelCell = modelCells.get(String(cellRef))
    if (cell.isMerged && cell.master.address !== cellRef) {
      return { value: null, state: 'merged_non_anchor' as const, formula: false, cellRef }
    }
    if (!modelCell) return { value: null, state: 'missing' as const, formula: false, cellRef }

    const rawValue = cell.value
    const formula =
      !!rawValue &&
      typeof rawValue === 'object' &&
      ('formula' in rawValue || 'sharedFormula' in rawValue)
    if (formula) {
      const cachedValue = excelValue(rawValue as ExcelJS.CellValue)
      if (cachedValue == null) {
        warnings.push({
          code: 'formula_without_cached_value',
          sheetName: sheet.name,
          rowNumber,
          cellRef,
          message: 'Formula was not executed and has no cached result.',
        })
        return {
          value: null,
          state: 'formula_without_cached_value' as const,
          formula: true,
          cellRef,
        }
      }
      warnings.push({
        code: 'formula_cached_value_used',
        sheetName: sheet.name,
        rowNumber,
        cellRef,
        message: 'Formula was not executed; the workbook cached result was used.',
      })
      return { value: cachedValue, state: 'formula' as const, formula: true, cellRef }
    }
    const value = excelValue(rawValue)
    return {
      value,
      state: value == null || value === '' ? ('empty' as const) : ('value' as const),
      formula: false,
      cellRef,
    }
  })
  return { rowNumber, cellValues }
}

function sensitiveTermMatcher(sensitiveTerms: Iterable<string>): RegExp | undefined {
  const terms = [...new Set([...sensitiveTerms].filter((term) => term.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return terms.length ? new RegExp(`(?:${terms.join('|')})`, 'giu') : undefined
}

function sanitizeNarrative(text: string, matcher: RegExp | undefined): string {
  let sanitized = text
    .replace(/\b[1-9]\d{10}\b/g, '[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, (match) =>
      match.replace(/\D/g, '').length >= 10 ? '[REDACTED]' : match,
    )
  if (matcher) sanitized = sanitized.replace(matcher, '[REDACTED]')
  return sanitized
}

function sourceRange(sourceCells: string[], rowStart: number, rowEnd: number): string {
  if (sourceCells.length === 0) return `Row ${rowStart}${rowEnd === rowStart ? '' : `-${rowEnd}`}`
  const columns = sourceCells.map(columnFromAddress)
  const min = Math.min(...columns)
  const max = Math.max(...columns)
  return rowStart === rowEnd
    ? `${columnLetters(min)}${rowStart}:${columnLetters(max)}${rowEnd}`
    : `${columnLetters(min)}${rowStart}:${columnLetters(max)}${rowEnd}`
}

function splitNarrative(text: string, maxChars: number): string[] {
  const pieces: string[] = []
  const paragraphs = text.split(/\n\s*\n/)
  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^.!?\n]+[.!?]?(?:\s+|$)/gu) ?? [paragraph]
    let current = ''
    for (const sentence of sentences) {
      if (sentence.length > maxChars) {
        if (current.trim()) pieces.push(current.trim())
        current = ''
        const words = sentence.split(/(\s+)/)
        for (const word of words) {
          if (current.length + word.length > maxChars && current.trim()) {
            pieces.push(current.trim())
            current = word.trimStart()
          } else current += word
        }
        if (current.trim()) pieces.push(current.trim())
        current = ''
      } else if (current.length + sentence.length > maxChars && current.trim()) {
        pieces.push(current.trim())
        current = sentence
      } else current += sentence
    }
    if (current.trim()) pieces.push(current.trim())
  }
  return pieces.length > 0 ? pieces : [text]
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function excelDateString(value: Date, includeTime = true): string {
  const pad = (part: number, width = 2) => String(part).padStart(width, '0')
  const date = `${pad(value.getFullYear(), 4)}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  if (!includeTime) return date
  return `${date}T${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${pad(value.getMilliseconds(), 3)}`
}

function stringForField(value: ExcelScalar | '[REDACTED]' | undefined): string | null {
  if (value === '[REDACTED]') return value
  if (value == null || value === '') return null
  if (value instanceof Date) return excelDateString(value, false)
  return String(value)
}

function recordKeyFor(
  headers: HeaderCell[],
  values: RowCandidate['cellValues'],
  sheetName: string,
  row: number,
): string {
  const index = headers.findIndex(
    (header) => !header.sensitive && /^(?:form_no|record_id|kks|code|id)$/.test(header.key),
  )
  const candidate = index >= 0 ? values[index]?.value : null
  if (candidate != null && candidate !== '') return String(candidate).trim()
  return `${sheetName}:row:${row}`
}

function buildRecordChunks(args: {
  fileId: string
  sheetName: string
  recordKey: string
  recordId: string
  rowNumber: number
  sourceCells: string[]
  headers: HeaderCell[]
  fields: Record<string, ExcelScalar | '[REDACTED]'>
  maxNarrativeChars: number
  accessScope: string
}): SmartExcelChunk[] {
  const narrativeFields = args.headers.filter(
    (header) => header.original && NARRATIVE_HEADER.test(normalizeHeaderKey(header.original)),
  )
  const longNarratives = narrativeFields
    .map((header) => ({ header, text: stringForField(args.fields[header.key]) }))
    .filter(
      (entry): entry is { header: HeaderCell; text: string } =>
        entry.text != null && entry.text.length > args.maxNarrativeChars,
    )
  const longKeys = new Set(longNarratives.map(({ header }) => header.key))
  const baseLines = args.headers.flatMap((header) => {
    const value = args.fields[header.key]
    if (longKeys.has(header.key) || value == null || value === '') return []
    return [`${header.original ?? header.key}: ${stringForField(value)}`]
  })

  const draftChunks: Array<{
    type: SmartExcelChunk['chunkType']
    text: string
    narrativeField?: string
  }> = []
  if (longNarratives.length === 0) {
    draftChunks.push({
      type: normalizeHeaderKey(args.sheetName).includes('ihtar_tablosu')
        ? 'violation_record'
        : 'reference_record',
      text: baseLines.join('\n') || '[Record contains only redacted fields.]',
    })
  } else {
    const context = baseLines.join('\n')
    for (const { header, text } of longNarratives) {
      const parts = splitNarrative(text, args.maxNarrativeChars)
      parts.forEach((part, partIndex) => {
        draftChunks.push({
          type: 'narrative_continuation',
          narrativeField: header.original ?? header.key,
          text: [
            context,
            `${header.original ?? header.key} (part ${partIndex + 1}/${parts.length}):`,
            part,
          ]
            .filter(Boolean)
            .join('\n'),
        })
      })
    }
    if (draftChunks.length === 0) draftChunks.push({ type: 'violation_record', text: context })
  }

  return draftChunks.map((draft, chunkIndex) => {
    const contentHash = sha256(draft.text)
    const chunkId = `exc_${sha256(`${args.recordId}:${chunkIndex}:${contentHash}`).slice(0, 40)}`
    return {
      chunkId,
      documentId: args.recordId,
      sheetName: args.sheetName,
      rowStart: args.rowNumber,
      rowEnd: args.rowNumber,
      recordKey: args.recordKey,
      chunkType: draft.type,
      chunkIndex,
      sourceCells: args.sourceCells,
      contentHash,
      accessScope: args.accessScope,
      content: draft.text,
      ...(draft.narrativeField ? { narrativeField: draft.narrativeField } : {}),
    }
  })
}

export function parseExcelWorkbook(
  workbook: ExcelJS.Workbook,
  options: ParseWorkbookOptions = {},
  contentHash = 'in-memory-test-workbook',
): ParsedExcelWorkbook {
  const fileName = options.fileName ?? 'workbook.xlsx'
  const fileId =
    options.fileId ??
    `file_${sha256(fileName.normalize('NFC').toLocaleLowerCase('tr')).slice(0, 40)}`
  const maxNarrativeChars = options.maxNarrativeChars ?? DEFAULT_MAX_NARRATIVE_CHARS
  const accessScope = options.accessScope ?? 'restricted-test-group'
  const warnings: ExcelWarning[] = []
  const sheetPlans = workbook.worksheets.map((sheet) => {
    const headerRow = detectHeaderRow(sheet)
    const headers = headerCells(sheet, headerRow)
    if (headerRow == null) {
      warnings.push({
        code: 'header_not_detected',
        sheetName: sheet.name,
        message:
          'No header row was confidently detected; generated Column_A style field names are used.',
      })
    }
    for (const range of sheet.model.merges ?? []) {
      warnings.push({
        code: 'merged_cells_present',
        sheetName: sheet.name,
        message: `Merged range ${range} is preserved as a warning; merged values are not filled into other cells.`,
      })
    }
    return { sheet, headerRow, headers }
  })

  const rawRows = sheetPlans.map(({ sheet, headerRow, headers }) => {
    const records: Array<{ candidate: RowCandidate; headers: HeaderCell[] }> = []
    const startRow = (headerRow ?? 0) + 1
    for (let rowNumber = startRow; rowNumber <= sheet.rowCount; rowNumber++) {
      const candidate = rowCandidate(sheet, rowNumber, headers, warnings)
      if (
        candidate.cellValues.every(
          (cell) =>
            (cell.value == null || cell.value === '') &&
            cell.state !== 'formula_without_cached_value',
        )
      )
        continue
      records.push({ candidate, headers })
    }
    return {
      sheetName: sheet.name,
      headerRow,
      headers,
      records,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
    }
  })

  // Collect sensitive source values only in memory so they can be scrubbed from narrative fields.
  const sensitiveTerms = new Set<string>()
  for (const sheet of rawRows) {
    for (const { candidate, headers } of sheet.records) {
      headers.forEach((header, index) => {
        if (!header.sensitive) return
        const value = candidate.cellValues[index]?.value
        if (typeof value === 'string' && value.trim().length >= 4) sensitiveTerms.add(value.trim())
        if (value !== undefined && isSensitiveNumber(value)) sensitiveTerms.add(String(value))
      })
    }
  }
  const sensitiveMatcher = sensitiveTermMatcher(sensitiveTerms)

  const sheets: ParsedExcelSheet[] = rawRows.map((sheet) => {
    const proposedKeys = sheet.records.map(({ candidate, headers }) =>
      recordKeyFor(headers, candidate.cellValues, sheet.sheetName, candidate.rowNumber),
    )
    const keyCounts = new Map<string, number>()
    proposedKeys.forEach((key) => keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1))
    const records = sheet.records.map(({ candidate, headers }) => {
      const proposedKey = recordKeyFor(
        headers,
        candidate.cellValues,
        sheet.sheetName,
        candidate.rowNumber,
      )
      const recordKey =
        (keyCounts.get(proposedKey) ?? 0) > 1
          ? `${proposedKey}#row:${candidate.rowNumber}`
          : proposedKey
      if (recordKey !== proposedKey) {
        warnings.push({
          code: 'duplicate_record_key',
          sheetName: sheet.sheetName,
          rowNumber: candidate.rowNumber,
          message:
            'Duplicate record identifier was disambiguated with the physical worksheet row number.',
        })
      }
      const recordId = `exr_${sha256(`${fileId}:${sheet.sheetName}:${recordKey}`).slice(0, 40)}`
      const normalizedFields: Record<string, ExcelScalar | '[REDACTED]'> = {}
      const originalHeaders: Record<string, string | null> = {}
      const cellStates: Record<string, CellState> = {}
      const sensitiveFieldsRedacted: string[] = []

      headers.forEach((header, index) => {
        const source = candidate.cellValues[index]!
        originalHeaders[header.key] = header.original
        cellStates[header.key] = source.state
        if (header.sensitive) {
          normalizedFields[header.key] = '[REDACTED]'
          if (source.value != null && source.value !== '') sensitiveFieldsRedacted.push(header.key)
          return
        }
        if (typeof source.value === 'string') {
          normalizedFields[header.key] = sanitizeNarrative(source.value, sensitiveMatcher)
        } else {
          normalizedFields[header.key] = source.value
        }
      })

      const sourceCells = candidate.cellValues
        .filter((cell) => cell.value != null && cell.value !== '')
        .map((cell) => cell.cellRef)
      const documentContent = headers
        .flatMap((header) => {
          const value = normalizedFields[header.key]
          if (value == null || value === '') return []
          return [`${header.original ?? header.key}: ${stringForField(value)}`]
        })
        .join('\n')
      const safeFieldsJson = JSON.stringify(normalizedFields, (_key, value: unknown) =>
        value instanceof Date ? excelDateString(value) : value,
      )
      const recordHash = sha256(
        `${safeFieldsJson}\n${candidate.rowNumber}\n${sourceCells.join(',')}`,
      )
      const chunks = buildRecordChunks({
        fileId,
        sheetName: sheet.sheetName,
        recordKey,
        recordId,
        rowNumber: candidate.rowNumber,
        sourceCells,
        headers,
        fields: normalizedFields,
        maxNarrativeChars,
        accessScope,
      })
      return {
        fileId,
        fileName,
        sheetName: sheet.sheetName,
        headerRow: sheet.headerRow,
        rowStart: candidate.rowNumber,
        rowEnd: candidate.rowNumber,
        sourceCells,
        sourceRange: sourceRange(sourceCells, candidate.rowNumber, candidate.rowNumber),
        recordKey,
        recordId,
        originalHeaders,
        normalizedFields,
        cellStates,
        sensitiveFieldsRedacted,
        recordHash,
        documentContent,
        chunks,
      } satisfies ParsedExcelRecord
    })

    return {
      name: sheet.sheetName,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      headerRow: sheet.headerRow,
      headers: sheet.headers.map(({ column, key, original, sensitive }) => ({
        column,
        key,
        original,
        sensitive,
      })),
      records,
    }
  })

  const allRecords = sheets.flatMap((sheet) => sheet.records)
  if (sensitiveMatcher) {
    const leakedSensitiveValue = allRecords.some((record) => {
      for (const text of [record.documentContent, ...record.chunks.map((chunk) => chunk.content)]) {
        sensitiveMatcher.lastIndex = 0
        if (sensitiveMatcher.test(text)) return true
      }
      return false
    })
    if (leakedSensitiveValue) {
      throw new Error(
        'Workbook parsing was stopped because sensitive source text remained in an indexable field',
      )
    }
  }
  return {
    fileId,
    fileName,
    contentHash,
    sheets,
    warnings,
    totalRecords: allRecords.length,
    totalChunks: allRecords.reduce((sum, record) => sum + record.chunks.length, 0),
  }
}

export async function parseExcelFile(
  path: string,
  options: ParseWorkbookOptions = {},
): Promise<ParsedExcelWorkbook> {
  const { stat, readFile } = await import('node:fs/promises')
  const info = await stat(path)
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
  if (info.size > maxFileBytes) {
    throw new Error(`Workbook exceeds the configured ${maxFileBytes}-byte memory safety limit`)
  }
  const bytes = await readFile(path)
  const contentHash = sha256(bytes)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0])
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > 100_000 || sheet.columnCount > 500) {
      throw new Error(`Worksheet ${sheet.name} exceeds the parser's bounded row/column limits`)
    }
  }
  return parseExcelWorkbook(
    workbook,
    {
      ...options,
      fileName: options.fileName ?? basename(path),
    },
    contentHash,
  )
}

export function workbookIdentity(fileName: string): string {
  return `file_${sha256(fileName.normalize('NFC').toLocaleLowerCase('tr')).slice(0, 40)}`
}

export function exportSafePreview(record: ParsedExcelRecord): Record<string, unknown> {
  return {
    fileId: record.fileId,
    fileName: record.fileName,
    sheetName: record.sheetName,
    headerRow: record.headerRow,
    rowStart: record.rowStart,
    rowEnd: record.rowEnd,
    sourceCells: record.sourceCells,
    sourceRange: record.sourceRange,
    recordKey: record.recordKey,
    originalHeaders: record.originalHeaders,
    normalizedFields: record.normalizedFields,
    cellStates: record.cellStates,
    chunks: record.chunks.map(({ content, ...metadata }) => ({
      ...metadata,
      preview: content.slice(0, 240),
    })),
  }
}
