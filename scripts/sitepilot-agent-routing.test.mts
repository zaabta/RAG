import { describe, expect, it } from 'vitest'

import {
  planAgentTools,
  selectAgentTools,
  type AgentToolPlan,
} from '../src/sitepilot/agent/sitepilot-workspace.mjs'
import type { LlmProvider } from '../src/sitepilot/agent/sitepilot-llm-provider.mjs'

function routingProvider(response: unknown) {
  let capturedMessages: unknown
  const provider: LlmProvider = {
    name: 'ollama',
    model: 'qwen3:8b',
    async generate(_prompt, _signal, messages) {
      capturedMessages = messages
      return { text: JSON.stringify(response), provider: this.name, model: this.model }
    },
  }
  return { provider, messages: () => capturedMessages }
}

describe('model-driven SitePilot tool selection', () => {
  it('keeps commercial pricing out of structured spreadsheet analytics', () => {
    expect(planAgentTools('كم سعر باقة Enterprise بالدولار شهريًا؟').tools).toEqual([
      'typegraph_hybrid_search',
    ])
    expect(planAgentTools('Count records grouped by region in the workbook.').tools).toEqual([
      'structured_excel_query',
    ])
  })

  it('recognizes a greeting combined with a capabilities question without retrieval', () => {
    expect(planAgentTools('hi how are you ? and what can you do it').tools).toEqual([
      'conversation_reply',
    ])
  })

  it('routes a monthly product price question to document knowledge, not spreadsheet analytics', async () => {
    const mock = routingProvider({
      intent: 'document_knowledge',
      tools: ['typegraph_hybrid_search'],
      maxCalls: 2,
      directAnswer: null,
    } satisfies AgentToolPlan)
    const result = await selectAgentTools('كم سعر باقة Enterprise بالدولار شهريًا؟', mock.provider)
    expect(result.plan?.tools).toEqual(['typegraph_hybrid_search'])
    expect(JSON.stringify(mock.messages())).toContain('كم سعر باقة Enterprise')
  })

  it('selects structured analytics for an explicit spreadsheet aggregation', async () => {
    const mock = routingProvider({
      intent: 'spreadsheet_analytics',
      tools: ['structured_excel_query'],
      maxCalls: 2,
      directAnswer: null,
    } satisfies AgentToolPlan)
    const result = await selectAgentTools(
      'Count records grouped by region in the workbook.',
      mock.provider,
    )
    expect(result.plan?.tools).toEqual(['structured_excel_query'])
  })

  it('returns an uncited direct response for general conversation', async () => {
    const mock = routingProvider({
      intent: 'conversation',
      tools: ['conversation_reply'],
      maxCalls: 2,
      directAnswer:
        'Hi! I can answer questions from your authorized documents and analyze spreadsheets.',
    } satisfies AgentToolPlan)
    const result = await selectAgentTools('hi how are you and what can you do?', mock.provider)
    expect(result.plan?.intent).toBe('conversation')
    expect(result.plan?.directAnswer).toContain('authorized documents')
  })

  it('allows bounded mixed spreadsheet and document retrieval', async () => {
    const mock = routingProvider({
      intent: 'mixed',
      tools: ['structured_excel_query', 'typegraph_hybrid_search'],
      maxCalls: 2,
      directAnswer: null,
    } satisfies AgentToolPlan)
    const result = await selectAgentTools(
      'Calculate the annual total from the workbook and explain the policy that applies.',
      mock.provider,
    )
    expect(result.plan?.tools).toHaveLength(2)
    expect(result.plan?.maxCalls).toBe(2)
  })

  it('rejects invalid tool names and over-broad plans', async () => {
    const mock = routingProvider({
      intent: 'spreadsheet_analytics',
      tools: ['structured_excel_query', 'list_documents', 'typegraph_hybrid_search'],
      directAnswer: null,
    })
    const result = await selectAgentTools('Question', mock.provider)
    expect(result.plan).toBeNull()
  })
})
