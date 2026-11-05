import { basename } from 'node:path'
import { typegraphDeploy, type typegraphInstance } from '@typegraph-ai/sdk'

import {
  createSitePilotExcelConfig,
  SITEPILOT_EXCEL_BUCKET_ID,
} from '../excel/sitepilot-excel-config.mjs'
import type { UploadProgress } from '../excel/sitepilot-excel-pipeline.mjs'
import type { ParsedTextDocument } from './sitepilot-document-parser.mjs'

async function ensureDocumentBucket(typegraph: typegraphInstance, groupId: string) {
  await typegraph.bucket.upsert(
    {
      id: SITEPILOT_EXCEL_BUCKET_ID,
      name: 'SitePilot documents',
      description: 'Authorized document chunks for SitePilot search.',
      graph: 'public',
      graphExtraction: false,
    },
    { context: { groupId } },
  )
}

export async function indexParsedDocument(
  document: ParsedTextDocument,
  databaseUrl: string,
  identity: { tenantId: string; groupId: string; userId?: string },
  onProgress: UploadProgress,
) {
  let typegraph: typegraphInstance | undefined
  try {
    const config = createSitePilotExcelConfig(databaseUrl, identity)
    typegraph = await typegraphDeploy(config)
    await typegraph.initialize(config)
    await ensureDocumentBucket(typegraph, identity.groupId)
    const sourceName = basename(document.fileName)
    const input = {
      id: document.fileId,
      name: sourceName,
      description: `${document.fileType.toUpperCase()} document uploaded to SitePilot.`,
      url: `sitepilot-document://${document.fileId}`,
      mimeType: document.mimeType,
      language: 'multilingual',
      content: document.text,
      metadata: {
        fileId: document.fileId,
        fileName: sourceName,
        sourceFile: sourceName,
        documentType: document.fileType,
        contentHash: document.contentHash,
        accessScope: `group:${identity.groupId}`,
      },
    }
    const chunks = document.chunks.map((chunk) => ({
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
      metadata: {
        chunkId: chunk.chunkId,
        fileId: document.fileId,
        fileName: sourceName,
        sourceFile: sourceName,
        sourceRange: chunk.sourceLocation,
        section: chunk.headingPath.join(' > ') || null,
        paragraphStart: chunk.paragraphStart,
        paragraphEnd: chunk.paragraphEnd,
        ...(chunk.lineStart === undefined ? {} : { lineStart: chunk.lineStart }),
        ...(chunk.lineEnd === undefined ? {} : { lineEnd: chunk.lineEnd }),
        headingPath: chunk.headingPath,
        contentHash: chunk.contentHash,
        documentType: document.fileType,
        accessScope: `group:${identity.groupId}`,
      },
    }))
    let progressChain = Promise.resolve()
    const result = await typegraph.document.ingestPreChunked(input, chunks, {
      bucketId: SITEPILOT_EXCEL_BUCKET_ID,
      mode: 'upsert',
      graphExtraction: false,
      context: {
        groupId: identity.groupId,
        ...(identity.userId ? { userId: identity.userId } : {}),
      },
      onProgress: (event) => {
        if (event.phase === 'embed')
          progressChain = progressChain.then(() => onProgress('embedding', event.done, event.total))
        if (event.phase === 'store')
          progressChain = progressChain.then(() => onProgress('indexing', event.done, event.total))
      },
    })
    await progressChain
    if (result.failedAt)
      throw Object.assign(new Error('DOCUMENT_INDEXING_FAILED'), { cause: result.failedAt.error })
    return { indexed: result.total, chunks: chunks.length }
  } finally {
    await typegraph?.destroy()
  }
}
