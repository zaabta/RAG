import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'

import { parseExcelWorkbook } from '../src/sitepilot/excel/sitepilot-excel-core.mjs'
import { inTransaction } from '../src/sitepilot/excel/sitepilot-excel-store.mjs'

function syntheticWorkbook(): ExcelJS.Workbook {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('İHTAR TABLOSU_DTO')
  sheet.getCell('A1').value = 'Synthetic export title'
  sheet.addRow([])
  sheet.addRow([
    'FORM NO',
    'PERSONEL ADI SOYADI',
    'T.C KİMLİK NUMARASI',
    'OLAY TARİHİ',
    'AÇIKLAMA',
    'SCORE',
    'SCORE',
    null,
    'MISSING SAMPLE',
  ])
  const dataRow = sheet.addRow([
    4,
    'Ayşe Synthetic',
    '12345678901',
    new Date('2025-01-15T00:00:00.000Z'),
    'Ayşe Synthetic reported 12345678901. First synthetic sentence. Second synthetic sentence. Third synthetic sentence with enough words to split into multiple record chunks safely.',
    0,
    { formula: '1+3', result: 4 },
    null,
  ])

  const merged = workbook.addWorksheet('Merged fixture')
  merged.addRow(['Key', 'Other'])
  merged.getCell('A2').value = 'Anchor only'
  merged.mergeCells('A2:B2')

  const reference = workbook.addWorksheet('Lookup')
  reference.addRow(['Category', 'Code'])
  reference.addRow(['Synthetic type', 'S-1'])
  return workbook
}

describe('SitePilot Excel parsing and smart chunks', () => {
  it('finds a non-first header row and preserves typed values and cell states', () => {
    const parsed = parseExcelWorkbook(syntheticWorkbook(), {
      fileId: 'test-file',
      fileName: 'sanitized-fixture.xlsx',
      maxNarrativeChars: 100,
    })
    const sheet = parsed.sheets.find((candidate) => candidate.name === 'İHTAR TABLOSU_DTO')!
    const record = sheet.records[0]!

    expect(sheet.headerRow).toBe(3)
    expect(sheet.headers.map((header) => header.key)).toContain('score__2')
    expect(sheet.headers.find((header) => header.key === 'column_h')?.original).toBeNull()
    expect(record.originalHeaders.personel_adi_soyadi).toBe('PERSONEL ADI SOYADI')
    expect(record.normalizedFields.personel_adi_soyadi).toBe('[REDACTED]')
    expect(record.normalizedFields.t_c_kimlik_numarasi).toBe('[REDACTED]')
    expect(record.normalizedFields.score).toBe(0)
    expect(record.normalizedFields.score__2).toBe(4)
    expect(record.normalizedFields.olay_tarihi).toBeInstanceOf(Date)
    expect(record.documentContent).toContain('OLAY TARİHİ: 2025-01-15')
    expect(record.cellStates.score__2).toBe('formula')
    expect(record.cellStates.column_h).toBe('empty')
    expect(record.cellStates.missing_sample).toBe('missing')
    expect(parsed.warnings.some((warning) => warning.code === 'formula_cached_value_used')).toBe(
      true,
    )
  })

  it('redacts names and Turkish identity numbers before chunk content is built', () => {
    const parsed = parseExcelWorkbook(syntheticWorkbook(), {
      fileId: 'privacy-test',
      fileName: 'sanitized-fixture.xlsx',
      maxNarrativeChars: 100,
    })
    const record = parsed.sheets[0]!.records[0]!
    const allText = record.chunks.map((chunk) => chunk.content).join('\n')
    expect(allText).not.toContain('Ayşe Synthetic')
    expect(allText).not.toContain('12345678901')
    expect(record.sensitiveFieldsRedacted).toEqual(['personel_adi_soyadi', 't_c_kimlik_numarasi'])
  })

  it('splits only long narrative fields and repeats record identity and provenance', () => {
    const parsed = parseExcelWorkbook(syntheticWorkbook(), {
      fileId: 'chunk-test',
      fileName: 'sanitized-fixture.xlsx',
      maxNarrativeChars: 100,
    })
    const record = parsed.sheets[0]!.records[0]!
    expect(record.chunks.length).toBeGreaterThan(1)
    expect(record.chunks.every((chunk) => chunk.content.includes('FORM NO: 4'))).toBe(true)
    expect(record.chunks.every((chunk) => chunk.rowStart === 4 && chunk.rowEnd === 4)).toBe(true)
    expect(record.chunks.every((chunk) => chunk.sourceCells.includes('A4'))).toBe(true)
    expect(record.chunks[0]!.chunkId).toMatch(/^exc_/)
    expect(record.sourceRange).toBe('A4:G4')
  })

  it('does not propagate merged-cell anchor values into merged cells', () => {
    const parsed = parseExcelWorkbook(syntheticWorkbook(), { fileId: 'merge-test' })
    const record = parsed.sheets.find((sheet) => sheet.name === 'Merged fixture')!.records[0]!
    expect(record.normalizedFields.other).toBeNull()
    expect(record.cellStates.other).toBe('merged_non_anchor')
    expect(parsed.warnings.some((warning) => warning.code === 'merged_cells_present')).toBe(true)
  })

  it('keeps a reference row as its own deterministic record', () => {
    const first = parseExcelWorkbook(syntheticWorkbook(), { fileId: 'stable-file' })
    const second = parseExcelWorkbook(syntheticWorkbook(), { fileId: 'stable-file' })
    const firstRecord = first.sheets.find((sheet) => sheet.name === 'Lookup')!.records[0]!
    const secondRecord = second.sheets.find((sheet) => sheet.name === 'Lookup')!.records[0]!
    expect(firstRecord.recordId).toBe(secondRecord.recordId)
    expect(firstRecord.chunks).toHaveLength(1)
    expect(firstRecord.chunks[0]!.chunkType).toBe('reference_record')
  })
})

describe('structured import transaction helper', () => {
  it('rolls back failed work and commits successful work', async () => {
    const calls: string[] = []
    const fakeClient = {
      query: async (sql: string) => {
        calls.push(sql)
        return { rows: [], rowCount: 0 }
      },
    } as never

    await expect(inTransaction(fakeClient, async () => 'ok')).resolves.toBe('ok')
    expect(calls).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock_shared($1::bigint)', 'COMMIT'])
    calls.length = 0
    await expect(
      inTransaction(fakeClient, async () => {
        throw new Error('expected')
      }),
    ).rejects.toThrow('expected')
    expect(calls).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock_shared($1::bigint)', 'ROLLBACK'])
  })
})
