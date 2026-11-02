import 'dotenv/config'
import process from 'node:process'

import { typegraphDeploy, type typegraphInstance } from '@typegraph-ai/sdk'

import { createSitePilotConfig } from '../src/sitepilot/typegraph/sitepilot-config.mjs'

const DOCUMENT_ID = 'sitepilot-inspection-ins-104'
const DOCUMENT_CONTENT = `Project A - Zone B
Inspection Number: INS-104
Status: Delayed
Reason: Missing material certificates.
Assigned Engineer: Ahmed.
Inspection must be rescheduled after certificates are approved.`
const QUERY = 'Why was inspection INS-104 delayed?'

async function runSearch(typegraph: typegraphInstance): Promise<void> {
  const ingest = await typegraph.document.ingest(
    {
      id: DOCUMENT_ID,
      name: 'Inspection INS-104',
      description: 'Inspection delay record for Project A, Zone B.',
      content: DOCUMENT_CONTENT,
      url: 'sitepilot://sample/inspection-ins-104.txt',
      mimeType: 'text/plain',
      language: 'en',
      metadata: {
        source: 'sitepilot-sample',
        fileName: 'inspection-ins-104.txt',
        project: 'Project A',
        zone: 'Zone B',
        inspectionNumber: 'INS-104',
      },
    },
    { mode: 'upsert', graphExtraction: false },
  )
  console.log('Ingestion:', ingest)

  const storedDocument = await typegraph.document.get(DOCUMENT_ID)
  if (storedDocument?.metadata.source !== 'sitepilot-sample') {
    throw new Error('The ingested document did not retain its source metadata')
  }

  const response = await typegraph.search(QUERY, {
    resources: ['documents'],
    weights: { semantic: 0.6, bm25: 0.4, graph: false, recency: false },
    fusion: { method: 'rrf', k: 60 },
    limit: 5,
    explain: true,
  })

  const chunks = response.results.chunks
  console.log('\nRetrieved documents and chunks:')
  console.dir(
    chunks.map((result) => ({
      document: result.document,
      documentMetadata: storedDocument.metadata,
      chunk: result.chunk,
      content: result.content,
      score: result.score,
      scores: result.scores,
      matchedBy: result.matchedBy,
      metadata: result.metadata,
    })),
    { depth: 6 },
  )

  console.log('\nRetrieval explanation:')
  console.dir(response.explanation, { depth: 6 })
  console.log('\nStored source metadata:')
  console.dir(storedDocument.metadata, { depth: 4 })

  const groundedChunk = chunks.find(
    (result) =>
      result.document.id === DOCUMENT_ID &&
      result.content.includes('Missing material certificates.'),
  )
  if (!groundedChunk) {
    throw new Error('Hybrid search did not retrieve the INS-104 delay reason as source evidence')
  }

  console.log(
    '\nGrounded result: Inspection INS-104 was delayed because material certificates were missing.',
  )
  console.log(`Evidence source: ${groundedChunk.document.name} (${groundedChunk.document.id})`)
  console.log(`Matched retrieval paths: ${groundedChunk.matchedBy.join(', ') || 'not reported'}`)
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is missing')

  const config = createSitePilotConfig(databaseUrl)
  const typegraph = await typegraphDeploy(config)
  try {
    await typegraph.initialize(config)
    await runSearch(typegraph)
  } finally {
    await typegraph.destroy()
  }
}

main().catch((error: unknown) => {
  console.error('SitePilot local ingestion/search failed:', error)
  process.exitCode = 1
})
