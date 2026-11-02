import { describe, expect, it, vi } from 'vitest'
import {
  configuredLlmProvider,
  isLocalOllamaUrl,
  OllamaProvider,
  type OllamaFetch,
} from '../src/sitepilot/agent/sitepilot-llm-provider.mjs'
import type { LlmChatMessage } from '../src/sitepilot/agent/sitepilot-llm-provider.mjs'

const chatMessages: LlmChatMessage[] = [
  { role: 'system', content: 'Only use verified evidence.' },
  { role: 'user', content: 'What does the report say?' },
  { role: 'assistant', content: 'It reports three items.' },
  { role: 'user', content: 'Is that correct? Evidence: three.' },
]

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function ndjsonResponse(items: unknown[]) {
  const encoder = new TextEncoder()
  const chunks = items.map((item) => encoder.encode(`${JSON.stringify(item)}\n`))
  return new Response(
    new ReadableStream({
      pull(controller) {
        const next = chunks.shift()
        if (next) controller.enqueue(next)
        else controller.close()
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson' } },
  )
}

describe('SitePilot Ollama provider', () => {
  it('configures local Ollama with external processing disabled and rejects public URLs', () => {
    const provider = configuredLlmProvider({
      SITEPILOT_LLM_PROVIDER: 'ollama',
      SITEPILOT_EXTERNAL_LLM_DATA_ALLOWED: 'false',
    } as NodeJS.ProcessEnv)
    expect(provider).toBeInstanceOf(OllamaProvider)
    expect(provider).toMatchObject({ name: 'ollama', model: 'qwen3:8b' })
    expect(isLocalOllamaUrl('http://host.docker.internal:11434')).toBe(true)
    expect(isLocalOllamaUrl('http://192.168.1.20:11434')).toBe(true)
    expect(isLocalOllamaUrl('http://ollama.example.com:11434')).toBe(false)
    expect(isLocalOllamaUrl('http://user:password@localhost:11434')).toBe(false)
    expect(
      configuredLlmProvider({
        SITEPILOT_LLM_PROVIDER: 'ollama',
        SITEPILOT_OLLAMA_BASE_URL: 'https://public.example/api',
      } as NodeJS.ProcessEnv),
    ).toBeNull()
  })

  it('sends native chat messages, system prompt, history, and Qwen3 think=false', async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetcher: OllamaFetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return response({
        message: { role: 'assistant', content: 'A verified answer.', thinking: 'hidden reasoning' },
        prompt_eval_count: 23,
        eval_count: 5,
      })
    })
    const provider = new OllamaProvider(
      'http://host.docker.internal:11434/',
      'qwen3:8b',
      5_000,
      fetcher,
    )
    const result = await provider.generate('fallback prompt', undefined, chatMessages)
    expect(fetcher).toHaveBeenCalledWith(
      'http://host.docker.internal:11434/api/chat',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ accept: 'application/json' }),
      }),
    )
    expect(requestBody).toMatchObject({
      model: 'qwen3:8b',
      stream: false,
      think: false,
      messages: chatMessages,
    })
    expect(result).toEqual({
      text: 'A verified answer.',
      provider: 'ollama',
      model: 'qwen3:8b',
      usage: { inputTokens: 23, outputTokens: 5 },
    })
  })

  it('streams content incrementally while suppressing thinking fields and split think blocks', async () => {
    let requestBody: Record<string, unknown> | undefined
    const fetcher: OllamaFetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return ndjsonResponse([
        { message: { content: 'Answer <thi', thinking: 'must never be shown' }, done: false },
        {
          message: {
            content: 'nk>private</think>Visible answer <think>still private</think> done',
          },
          done: false,
        },
        { message: { content: '' }, done: true, prompt_eval_count: 12, eval_count: 4 },
      ])
    })
    const provider = new OllamaProvider('http://127.0.0.1:11434', 'qwen3:8b', 5_000, fetcher)
    const deltas: string[] = []
    const result = await provider.stream(
      'fallback prompt',
      (text) => deltas.push(text),
      undefined,
      chatMessages,
    )
    expect(requestBody).toMatchObject({ stream: true, think: false, messages: chatMessages })
    expect(deltas.join('')).toContain('Visible answer')
    expect(deltas.join('')).not.toContain('private')
    expect(deltas.join('')).not.toContain('must never')
    expect(result).toMatchObject({
      text: expect.stringContaining('Visible answer'),
      provider: 'ollama',
      model: 'qwen3:8b',
      usage: { inputTokens: 12, outputTokens: 4 },
    })
  })

  it('maps missing-model and unavailable-server errors to safe codes', async () => {
    const missingModel: OllamaFetch = vi.fn(async () =>
      response({ error: "model 'qwen3:8b' not found, try pulling it first" }, 404),
    )
    await expect(
      new OllamaProvider('http://localhost:11434', 'qwen3:8b', 5_000, missingModel).generate(
        'synthetic',
      ),
    ).rejects.toMatchObject({ code: 'MODEL_NOT_INSTALLED' })
    const missingRoute: OllamaFetch = vi.fn(async () => response({ error: 'route not found' }, 404))
    await expect(
      new OllamaProvider('http://localhost:11434', 'qwen3:8b', 5_000, missingRoute).generate(
        'synthetic',
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_MODEL_NOT_FOUND' })
    const unavailable: OllamaFetch = vi.fn(async () => response({}, 503))
    await expect(
      new OllamaProvider('http://localhost:11434', 'qwen3:8b', 5_000, unavailable).generate(
        'synthetic',
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' })
  })

  it('honors timeout and caller cancellation', async () => {
    const waitsForAbort: OllamaFetch = vi.fn(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal
          const fail = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted) fail()
          else signal?.addEventListener('abort', fail, { once: true })
        }),
    )
    await expect(
      new OllamaProvider('http://localhost:11434', 'qwen3:8b', 1_000, waitsForAbort).generate(
        'synthetic',
      ),
    ).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' })

    const controller = new AbortController()
    const pending = new OllamaProvider(
      'http://localhost:11434',
      'qwen3:8b',
      10_000,
      waitsForAbort,
    ).generate('synthetic', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' })
  })
})
