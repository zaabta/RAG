import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configuredLlmProvider,
  GeminiProvider,
  type GeminiClient,
} from '../src/sitepilot/agent/sitepilot-llm-provider.mjs'

function client(overrides: Partial<GeminiClient['models']> = {}): GeminiClient {
  return {
    models: {
      generateContent: vi.fn(async () => ({ text: 'synthetic answer' }) as never),
      generateContentStream: vi.fn(async () => {
        async function* chunks() {
          yield { text: 'synthetic ' } as never
          yield {
            text: 'streamed answer',
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3 },
          } as never
        }
        return chunks() as never
      }),
      ...overrides,
    },
  } as GeminiClient
}

const setup = (models = client().models, timeoutMs = 15_000) =>
  new GeminiProvider('synthetic-key', 'gemini-3.5-flash-lite', timeoutMs, {
    models,
  } as GeminiClient)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SitePilot LLM provider policy and streaming', () => {
  it('keeps external processing disabled without explicit policy', () => {
    expect(
      configuredLlmProvider({
        SITEPILOT_LLM_PROVIDER: 'gemini',
        GEMINI_API_KEY: 'synthetic-key',
      } as NodeJS.ProcessEnv),
    ).toBeNull()
  })

  it('requires provider, key, and explicit policy before creating Gemini', () => {
    const env = {
      SITEPILOT_EXTERNAL_LLM_DATA_ALLOWED: 'true',
      SITEPILOT_LLM_PROVIDER: 'gemini',
      SITEPILOT_LLM_MODEL: 'gemini-3.5-flash-lite',
      GEMINI_API_KEY: 'synthetic-key',
    } as NodeJS.ProcessEnv
    expect(configuredLlmProvider(env)).toBeInstanceOf(GeminiProvider)
    expect(configuredLlmProvider(env)?.model).toBe('gemini-3.5-flash-lite')
    expect(
      configuredLlmProvider({ ...env, SITEPILOT_LLM_PROVIDER: 'other' } as NodeJS.ProcessEnv),
    ).toBeNull()
    expect(configuredLlmProvider({ ...env, GEMINI_API_KEY: '' } as NodeJS.ProcessEnv)).toBeNull()
  })

  it('streams incremental text and returns usage metadata', async () => {
    const models = client().models
    const provider = setup(models)
    const pieces: string[] = []
    const result = await provider.stream!('synthetic prompt', (text) => pieces.push(text))
    expect(pieces).toEqual(['synthetic ', 'streamed answer'])
    expect(result).toMatchObject({
      text: 'synthetic streamed answer',
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      usage: { inputTokens: 4, outputTokens: 3 },
    })
  })

  it('maps provider rate limits and service failures to safe codes', async () => {
    for (const [status, code] of [
      [401, 'PROVIDER_AUTH_FAILED'],
      [403, 'PROVIDER_AUTH_FAILED'],
      [404, 'PROVIDER_MODEL_NOT_FOUND'],
      [429, 'PROVIDER_RATE_LIMITED'],
      [503, 'PROVIDER_UNAVAILABLE'],
      [400, 'PROVIDER_REQUEST_FAILED'],
    ] as const) {
      const models = client({
        generateContent: vi.fn(async () => {
          throw Object.assign(new Error('private provider body'), { status })
        }),
      }).models
      await expect(setup(models).generate('synthetic')).rejects.toMatchObject({ code })
    }
  })

  it('aborts provider requests on timeout and caller cancellation', async () => {
    const never = () => new Promise<never>(() => undefined)
    const timeoutModels = client({ generateContent: vi.fn(never) }).models
    await expect(setup(timeoutModels, 1_000).generate('synthetic')).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
    })

    const controller = new AbortController()
    const cancellationModels = client({ generateContent: vi.fn(never) }).models
    const pending = setup(cancellationModels).generate('synthetic', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'PROVIDER_CANCELLED' })
  })
})
