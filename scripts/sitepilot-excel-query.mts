import 'dotenv/config'
import process from 'node:process'
import { basename } from 'node:path'

import { typegraphInit, type typegraphInstance } from '@typegraph-ai/sdk'

import { workbookIdentity } from '../src/sitepilot/excel/sitepilot-excel-core.mjs'
import {
  createSitePilotExcelConfig,
  SITEPILOT_EXCEL_BUCKET_ID,
  sitePilotAccessGroup,
} from '../src/sitepilot/excel/sitepilot-excel-config.mjs'
import { SitePilotExcelStore } from '../src/sitepilot/excel/sitepilot-excel-store.mjs'

function usage(): void {
  console.error(`Usage:
  pnpm run sitepilot:excel-query -- exact <workbook.xlsx> <form-no>
  pnpm run sitepilot:excel-query -- search <workbook.xlsx> <Turkish question>
  pnpm run sitepilot:excel-query -- analytics <workbook.xlsx> violations|regions|suspensions
  pnpm run sitepilot:excel-query -- analytics <workbook.xlsx> region <region>`)
}

function calendarDate(value: Date | null): string | null {
  if (!value) return null
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

async function search(typegraph: typegraphInstance, groupId: string, query: string): Promise<void> {
  const englishToTurkish = [
    [/\bpersonal protective equipment\b|\bPPE\b/gi, 'KKD kişisel koruyucu donanım'],
    [/\bhelmet\b|\bhard hat\b/gi, 'baret'],
    [/\bviolations?\b/gi, 'ihlal'],
    [/\bsuspensions?\b/gi, 'uzaklaştırma'],
  ] as const
  const expandedQuery = englishToTurkish.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    query,
  )
  const response = await typegraph.search(expandedQuery, {
    graph: 'public',
    buckets: [SITEPILOT_EXCEL_BUCKET_ID],
    resources: ['documents'],
    weights: { semantic: 0.6, bm25: 0.4, graph: false, recency: false },
    fusion: { method: 'rrf', k: 60 },
    limit: 5,
    explain: true,
    context: { groupId },
  })
  const results = response.results.chunks.map((result) => ({
    content: result.content,
    score: result.score,
    scores: result.scores,
    matchedBy: result.matchedBy,
    documentId: result.document.id,
    documentName: result.document.name,
    citation: {
      source: result.metadata.sourceFile ?? result.metadata.fileName,
      sheet: result.metadata.sheetName,
      rowStart: result.metadata.rowStart,
      rowEnd: result.metadata.rowEnd,
      sourceRange: result.metadata.sourceRange,
      sourceCells: result.metadata.sourceCells,
      recordKey: result.metadata.recordKey,
    },
  }))
  console.dir({ query, results, explanation: response.explanation }, { depth: 6 })
}

async function main(): Promise<void> {
  const [operation, inputPath, argument, ...questionParts] = process.argv
    .slice(2)
    .filter((value) => value !== '--')
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl || !operation || !inputPath) {
    usage()
    throw new Error(!databaseUrl ? 'DATABASE_URL is missing' : 'Missing query arguments')
  }
  const groupId = sitePilotAccessGroup()
  const fileId = workbookIdentity(basename(inputPath))
  const store = new SitePilotExcelStore(databaseUrl)
  let typegraph: typegraphInstance | undefined
  try {
    await store.migrate()
    if (operation === 'exact') {
      if (!argument) throw new Error('An exact Form No is required')
      const records = await store.exactFormNo(fileId, argument)
      console.dir(
        records.map((record) => ({ ...record, eventDate: calendarDate(record.eventDate) })),
        { depth: 4 },
      )
      return
    }

    if (operation === 'analytics') {
      if (argument === 'violations')
        console.dir(await store.topViolations(fileId, 100), { depth: 4 })
      else if (argument === 'regions') console.dir(await store.countByRegion(fileId), { depth: 4 })
      else if (argument === 'suspensions')
        console.dir(await store.suspensionSummary(fileId), { depth: 4 })
      else if (argument === 'region') {
        const region = questionParts.join(' ').trim()
        if (!region) throw new Error('A region value is required')
        console.log({ region, count: await store.countForRegion(fileId, region) })
      } else throw new Error('Unsupported analytics query')
      return
    }

    if (operation === 'search') {
      const question = [argument, ...questionParts].filter(Boolean).join(' ').trim()
      if (!question) throw new Error('A search question is required')
      const formNo = question.match(/\bform\s*(?:no\.?|numarası|numarasi)\s*[:#-]?\s*(\d+)\b/i)?.[1]
      if (formNo) {
        const records = await store.exactFormNo(fileId, formNo)
        if (records.length > 0) {
          console.dir(
            {
              mode: 'exact_identifier',
              query: question,
              results: records.map((record) => ({
                ...record,
                eventDate: calendarDate(record.eventDate),
                citation: {
                  source: basename(inputPath),
                  sheet: record.sheetName,
                  rowStart: record.sourceRowStart,
                  rowEnd: record.sourceRowEnd,
                  sourceRange: record.sourceRange,
                },
              })),
            },
            { depth: 4 },
          )
          return
        }
      }
      typegraph = await typegraphInit(createSitePilotExcelConfig(databaseUrl))
      await search(typegraph, groupId, question)
      return
    }
    throw new Error('Unsupported query operation')
  } finally {
    await typegraph?.destroy()
    await store.close()
  }
}

main().catch((error: unknown) => {
  console.error(
    `SitePilot Excel query failed (${error instanceof Error ? error.name : 'UnknownError'}).`,
  )
  process.exitCode = 1
})
