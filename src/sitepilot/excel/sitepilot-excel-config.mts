import process from 'node:process'

import { createPgAdapter } from '@typegraph-ai/adapter-pgvector-pg'
import type { typegraphConfig } from '@typegraph-ai/sdk'

import { sitePilotEmbedder } from '../embeddings/sitepilot-local-embeddings.mjs'

export const SITEPILOT_EXCEL_GRAPH_ID = 'public'
export const SITEPILOT_EXCEL_BUCKET_ID = 'sitepilot_excel_records'
export const SITEPILOT_EXCEL_TENANT_ID = 'sitepilot_excel_test'
export const SITEPILOT_EXCEL_SCHEMA = 'sitepilot_excel_test'

export interface SitePilotIdentity {
  tenantId: string
  groupId: string
  userId?: string
}

export function sitePilotAccessGroup(): string {
  const groupId = process.env.SITEPILOT_ACCESS_GROUP_ID?.trim()
  if (!groupId) {
    throw new Error(
      'SITEPILOT_ACCESS_GROUP_ID is required; set it from the authenticated caller identity',
    )
  }
  if (groupId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(groupId)) {
    throw new Error(
      'SITEPILOT_ACCESS_GROUP_ID must be 1-128 letters, digits, underscores, or hyphens',
    )
  }
  return groupId
}

export function createSitePilotExcelConfig(
  databaseUrl: string,
  identity: SitePilotIdentity = {
    tenantId: SITEPILOT_EXCEL_TENANT_ID,
    groupId: sitePilotAccessGroup(),
  },
): typegraphConfig {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(identity.tenantId)) {
    throw new Error(
      'Authenticated tenant ID must be 1-128 letters, digits, underscores, or hyphens',
    )
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(identity.groupId)) {
    throw new Error('Authenticated group ID must be 1-128 letters, digits, underscores, or hyphens')
  }
  const groupId = identity.groupId
  const access = { groups: [groupId] }
  return {
    tenantId: identity.tenantId,
    vectorStore: createPgAdapter(databaseUrl, {
      schema: SITEPILOT_EXCEL_SCHEMA,
      poolOptions: { max: 4 },
    }),
    embedding: sitePilotEmbedder,
    searchEmbedding: sitePilotEmbedder,
    graphs: {
      public: {
        name: 'SitePilot Excel restricted test records',
        description: 'Redacted Excel records restricted to the configured analyst group.',
        access: { read: access, write: access },
      },
    },
  }
}
