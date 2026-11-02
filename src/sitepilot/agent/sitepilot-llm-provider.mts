import { GoogleGenAI, type GenerateContentResponse } from '@google/genai'

export interface LlmGeneration {
  text: string
  provider: string
  model: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmProvider {
  readonly name: string
  readonly model: string
  generate(
    prompt: string,
    signal?: AbortSignal,
    messages?: readonly LlmChatMessage[],
  ): Promise<LlmGeneration>
  stream?(
    prompt: string,
    onText: (text: string) => void,
    signal?: AbortSignal,
    messages?: readonly LlmChatMessage[],
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

/** External providers require explicit policy and credentials; Ollama is restricted to local URLs. */
export function configuredLlmProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider | null {
  const provider = env.SITEPILOT_LLM_PROVIDER
  if (provider === 'ollama') {
    const baseUrl = env.SITEPILOT_OLLAMA_BASE_URL || 'http://host.docker.internal:11434'
    if (!isLocalOllamaUrl(baseUrl)) return null
    return new OllamaProvider(
      baseUrl,
      env.SITEPILOT_LLM_MODEL || 'qwen3:8b',
      Number(env.SITEPILOT_LLM_TIMEOUT_MS || 15_000),
    )
  }
  if (
    env.SITEPILOT_EXTERNAL_LLM_DATA_ALLOWED !== 'true' ||
    provider !== 'gemini' ||
    !env.GEMINI_API_KEY
  )
    return null

  return new GeminiProvider(
    env.GEMINI_API_KEY,
    env.SITEPILOT_LLM_MODEL || 'gemini-3.5-flash-lite',
    Number(env.SITEPILOT_LLM_TIMEOUT_MS || 15_000),
  )
}

type OllamaMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type OllamaResponse = {
  message?: { content?: string; thinking?: string }
  done?: boolean
  prompt_eval_count?: number
  eval_count?: number
}
export type OllamaFetch = (input: string | URL, init?: RequestInit) => Promise<Response>

/** Ollama is treated as local-only. This prevents accidentally sending RAG data to a public URL. */
export function isLocalOllamaUrl(value: string) {
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return false
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (['localhost', 'host.docker.internal', '::1'].includes(host)) return true
    const octets = host.split('.').map(Number)
    if (
      octets.length !== 4 ||
      octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    )
      return false
    return (
      octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    )
  } catch {
    return false
  }
}

export class OllamaProvider implements LlmProvider {
  readonly name = 'ollama'
  private readonly baseUrl: string

  constructor(
    baseUrl: string,
    readonly model: string,
    private readonly timeoutMs = 15_000,
    private readonly fetcher: OllamaFetch = fetch,
  ) {
    if (!isLocalOllamaUrl(baseUrl)) throw providerError('OLLAMA_URL_NOT_LOCAL')
    this.baseUrl = baseUrl.replace(/\/+$/, '')
  }

  async generate(
    prompt: string,
    signal?: AbortSignal,
    messages?: readonly LlmChatMessage[],
  ): Promise<LlmGeneration> {
    return this.withRequest(signal, async (requestSignal) => {
      const response = await this.fetcher(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(this.payload(prompt, messages, false)),
        signal: requestSignal,
      })
      await assertOllamaResponse(response)
      const result = (await response.json()) as OllamaResponse
      const text = stripThinking(result.message?.content ?? '').trim()
      if (!text) throw providerError('EMPTY_PROVIDER_RESPONSE')
      return this.result(text, result)
    })
  }

  async stream(
    prompt: string,
    onText: (text: string) => void,
    signal?: AbortSignal,
    messages?: readonly LlmChatMessage[],
  ): Promise<LlmGeneration> {
    return this.withRequest(signal, async (requestSignal) => {
      const response = await this.fetcher(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
        body: JSON.stringify(this.payload(prompt, messages, true)),
        signal: requestSignal,
      })
      await assertOllamaResponse(response)
      if (!response.body) throw providerError('PROVIDER_REQUEST_FAILED')

      const filter = new ThinkingFilter()
      const decoder = new TextDecoder()
      const reader = response.body.getReader()
      let buffer = ''
      let text = ''
      let finalResponse: OllamaResponse | undefined
      const accept = (raw: string) => {
        if (!raw.trim()) return
        let item: OllamaResponse
        try {
          item = JSON.parse(raw) as OllamaResponse
        } catch {
          throw providerError('PROVIDER_INVALID_RESPONSE')
        }
        finalResponse = item
        // The separate Ollama `thinking` field is deliberately ignored.
        const safeText = filter.push(item.message?.content ?? '')
        if (safeText) {
          text += safeText
          onText(safeText)
        }
      }
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) accept(line)
        }
        buffer += decoder.decode()
        if (buffer.trim()) accept(buffer)
      } catch (error) {
        void reader.cancel().catch(() => undefined)
        throw error
      } finally {
        reader.releaseLock()
      }
      const trailing = filter.finish()
      if (trailing) {
        text += trailing
        onText(trailing)
      }
      if (!text.trim()) throw providerError('EMPTY_PROVIDER_RESPONSE')
      return this.result(text.trim(), finalResponse)
    })
  }

  private payload(
    prompt: string,
    messages: readonly LlmChatMessage[] | undefined,
    stream: boolean,
  ) {
    return {
      model: this.model,
      messages: messages?.length ? messages : [{ role: 'user' as const, content: prompt }],
      stream,
      ...(isQwen3(this.model) ? { think: false } : {}),
    }
  }

  private result(text: string, response?: OllamaResponse): LlmGeneration {
    return {
      text,
      provider: this.name,
      model: this.model,
      usage: {
        inputTokens: response?.prompt_eval_count,
        outputTokens: response?.eval_count,
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
      return await this.awaitWithSignal(run(controller.signal), controller.signal)
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
      if (status >= 500 || (error as { name?: unknown })?.name === 'TypeError')
        throw providerError('PROVIDER_UNAVAILABLE')
      const code = (error as { code?: unknown })?.code
      if (
        code === 'MODEL_NOT_INSTALLED' ||
        (typeof code === 'string' && code.startsWith('PROVIDER_'))
      )
        throw error
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
    let removeAbort = () => {}
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

async function assertOllamaResponse(response: Response) {
  if (response.ok) return
  if (response.status === 404) {
    let errorText = ''
    try {
      const payload = (await response.clone().json()) as { error?: unknown }
      if (typeof payload.error === 'string') errorText = payload.error
    } catch {
      // Ignore provider response bodies; never include them in errors or logs.
    }
    if (/model.{0,100}(not found|does not exist|not installed|unavailable)/i.test(errorText))
      throw providerError('MODEL_NOT_INSTALLED')
  }
  throw Object.assign(new Error('OLLAMA_HTTP_ERROR'), { status: response.status })
}

function isQwen3(model: string) {
  return /^qwen3(?::|$)/i.test(model.trim())
}

function stripThinking(value: string) {
  return value.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
}

/** Withholds partial think tags and all reasoning text, even when tags span NDJSON chunks. */
class ThinkingFilter {
  private buffer = ''
  private thinking = false

  push(value: string) {
    this.buffer += value
    let output = ''
    while (this.buffer) {
      const marker = this.thinking ? '</think>' : '<think>'
      const index = this.buffer.toLowerCase().indexOf(marker)
      if (index >= 0) {
        if (!this.thinking) output += this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + marker.length)
        this.thinking = !this.thinking
        continue
      }
      const hold = marker.length - 1
      if (this.buffer.length <= hold) break
      const ready = this.buffer.slice(0, -hold)
      if (!this.thinking) output += ready
      this.buffer = this.buffer.slice(-hold)
      break
    }
    return output
  }

  finish() {
    const output = this.thinking ? '' : this.buffer
    this.buffer = ''
    return output
  }
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
