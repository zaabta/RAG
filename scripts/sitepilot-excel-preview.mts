import process from 'node:process'

import { exportSafePreview, parseExcelFile } from '../src/sitepilot/excel/sitepilot-excel-core.mjs'
import { sitePilotAccessGroup } from '../src/sitepilot/excel/sitepilot-excel-config.mjs'

const args = process.argv.slice(2).filter((argument) => argument !== '--')
const inputPath = args[0]
const limit = Math.max(1, Math.min(100, Number.parseInt(args[1] ?? '3', 10) || 3))

if (!inputPath) {
  console.error('Usage: pnpm run sitepilot:excel-preview -- <workbook.xlsx> [records-per-sheet]')
  process.exitCode = 2
} else {
  const groupId = sitePilotAccessGroup()
  parseExcelFile(inputPath, { accessScope: `group:${groupId}` })
    .then((workbook) => {
      console.log(
        JSON.stringify(
          {
            fileName: workbook.fileName,
            contentHash: workbook.contentHash,
            totalRecords: workbook.totalRecords,
            totalChunks: workbook.totalChunks,
            warnings: workbook.warnings.map(({ code, sheetName, rowNumber, cellRef }) => ({
              code,
              sheetName,
              rowNumber,
              cellRef,
            })),
            sheets: workbook.sheets.map((sheet) => ({
              name: sheet.name,
              rowCount: sheet.rowCount,
              columnCount: sheet.columnCount,
              headerRow: sheet.headerRow,
              records: sheet.records.slice(0, limit).map(exportSafePreview),
            })),
          },
          null,
          2,
        ),
      )
    })
    .catch(() => {
      console.error('Workbook preview failed; source cell values were not written to logs.')
      process.exitCode = 1
    })
}
