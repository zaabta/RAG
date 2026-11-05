import { resolve, join } from 'node:path'
import { AutoTokenizer, env, type PreTrainedTokenizer } from '@huggingface/transformers'

const MODEL_ID = 'Xenova/multilingual-e5-small'
const CACHE_DIRECTORY = resolve(
  process.env.HF_HOME?.trim() || join(process.cwd(), 'var/sitepilot-model-cache'),
)

env.cacheDir = CACHE_DIRECTORY
env.useBrowserCache = false
env.useFSCache = true
// Chunking must use the embedding model tokenizer already provisioned locally. Never fetch it.
env.allowRemoteModels = false

export type DocumentTokenCounter = (text: string) => number

let tokenizerPromise: Promise<PreTrainedTokenizer> | undefined

async function loadTokenizer() {
  tokenizerPromise ??= AutoTokenizer.from_pretrained(MODEL_ID, {
    cache_dir: CACHE_DIRECTORY,
    local_files_only: true,
  }).catch((error: unknown) => {
    tokenizerPromise = undefined
    throw new Error('DOCUMENT_TOKENIZER_UNAVAILABLE', { cause: error })
  })
  return tokenizerPromise
}

export async function sitePilotDocumentTokenCounter(): Promise<DocumentTokenCounter> {
  const tokenizer = await loadTokenizer()
  return (text) => {
    const encoded = tokenizer(text, {
      add_special_tokens: false,
      return_tensor: false,
    }) as { input_ids: number[] }
    return encoded.input_ids.length
  }
}
