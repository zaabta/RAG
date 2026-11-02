import process from 'node:process'

import { parseExcelFile } from '../src/sitepilot/excel/sitepilot-excel-core.mjs'

const inputPath = process.argv.slice(2).find((argument) => argument !== '--')
if (!inputPath) {
  console.error('Usage: pnpm run sitepilot:excel-audit -- <workbook.xlsx>')
  process.exitCode = 2
} else {
  parseExcelFile(inputPath)
    .then((workbook) => {
      console.log(
        JSON.stringify(
          {
            fileName: workbook.fileName,
            sheets: workbook.sheets.map((sheet) => ({
              name: sheet.name,
              physicalRows: sheet.rowCount,
              physicalColumns: sheet.columnCount,
              headerRow: sheet.headerRow,
              records: sheet.records.length,
              chunks: sheet.records.reduce((sum, record) => sum + record.chunks.length, 0),
              recordsWithSensitiveFieldsRedacted: sheet.records.filter(
                (record) => record.sensitiveFieldsRedacted.length > 0,
              ).length,
              sensitiveValuesRedacted: sheet.records.reduce(
                (sum, record) => sum + record.sensitiveFieldsRedacted.length,
                0,
              ),
            })),
            totalRecords: workbook.totalRecords,
            totalChunks: workbook.totalChunks,
            warnings: workbook.warnings.reduce<Record<string, number>>((counts, warning) => {
              counts[warning.code] = (counts[warning.code] ?? 0) + 1
              return counts
            }, {}),
            rawCellValuesPrinted: false,
          },
          null,
          2,
        ),
      )
    })
    .catch(() => {
      console.error('Workbook audit failed; raw cell values were not written to logs.')
      process.exitCode = 1
    })
}
