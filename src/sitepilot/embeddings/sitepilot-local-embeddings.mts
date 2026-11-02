import process from 'node:process'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'
import type { Embedder } from '@typegraph-ai/sdk'

const MODEL_ID = 'Xenova/multilingual-e5-small'
const EMBEDDING_DIMENSIONS = 384
const MAX_BATCH_SIZE = 16
const ALLOWED_DTYPES = ['q8', 'q4', 'fp32'] as const
type EmbeddingDtype = (typeof ALLOWED_DTYPES)[number]
const MODEL_CACHE_DIRECTORY = resolve(
  process.env.HF_HOME?.trim() || join(process.cwd(), 'var/sitepilot-model-cache'),
)

// Transformers.js does not read HF_HOME itself. Point its filesystem cache at the
// configured persistent volume and avoid Node's browser-cache shim in recent runtimes.
env.cacheDir = MODEL_CACHE_DIRECTORY
env.useBrowserCache = false
env.useFSCache = true

function embeddingDtype(): EmbeddingDtype {
  const configured = process.env.SITEPILOT_EMBEDDING_DTYPE ?? 'q8'
  if (!ALLOWED_DTYPES.includes(configured as EmbeddingDtype)) {
    throw new Error('SITEPILOT_EMBEDDING_DTYPE must be q8, q4, or fp32')
  }
  return configured as EmbeddingDtype
}

function embeddingThreads(): number {
  const configured = Number(process.env.SITEPILOT_EMBEDDING_THREADS ?? 2)
  if (!Number.isInteger(configured) || configured < 1 || configured > 8) {
    throw new Error('SITEPILOT_EMBEDDING_THREADS must be an integer from 1 to 8')
  }
  return configured
}

let extractorPromise: Promise<FeatureExtractionPipeline> | undefined

function loadExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= mkdir(MODEL_CACHE_DIRECTORY, { recursive: true, mode: 0o700 })
    .then(() =>
      pipeline('feature-extraction', MODEL_ID, {
        device: 'cpu',
        dtype: embeddingDtype(),
        session_options: {
          intraOpNumThreads: embeddingThreads(),
          interOpNumThreads: 1,
          executionMode: 'sequential',
        },
      }),
    )
    .catch((error: unknown) => {
      extractorPromise = undefined
      throw new Error(`Unable to load local embedding model ${MODEL_ID}`, { cause: error })
    })
  return extractorPromise
}

export const sitePilotEmbedder: Embedder = {
  name: MODEL_ID,
  dimensions: EMBEDDING_DIMENSIONS,
  maxBatchSize: MAX_BATCH_SIZE,
  supportsAsymmetric: true,

  async embed({ texts, inputType = 'document', abortSignal }): Promise<number[][]> {
    if (texts.length === 0) return []
    if (abortSignal?.aborted) {
      throw abortSignal.reason ?? new Error('Embedding request was aborted')
    }
    if (texts.some((text) => text.trim().length === 0)) {
      throw new Error('Cannot embed empty or whitespace-only text')
    }

    const extractor = await loadExtractor()
    const prefix = inputType === 'search' ? 'query: ' : 'passage: '
    const vectors: number[][] = []

    for (let offset = 0; offset < texts.length; offset += MAX_BATCH_SIZE) {
      if (abortSignal?.aborted) {
        throw abortSignal.reason ?? new Error('Embedding request was aborted')
      }
      const batch = texts.slice(offset, offset + MAX_BATCH_SIZE).map((text) => `${prefix}${text}`)
      const output = await extractor(batch, { pooling: 'mean', normalize: true })
      const batchVectors = output.tolist() as number[][]

      if (batchVectors.length !== batch.length) {
        throw new Error(
          `Embedding model returned ${batchVectors.length} vectors for ${batch.length} inputs`,
        )
      }

      for (const vector of batchVectors) {
        if (
          vector.length !== EMBEDDING_DIMENSIONS ||
          vector.some((value) => !Number.isFinite(value))
        ) {
          throw new Error(
            `Embedding model returned an invalid vector; expected ${EMBEDDING_DIMENSIONS} finite values`,
          )
        }
        vectors.push(vector)
      }
    }

    return vectors
  },
}
