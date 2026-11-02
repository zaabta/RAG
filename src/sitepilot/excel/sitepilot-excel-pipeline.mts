import { basename } from 'node:path'

import { typegraphDeploy, type typegraphInstance } from '@typegraph-ai/sdk'

import type { ParsedExcelWorkbook } from './sitepilot-excel-core.mjs'
import {
  createSitePilotExcelConfig,
  SITEPILOT_EXCEL_BUCKET_ID,
  type SitePilotIdentity,
} from './sitepilot-excel-config.mjs'
import { SitePilotExcelStore } from './sitepilot-excel-store.mjs'

export type UploadProgressStage = 'structured_import' | 'embedding' | 'indexing'
export type UploadProgress = (
  stage: UploadProgressStage,
  processed: number,
  total: number | null,
) => Promise<void>

function typeGraphChunks(record: import('./sitepilot-excel-store.mjs').PendingRecord) {
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
      description: 'Redacted record-level chunks from uploaded workbooks.',
      graph: 'public',
      graphExtraction: false,
    },
    { context: { groupId } },
  )
}

export async function syncParsedExcelWorkbook(
  workbook: ParsedExcelWorkbook,
  databaseUrl: string,
  identity: SitePilotIdentity,
  onProgress: UploadProgress,
): Promise<{
  inserted: number
  updated: number
  unchanged: number
  deleted: number
  indexed: number
}> {
  const store = new SitePilotExcelStore(databaseUrl)
  let typegraph: typegraphInstance | undefined
  let runId: string | undefined
  try {
    await store.migrate()
    const staged = await store.stageImport(workbook, (processed, total) =>
      onProgress('structured_import', processed, total),
    )
    runId = staged.runId

    const config = createSitePilotExcelConfig(databaseUrl, identity)
    typegraph = await typegraphDeploy(config)
    await typegraph.initialize(config)
    await ensureBucket(typegraph, identity.groupId)

    const pendingCount = await store.pendingRecordCount(workbook.fileId)
    const deletionCount = await store.pendingDeletionCount(workbook.fileId)
    const alreadySynced = await store.syncedRecordCount(workbook.fileId)
    const totalIndexUnits = alreadySynced + pendingCount + deletionCount
    let indexed = alreadySynced
    await onProgress('embedding', alreadySynced, alreadySynced + pendingCount)

    let synced = 0
    const batchSize = 8
    for await (const page of store.pendingRecordBatches(workbook.fileId)) {
      for (let offset = 0; offset < page.length; offset += batchSize) {
        const batch = page.slice(offset, offset + batchSize)
        const observedSdkPhases = new Set<string>()
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
                accessScope: `group:${identity.groupId}`,
              },
            }
            await typegraph!.document.ingestPreChunked(document, typeGraphChunks(record), {
              bucketId: SITEPILOT_EXCEL_BUCKET_ID,
              mode: 'upsert',
              graphExtraction: false,
              context: { groupId: identity.groupId, userId: identity.userId },
              onProgress: (event) => {
                observedSdkPhases.add(event.phase)
              },
            })
            await store.markRecordSynced(record.record_id)
            synced++
          }),
        )
        indexed += batch.length
        await onProgress('embedding', alreadySynced + synced, alreadySynced + pendingCount)
        if (
          pendingCount > 0 &&
          (!observedSdkPhases.has('embed') || !observedSdkPhases.has('store'))
        ) {
          throw new Error(
            'TypeGraph ingestion did not report embedding and indexing progress callbacks',
          )
        }
      }
    }

    await onProgress('indexing', indexed, totalIndexUnits)
    for await (const ids of store.pendingDeletionBatches(workbook.fileId, 200)) {
      await typegraph.document.delete(
        { bucketId: SITEPILOT_EXCEL_BUCKET_ID, documentIds: ids },
        { context: { groupId: identity.groupId, userId: identity.userId } },
      )
      for (const id of ids) await store.markRecordDeleted(id)
      indexed += ids.length
      await onProgress('indexing', indexed, totalIndexUnits)
    }

    await store.finishImport(staged.runId, 'complete')
    return {
      inserted: staged.inserted,
      updated: staged.updated,
      unchanged: staged.unchanged,
      deleted: staged.deleted,
      indexed: alreadySynced + synced,
    }
  } catch (error) {
    if (runId) {
      await store
        .finishImport(runId, 'failed', error instanceof Error ? error.name : 'UnknownError')
        .catch(() => undefined)
    }
    throw error
  } finally {
    await typegraph?.destroy()
    await store.close()
  }
}

export function uploadedWorkbookDisplayName(fileName: string): string {
  return basename(fileName)
}
