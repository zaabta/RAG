import 'dotenv/config'
import process from 'node:process'

import { typegraphDeploy } from '@typegraph-ai/sdk'

import { createSitePilotConfig } from '../src/sitepilot/typegraph/sitepilot-config.mjs'
import { sitePilotEmbedder } from '../src/sitepilot/embeddings/sitepilot-local-embeddings.mjs'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is missing')

  const config = createSitePilotConfig(databaseUrl)
  const typegraph = await typegraphDeploy(config)
  try {
    await typegraph.initialize(config)
    const [embedding] = await sitePilotEmbedder.embed({
      texts: ['SitePilot local embedding readiness check'],
      inputType: 'document',
    })
    if (embedding?.length !== sitePilotEmbedder.dimensions) {
      throw new Error('Local embedding model returned an unexpected vector dimension')
    }
    console.log('TypeGraph initialized with local CPU embeddings.')
    console.log(`Model: ${sitePilotEmbedder.name} (${embedding.length} dimensions)`)
  } finally {
    await typegraph.destroy()
  }
}

main().catch((error: unknown) => {
  console.error('TypeGraph local smoke check failed:', error)
  process.exitCode = 1
})
