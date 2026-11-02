import process from 'node:process'

import { createPgAdapter } from '@typegraph-ai/adapter-pgvector-pg'
import type { typegraphConfig } from '@typegraph-ai/sdk'

import { sitePilotEmbedder } from '../embeddings/sitepilot-local-embeddings.mjs'

export function createSitePilotConfig(databaseUrl: string): typegraphConfig {
  const schema = process.env.SITEPILOT_PG_SCHEMA?.trim() || 'sitepilot_test'
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) {
    throw new Error('SITEPILOT_PG_SCHEMA must be a PostgreSQL identifier of at most 63 characters')
  }

  return {
    vectorStore: createPgAdapter(databaseUrl, {
      poolOptions: { max: 5 },
      // Keep the smoke test's schema isolated from existing TypeGraph tables.
      schema,
    }),
    embedding: sitePilotEmbedder,
    searchEmbedding: sitePilotEmbedder,
  }
}
