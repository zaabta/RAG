import { GoogleGenAI, type GenerateContentResponse } from '@google/genai'

export interface LlmGeneration {
  text: string
  provider: string
  model: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface LlmProvider {
  readonly name: string
  readonly model: string
  generate(prompt: string, signal?: AbortSignal): Promise<LlmGeneration>
  stream?(
    prompt: string,
    onText: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<LlmGeneration>
}

export interface GeminiClient {
  models: {
    generateContent(params: {
      model: string
      contents: string
      config: { abortSignal: AbortSignal }
    }): Promise<GenerateContentResponse>
    generateContentStream(params: {
      model: string
      contents: string
      config: { abortSignal: AbortSignal }
    }): Promise<AsyncGenerator<GenerateContentResponse>>
  }
}

/** External processing is unavailable unless policy, provider, and credentials are explicit. */
export function configuredLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider | null {
  if (
    env.SITEPILOT_EXTERNAL_LLM_DATA_ALLOWED !== 'true' ||
    env.SITEPILOT_LLM_PROVIDER !== 'gemini' ||
    !env.GEMINI_API_KEY
  )
    return null

  return new GeminiProvider(
    env.GEMINI_API_KEY,
    env.SITEPILOT_LLM_MODEL || 'gemini-3.5-flash-lite',
    Number(env.SITEPILOT_LLM_TIMEOUT_MS || 15_000),
  )
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini'
  private readonly client: GeminiClient

  constructor(
    apiKey: string,
    readonly model: string,
    private readonly timeoutMs = 15_000,
    client?: GeminiClient,
  ) {
    this.client = client ?? (new GoogleGenAI({ apiKey }) as unknown as GeminiClient)
  }

  async generate(prompt: string, signal?: AbortSignal): Promise<LlmGeneration> {
    return this.withRequest(signal, async (requestSignal) => {
      const response = await this.awaitWithSignal(
        this.client.models.generateContent({
          model: this.model,
          contents: prompt,
          config: { abortSignal: requestSignal },
        }),
        requestSignal,
      )
      const text = response.text?.trim()
      if (!text) throw providerError('EMPTY_PROVIDER_RESPONSE')
      return this.result(text, response)
    })
  }

  async stream(
    prompt: string,
    onText: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<LlmGeneration> {
    return this.withRequest(signal, async (requestSignal) => {
      const stream = await this.awaitWithSignal(
        this.client.models.generateContentStream({
          model: this.model,
          contents: prompt,
          config: { abortSignal: requestSignal },
        }),
        requestSignal,
      )
      const iterator = stream[Symbol.asyncIterator]()
      let text = ''
      let finalResponse: GenerateContentResponse | undefined
      try {
        while (true) {
          const next = await this.awaitWithSignal(iterator.next(), requestSignal)
          if (next.done) break
          finalResponse = next.value
          const part = next.value.text ?? ''
          if (part) {
            text += part
            onText(part)
          }
        }
      } catch (error) {
        void iterator.return?.(undefined as never)
        throw error
      }
      if (!text.trim()) throw providerError('EMPTY_PROVIDER_RESPONSE')
      return this.result(text.trim(), finalResponse)
    })
  }

  private result(text: string, response?: GenerateContentResponse): LlmGeneration {
    return {
      text,
      provider: this.name,
      model: this.model,
      usage: {
        inputTokens: response?.usageMetadata?.promptTokenCount,
        outputTokens: response?.usageMetadata?.candidatesTokenCount,
      },
    }
  }

  private async withRequest<T>(
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ) {
    const controller = new AbortController()
    const timeout = Math.max(1_000, Math.min(120_000, this.timeoutMs))
    let didTimeout = false
    const timeoutId = setTimeout(() => {
      didTimeout = true
      controller.abort(providerError('PROVIDER_TIMEOUT'))
    }, timeout)
    const relayAbort = () => controller.abort(signal?.reason)
    if (signal?.aborted) relayAbort()
    else signal?.addEventListener('abort', relayAbort, { once: true })
    try {
      return await run(controller.signal)
    } catch (error) {
      if (didTimeout) throw providerError('PROVIDER_TIMEOUT')
      if (signal?.aborted) throw providerError('PROVIDER_CANCELLED')
      const status = Number(
        (error as { status?: unknown; statusCode?: unknown })?.status ??
          (error as { statusCode?: unknown })?.statusCode,
      )
      if (status === 401 || status === 403) throw providerError('PROVIDER_AUTH_FAILED')
      if (status === 404) throw providerError('PROVIDER_MODEL_NOT_FOUND')
      if (status === 429) throw providerError('PROVIDER_RATE_LIMITED')
      if (status >= 500) throw providerError('PROVIDER_UNAVAILABLE')
      const code = (error as { code?: unknown })?.code
      if (typeof code === 'string' && code.startsWith('PROVIDER_')) throw error
      if ((error as { name?: unknown })?.name === 'AbortError')
        throw providerError('PROVIDER_CANCELLED')
      throw providerError('PROVIDER_REQUEST_FAILED')
    } finally {
      clearTimeout(timeoutId)
      signal?.removeEventListener('abort', relayAbort)
    }
  }

  private async awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason ?? providerError('PROVIDER_CANCELLED')
    let removeAbort: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(signal.reason ?? providerError('PROVIDER_CANCELLED'))
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbort = () => signal.removeEventListener('abort', onAbort)
    })
    try {
      return await Promise.race([promise, aborted])
    } finally {
      removeAbort()
    }
  }
}

function providerError(code: string) {
  return Object.assign(new Error(code), { code })
}
