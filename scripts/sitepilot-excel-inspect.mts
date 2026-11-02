import process from 'node:process'
import { createHash } from 'node:crypto'
import { basename, resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'

import ExcelJS from 'exceljs'
import { isSensitiveHeader } from '../src/sitepilot/excel/sitepilot-excel-core.mjs'

const SENSITIVE_HEADER =
  /(?:ad.?soyad|isim|name|employee|personel\s*(?:no|numara|adi|adı|soyadi|soyadı)|çalışan|calisan|kimlik|tckn|tc\s*(?:no|kimlik)|telefon|phone|e.?posta|email|iban|adres|address|ücret|maas|maaş)/i
const IDENTIFIER_HEADER =
  /(?:^id$|form\s*(?:no|numara)|kayıt\s*(?:no|numara)|kayit\s*(?:no|numara)|sicil|tutanak|belge\s*(?:no|numara)|sıra\s*(?:no|numara)|sira\s*(?:no|numara)|record\s*id)/i

function scalar(value: ExcelJS.CellValue): string | number | boolean | Date | null {
  if (value == null) return null
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value
  if ('text' in value && typeof value.text === 'string') return value.text
  if ('richText' in value) return value.richText.map((part) => part.text).join('')
  if ('result' in value) {
    const result = value.result
    return typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean'
      ? result
      : null
  }
  return null
}

function headerLabel(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

function normalizedHeader(value: string): string {
  return value.trim().toLocaleLowerCase('tr').normalize('NFKC')
}

function findHeaderColumn(sheet: ExcelJS.Worksheet, headerRow: number, target: string): number {
  for (let column = 1; column <= sheet.columnCount; column++) {
    const value = headerLabel(scalar(sheet.getRow(headerRow).getCell(column).value))
    if (normalizedHeader(value) === normalizedHeader(target)) return column
  }
  return 0
}

function detectHeader(sheet: ExcelJS.Worksheet): { row: number; labels: string[]; score: number } {
  let best = { row: 0, labels: [] as string[], score: -Infinity }
  const scanTo = Math.min(sheet.rowCount || 1, 100)
  for (let rowNumber = 1; rowNumber <= scanTo; rowNumber++) {
    const row = sheet.getRow(rowNumber)
    const labels = Array.from({ length: sheet.columnCount }, (_, index) =>
      headerLabel(scalar(row.getCell(index + 1).value)),
    )
    const nonEmpty = labels.filter(Boolean)
    const unique = new Set(nonEmpty.map(normalizedHeader)).size
    const stringLike = nonEmpty.filter((label) => /[a-zA-ZçğıöşüÇĞİÖŞÜ]/.test(label)).length
    const score = nonEmpty.length * 3 + unique * 2 + stringLike - (rowNumber - 1) * 0.01
    const singleColumnHeader =
      nonEmpty.length === 1 &&
      /^(?:kks|id|code|name|active|location|region|type|date|status)$/i.test(nonEmpty[0]!)
    if ((nonEmpty.length > 1 || singleColumnHeader) && score > best.score) {
      best = { row: rowNumber, labels, score }
    }
  }
  return best
}

async function inspectWorkbook(inputPath: string, reportPath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(inputPath)
  const sheets = workbook.worksheets.map((sheet) => {
    const header = detectHeader(sheet)
    const seenHeaders = new Map<string, number>()
    const headers = header.labels.map((original, index) => {
      if (!original) return { column: index + 1, original: null, empty: true }
      const key = normalizedHeader(original)
      const occurrence = (seenHeaders.get(key) ?? 0) + 1
      seenHeaders.set(key, occurrence)
      return {
        column: index + 1,
        original,
        duplicateOccurrence: occurrence > 1 ? occurrence : undefined,
      }
    })

    const identifierDuplicates: Array<{
      header: string
      duplicateCount: number
      distinctValues: number
    }> = []
    for (const item of headers) {
      if (!item.original || !IDENTIFIER_HEADER.test(item.original)) continue
      const values = new Map<string, number>()
      for (let rowNumber = header.row + 1; rowNumber <= sheet.rowCount; rowNumber++) {
        const value = scalar(sheet.getRow(rowNumber).getCell(item.column).value)
        if (value == null || value === '') continue
        const key = value instanceof Date ? value.toISOString() : String(value)
        values.set(key, (values.get(key) ?? 0) + 1)
      }
      const duplicateCount = [...values.values()].reduce(
        (sum, count) => sum + Math.max(0, count - 1),
        0,
      )
      identifierDuplicates.push({
        header: item.original,
        duplicateCount,
        distinctValues: values.size,
      })
    }

    let formulaCount = 0
    let formulaCachedValueCount = 0
    let dateCellCount = 0
    let numericCellCount = 0
    const numericFormats = new Map<string, number>()
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
      const row = sheet.getRow(rowNumber)
      row.eachCell({ includeEmpty: false }, (cell) => {
        const value = cell.value
        if (
          value &&
          typeof value === 'object' &&
          ('formula' in value || 'sharedFormula' in value)
        ) {
          formulaCount++
          if ('result' in value && value.result != null) formulaCachedValueCount++
        }
        if (value instanceof Date) dateCellCount++
        if (typeof value === 'number') {
          numericCellCount++
          const format = cell.numFmt || 'General'
          if (format !== 'General')
            numericFormats.set(format, (numericFormats.get(format) ?? 0) + 1)
        }
      })
    }

    const hiddenRows: number[] = []
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
      if (sheet.getRow(rowNumber).hidden) hiddenRows.push(rowNumber)
    }
    const hiddenColumns = sheet.columns
      .map((column, index) =>
        column.hidden ? { column: index + 1, letter: column.letter } : undefined,
      )
      .filter((column) => column !== undefined)

    return {
      name: sheet.name,
      rowCount: sheet.rowCount,
      populatedRowCount: sheet.actualRowCount,
      columnCount: sheet.columnCount,
      populatedColumnCount: sheet.actualColumnCount,
      headerRow: header.row,
      headerDetectionScore: Number(header.score.toFixed(2)),
      headers,
      emptyHeaderColumns: headers
        .filter((item) => item.original == null)
        .map((item) => item.column),
      duplicateHeaders: [...seenHeaders.entries()]
        .filter(([, count]) => count > 1)
        .map(([headerName, count]) => ({ header: headerName, count })),
      likelySensitiveHeaders: headers
        .filter(
          (item) =>
            item.original &&
            (isSensitiveHeader(item.original) ||
              SENSITIVE_HEADER.test(normalizedHeader(item.original))),
        )
        .map((item) => item.original),
      mergedRanges: [...sheet.model.merges],
      hiddenRows,
      hiddenColumns,
      formulaCount,
      formulaCachedValueCount,
      dateCellCount,
      numericCellCount,
      numericFormats: [...numericFormats.entries()].map(([format, count]) => ({ format, count })),
      identifierDuplicates,
      headerless: header.row === 0,
      referenceLikeSheet:
        /ref|lookup|list|action|company|region|location|type|ceza|bölge|bolge|lokasyon|firma/i.test(
          sheet.name,
        ),
      // Never include raw cell values or formula expressions in this report.
      cellValuesOmitted: true,
    }
  })

  const headerSets = sheets.map(
    (sheet) => new Set(sheet.headers.flatMap((item) => (item.original ? [item.original] : []))),
  )
  const relationships: Array<{ fromSheet: string; toSheet: string; sharedHeaders: string[] }> = []
  for (let from = 0; from < sheets.length; from++) {
    for (let to = from + 1; to < sheets.length; to++) {
      const sharedHeaders = [...headerSets[from]!].filter((header) => headerSets[to]!.has(header))
      if (sharedHeaders.length > 0)
        relationships.push({
          fromSheet: sheets[from]!.name,
          toSheet: sheets[to]!.name,
          sharedHeaders,
        })
    }
  }

  const valueJoinCandidates = findValueJoinCandidates(workbook)
  const report = {
    generatedAt: new Date().toISOString(),
    fileName: basename(inputPath),
    fileId: createHash('sha256')
      .update(await import('node:fs/promises').then(({ readFile }) => readFile(inputPath)))
      .digest('hex'),
    worksheetCount: sheets.length,
    sheets,
    possibleHeaderRelationships: relationships,
    valueJoinCandidates,
    cellValuesOmitted: true,
    warnings: [
      'ExcelJS inspection is bounded by workbook memory size; unsupported macros/external links are not executed.',
    ],
  }
  await mkdir(resolve(reportPath, '..'), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  console.log(`Inspection report written: ${reportPath}`)
  console.log(`Sheets inspected: ${sheets.length}; raw cell values were omitted.`)
}

function findValueJoinCandidates(workbook: ExcelJS.Workbook): Array<{
  fromSheet: string
  fromHeader: string
  toSheet: string
  toHeader: string
  matchingDistinctValues: number
  matchingSourceRows: number
}> {
  const normalizedSheetName = (name: string) => name.toLocaleLowerCase('tr').normalize('NFKC')
  const main = workbook.worksheets.find((sheet) =>
    normalizedSheetName(sheet.name).includes('ihtar tablosu'),
  )
  if (!main) return []
  const mainHeader = detectHeader(main)
  const relationships = [
    { from: 'FİRMA / ALT YÜKLENİCİ', targetSheet: 'firma', target: 'Company' },
    { from: 'İHLAL YAPILAN BÖLGE', targetSheet: 'bölge', target: 'Crew Region' },
    { from: 'SORUMLU PROJE MÜDÜRÜ', targetSheet: 'bölge', target: 'Project Manager' },
    { from: 'İHLAL YAPILAN LOKASYON', targetSheet: 'lokasyon', target: 'KKS' },
    { from: 'ANA İHLAL TÜRÜ', targetSheet: 'ihlal türleri', target: 'Ana İhlal Türü' },
    { from: 'ALT İHLAL TÜRÜ', targetSheet: 'ihlal türleri', target: 'Alt İhlal Türü' },
  ]
  const output: ReturnType<typeof findValueJoinCandidates> = []
  for (const candidate of relationships) {
    const fromIndex = findHeaderColumn(main, mainHeader.row, candidate.from)
    if (fromIndex < 1) continue
    const targetSheet = workbook.worksheets.find((sheet) =>
      normalizedSheetName(sheet.name).includes(candidate.targetSheet),
    )
    if (!targetSheet) continue
    const targetHeader = detectHeader(targetSheet)
    const toIndex = findHeaderColumn(targetSheet, targetHeader.row, candidate.target)
    if (toIndex < 1) continue

    const targetValues = new Set<string>()
    for (let rowNumber = targetHeader.row + 1; rowNumber <= targetSheet.rowCount; rowNumber++) {
      const value = scalar(targetSheet.getRow(rowNumber).getCell(toIndex).value)
      if (value != null && value !== '')
        targetValues.add(String(value).trim().toLocaleLowerCase('tr'))
    }
    let matchingSourceRows = 0
    const matched = new Set<string>()
    for (let rowNumber = mainHeader.row + 1; rowNumber <= main.rowCount; rowNumber++) {
      const value = scalar(main.getRow(rowNumber).getCell(fromIndex).value)
      if (value == null || value === '') continue
      const key = String(value).trim().toLocaleLowerCase('tr')
      if (targetValues.has(key)) {
        matched.add(key)
        matchingSourceRows++
      }
    }
    output.push({
      fromSheet: main.name,
      fromHeader: candidate.from,
      toSheet: targetSheet.name,
      toHeader: candidate.target,
      matchingDistinctValues: matched.size,
      matchingSourceRows,
    })
  }
  return output
}

const inputPath = process.argv[2]
if (!inputPath) {
  console.error(
    'Usage: pnpm exec tsx scripts/sitepilot-excel-inspect.mts <workbook.xlsx> [report.json]',
  )
  process.exitCode = 2
} else {
  const absoluteInput = resolve(inputPath)
  const reportPath = resolve(process.argv[3] ?? 'reports/sitepilot-excel-inspection.json')
  inspectWorkbook(absoluteInput, reportPath).catch((error: unknown) => {
    console.error(
      'Workbook inspection failed:',
      error instanceof Error ? error.message : 'unknown error',
    )
    process.exitCode = 1
  })
}
