import 'dotenv/config'
import process from 'node:process'

import { typegraphDeploy, type typegraphInstance } from '@typegraph-ai/sdk'

import { parseExcelFile } from '../src/sitepilot/excel/sitepilot-excel-core.mjs'
import {
  createSitePilotExcelConfig,
  SITEPILOT_EXCEL_BUCKET_ID,
  sitePilotAccessGroup,
} from '../src/sitepilot/excel/sitepilot-excel-config.mjs'
import { SitePilotExcelStore, type PendingRecord } from '../src/sitepilot/excel/sitepilot-excel-store.mjs'

function inputPathFromArgs(args: string[]): string | undefined {
  const inputIndex = args.indexOf('--input')
  return inputIndex >= 0 ? args[inputIndex + 1] : args.find((value) => !value.startsWith('--'))
}

function typeGraphChunks(record: PendingRecord) {
  return record.chunks.map((chunk) => ({
    content: chunk.content,
    chunkIndex: chunk.chunkIndex,
    metadata: {
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      fileId: record.file_id,
      fileName: record.file_name,
      sourceFile: record.file_name,
      sheetName: chunk.sheetName,
      rowStart: chunk.rowStart,
      rowEnd: chunk.rowEnd,
      sourceRange: record.source_range,
      recordKey: chunk.recordKey,
      chunkType: chunk.chunkType,
      chunkIndex: chunk.chunkIndex,
      sourceCells: chunk.sourceCells,
      contentHash: chunk.contentHash,
      accessScope: chunk.accessScope,
      ...(chunk.narrativeField ? { narrativeField: chunk.narrativeField } : {}),
    },
  }))
}

async function ensureBucket(typegraph: typegraphInstance, groupId: string): Promise<void> {
  await typegraph.bucket.upsert(
    {
      id: SITEPILOT_EXCEL_BUCKET_ID,
      name: 'SitePilot Excel records',
      description: 'Redacted record-level chunks from the configured workbook.',
      graph: 'public',
      graphExtraction: false,
    },
    { context: { groupId } },
  )
}

async function main(): Promise<void> {
  const inputPath = inputPathFromArgs(process.argv.slice(2))
  const databaseUrl = process.env.DATABASE_URL
  if (!inputPath) throw new Error('Workbook path is required. Pass --input <workbook.xlsx>.')
  if (!databaseUrl) throw new Error('DATABASE_URL is missing')

  const groupId = sitePilotAccessGroup()
  const workbook = await parseExcelFile(inputPath, { accessScope: `group:${groupId}` })
  console.log('Parsed workbook:', {
    fileName: workbook.fileName,
    sheets: workbook.sheets.map(({ name, rowCount, columnCount, headerRow, records }) => ({
      name,
      rowCount,
      columnCount,
      headerRow,
      records: records.length,
    })),
    totalRecords: workbook.totalRecords,
    totalChunks: workbook.totalChunks,
    warnings: workbook.warnings.length,
    cellValuesLogged: false,
  })

  const store = new SitePilotExcelStore(databaseUrl)
  let typegraph: typegraphInstance | undefined
  let runId: string | undefined
  try {
    await store.migrate()
    const staged = await store.stageImport(workbook)
    runId = staged.runId
    console.log('Structured import staged:', {
      runId: staged.runId,
      inserted: staged.inserted,
      updated: staged.updated,
      unchanged: staged.unchanged,
      deleted: staged.deleted,
      chunks: staged.chunks,
      warnings: staged.warnings,
    })

    const config = createSitePilotExcelConfig(databaseUrl)
    typegraph = await typegraphDeploy(config)
    await typegraph.initialize(config)
    await ensureBucket(typegraph, groupId)

    const context = { groupId }
    let deletedDocuments = 0
    for await (const ids of store.pendingDeletionBatches(workbook.fileId, 200)) {
      deletedDocuments += await typegraph.document.delete(
        { bucketId: SITEPILOT_EXCEL_BUCKET_ID, documentIds: ids },
        { context },
      )
      for (const id of ids) await store.markRecordDeleted(id)
    }

    const pendingCount = await store.pendingRecordCount(workbook.fileId)
    let synced = 0
    const batchSize = 8
    for await (const page of store.pendingRecordBatches(workbook.fileId)) {
      for (let offset = 0; offset < page.length; offset += batchSize) {
        const batch = page.slice(offset, offset + batchSize)
        await Promise.all(
          batch.map(async (record) => {
            const content =
              record.document_content.trim() || '[Record contains only redacted fields.]'
            const document = {
              id: record.record_id,
              name: `${record.sheet_name} — ${record.form_no ?? record.record_key}`,
              description: `Source: ${workbook.fileName}; sheet ${record.sheet_name}; row ${record.source_row_start}; cells ${record.source_range}.`,
              url: `sitepilot-excel://${record.file_id}/${encodeURIComponent(record.sheet_name)}/${encodeURIComponent(record.record_key)}`,
              mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              language: 'tr',
              content,
              metadata: {
                sourceFile: workbook.fileName,
                fileId: record.file_id,
                sheetName: record.sheet_name,
                rowStart: record.source_row_start,
                rowEnd: record.source_row_end,
                sourceRange: record.source_range,
                recordKey: record.record_key,
                privacyStatus: 'redacted',
                accessScope: `group:${groupId}`,
              },
            }
            await typegraph!.document.ingestPreChunked(document, typeGraphChunks(record), {
              bucketId: SITEPILOT_EXCEL_BUCKET_ID,
              mode: 'upsert',
              graphExtraction: false,
              context,
            })
            await store.markRecordSynced(record.record_id)
          }),
        )
        synced += batch.length
        console.log(`TypeGraph synchronized ${synced}/${pendingCount} changed records.`)
      }
    }

    await store.finishImport(staged.runId, 'complete')
    console.log('Excel import complete:', {
      fileName: workbook.fileName,
      records: workbook.totalRecords,
      chunks: workbook.totalChunks,
      indexedRecords: synced,
      deletedDocuments,
      warnings: workbook.warnings.length,
      schema: 'sitepilot_excel_test',
      graphAccess: 'restricted to configured group',
    })
  } catch (error) {
    if (runId)
      await store
        .finishImport(runId, 'failed', error instanceof Error ? error.name : 'UnknownError')
        .catch(() => undefined)
    throw error
  } finally {
    await typegraph?.destroy()
    await store.close()
  }
}

main().catch((error: unknown) => {
  const kind = error instanceof Error ? error.name : 'UnknownError'
  console.error(
    `SitePilot Excel import failed (${kind}). Raw workbook values are never written to logs.`,
  )
  process.exitCode = 1
})
