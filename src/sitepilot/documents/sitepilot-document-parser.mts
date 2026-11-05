import { createHash } from 'node:crypto'
import mammoth from 'mammoth'
import { parseDocument } from 'htmlparser2'
import { marked, type Token } from 'marked'
import {
  sitePilotDocumentTokenCounter,
  type DocumentTokenCounter,
} from './sitepilot-document-tokenizer.mjs'

export type SupportedTextDocumentType = 'docx' | 'txt' | 'md'

export interface ParsedDocumentChunk {
  chunkId: string
  documentId: string
  content: string
  chunkIndex: number
  contentHash: string
  sourceLocation: string
  headingPath: string[]
  paragraphStart: number
  paragraphEnd: number
  lineStart?: number
  lineEnd?: number
}

export interface ParsedTextDocument {
  fileId: string
  fileName: string
  fileType: SupportedTextDocumentType
  mimeType: string
  contentHash: string
  text: string
  chunks: ParsedDocumentChunk[]
}

export interface ParseTextDocumentOptions {
  fileId: string
  fileName: string
  chunkSizeTokens?: number
  chunkOverlapTokens?: number
  tokenCounter?: DocumentTokenCounter
}

interface ContentBlock {
  text: string
  headingPath: string[]
  kind: 'paragraph' | 'list' | 'table' | 'code' | 'quote'
  paragraphStart: number
  paragraphEnd: number
  sourceStart: number
  sourceEnd: number
}

const DEFAULT_CHUNK_SIZE_TOKENS = 384
const DEFAULT_CHUNK_OVERLAP_TOKENS = 48
const MAX_DOCUMENT_CHARS = 10_000_000
const MAX_DOCUMENT_CHUNKS = 10_000

function chunkSetting(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name]
  if (raw == null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name}_INVALID`)
  return value
}

function normalizedText(value: string) {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/\u0000/gu, '')
    .normalize('NFC')
    .split('\n')
    .map((line) => line.replace(/[\t\u00a0 ]+$/gu, ''))
    .join('\n')
    .trim()
}

function normalizedDocumentText(value: string) {
  return value.replace(/\r\n?/gu, '\n').normalize('NFC')
}

function lineCount(raw: string) {
  const count = raw.split('\n').length - (raw.endsWith('\n') ? 1 : 0)
  return Math.max(1, count)
}

function settingWithLegacyChars(
  tokenName: string,
  legacyCharsName: string,
  fallback: number,
  min: number,
  max: number,
) {
  if (process.env[tokenName] !== undefined) return chunkSetting(tokenName, fallback, min, max)
  const legacy = process.env[legacyCharsName]
  if (legacy === undefined || legacy.trim() === '') return fallback
  const chars = Number(legacy)
  if (!Number.isSafeInteger(chars) || chars < (min === 0 ? 0 : 1))
    throw new Error(`${legacyCharsName}_INVALID`)
  // Backward compatibility only: actual chunk boundaries are measured by the tokenizer.
  return Math.max(min, Math.min(max, Math.round(chars / 4)))
}

function decodeUtf8(bytes: Buffer) {
  if (bytes.includes(0)) throw new Error('BINARY_TEXT_DOCUMENT')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('INVALID_UTF8_DOCUMENT')
  }
}

function extensionFor(fileName: string): SupportedTextDocumentType {
  const extension = fileName.split('.').pop()?.toLocaleLowerCase() ?? ''
  if (extension === 'docx' || extension === 'txt' || extension === 'md') return extension
  if (extension === 'doc') throw new Error('LEGACY_DOC_UNSUPPORTED')
  throw new Error('UNSUPPORTED_DOCUMENT_FORMAT')
}

function mimeFor(type: SupportedTextDocumentType) {
  if (type === 'docx')
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  return type === 'md' ? 'text/markdown' : 'text/plain'
}

function textOf(node: any): string {
  if (node.type === 'text') return node.data ?? ''
  if (node.name === 'br') return '\n'
  return Array.isArray(node.children) ? node.children.map(textOf).join('') : ''
}

function docxBlocks(html: string): ContentBlock[] {
  const root = parseDocument(html)
  const blocks: ContentBlock[] = []
  const headings: string[] = []
  let paragraph = 0
  let table = 0

  const add = (text: string, kind: ContentBlock['kind']) => {
    const clean = normalizedText(text)
    if (!clean) return
    paragraph++
    blocks.push({
      text: clean,
      kind,
      headingPath: [...headings],
      paragraphStart: paragraph,
      paragraphEnd: paragraph,
      sourceStart: paragraph,
      sourceEnd: paragraph,
    })
  }

  const tableRows = (node: any): any[][] => {
    if (!Array.isArray(node?.children)) return []
    const rows: any[][] = []
    for (const child of node.children) {
      if (child.type === 'tag' && child.name === 'tr') rows.push(child.children ?? [])
      else rows.push(...tableRows(child))
    }
    return rows
  }

  const visit = (nodes: any[]) => {
    for (const node of nodes) {
      if (node.type !== 'tag') continue
      const tag = String(node.name).toLowerCase()
      const heading = /^h([1-6])$/u.exec(tag)
      if (heading) {
        const depth = Number(heading[1])
        const title = normalizedText(textOf(node))
        headings.splice(depth - 1)
        headings[depth - 1] = title
        add(title, 'paragraph')
      } else if (tag === 'table') {
        table++
        for (const row of tableRows(node)) {
          const cells = row
            .filter((cell: any) => cell.type === 'tag' && ['td', 'th'].includes(cell.name))
            .map((cell: any) => normalizedText(textOf(cell)))
            .filter(Boolean)
          if (cells.length) add(`Table ${table}: ${cells.join(' | ')}`, 'table')
        }
      } else if (['p', 'li', 'pre', 'blockquote'].includes(tag)) {
        const kind =
          tag === 'li'
            ? 'list'
            : tag === 'pre'
              ? 'code'
              : tag === 'blockquote'
                ? 'quote'
                : 'paragraph'
        add(textOf(node), kind)
      } else {
        visit(node.children ?? [])
      }
    }
  }
  visit(root.children)
  return blocks
}

function markdownBlocks(markdown: string): ContentBlock[] {
  const blocks: ContentBlock[] = []
  const headings: string[] = []
  let paragraph = 0
  let sourceOffset = 0
  const add = (
    text: string,
    kind: ContentBlock['kind'],
    sourceStart: number,
    sourceEnd: number,
  ) => {
    const clean = normalizedText(text)
    if (clean) {
      paragraph++
      blocks.push({
        text: clean,
        kind,
        headingPath: [...headings],
        paragraphStart: paragraph,
        paragraphEnd: paragraph,
        sourceStart,
        sourceEnd,
      })
    }
  }

  const consume = (tokens: Token[]) => {
    for (const token of tokens) {
      const item = token as any
      const raw = String(item.raw ?? '')
      const startLine = markdown.slice(0, sourceOffset).split('\n').length
      sourceOffset += raw.length
      const span = lineCount(raw)
      if (item.type === 'space') continue
      if (item.type === 'heading') {
        const depth = Math.max(1, Math.min(6, Number(item.depth)))
        const title = normalizedText(String(item.text ?? ''))
        headings.splice(depth - 1)
        headings[depth - 1] = title
        add(title, 'paragraph', startLine, startLine + span - 1)
      } else if (item.type === 'paragraph') {
        add(String(item.text ?? ''), 'paragraph', startLine, startLine + span - 1)
      } else if (item.type === 'blockquote') {
        add(String(item.text ?? ''), 'quote', startLine, startLine + span - 1)
      } else if (item.type === 'code') {
        const lang = String(item.lang ?? '').trim()
        add(
          `Code${lang ? ` (${lang})` : ''}:\n${String(item.text ?? '')}`,
          'code',
          startLine,
          startLine + span - 1,
        )
      } else if (item.type === 'list') {
        let itemLine = startLine
        for (const listItem of item.items ?? []) {
          const prefix = item.ordered ? `${item.start || 1}. ` : '- '
          const itemRaw = String(listItem.raw ?? listItem.text ?? '')
          const itemSpan = lineCount(itemRaw)
          add(`${prefix}${String(listItem.text ?? '')}`, 'list', itemLine, itemLine + itemSpan - 1)
          itemLine += itemSpan
        }
      } else if (item.type === 'table') {
        const header = (item.header ?? []).map((cell: any) => String(cell.text ?? ''))
        if (header.length)
          add(`Table headers: ${header.join(' | ')}`, 'table', startLine, startLine)
        for (const [rowIndex, row] of (item.rows ?? []).entries()) {
          add(
            `Table row: ${row.map((cell: any) => String(cell.text ?? '')).join(' | ')}`,
            'table',
            startLine + rowIndex + 2,
            startLine + rowIndex + 2,
          )
        }
      } else if (item.type === 'html') {
        const htmlNodes = parseDocument(String(item.text ?? '')).children
        add(
          htmlNodes.map((node) => textOf(node)).join(''),
          'paragraph',
          startLine,
          startLine + span - 1,
        )
      } else if (item.type === 'hr') {
        // Horizontal rules consume their source lines but carry no evidence text.
      }
    }
  }
  consume(marked.lexer(markdown))
  return blocks
}

function plainTextBlocks(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = []
  const lines = text.split('\n')
  let paragraph = 0
  let start = -1
  const flush = (end: number) => {
    if (start < 0) return
    const clean = normalizedText(lines.slice(start, end + 1).join('\n'))
    if (!clean) {
      start = -1
      return
    }
    paragraph++
    blocks.push({
      text: clean,
      kind: 'paragraph',
      headingPath: [],
      paragraphStart: paragraph,
      paragraphEnd: paragraph,
      sourceStart: start + 1,
      sourceEnd: end + 1,
    })
    start = -1
  }
  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.trim()) {
      if (start < 0) start = index
    } else flush(index - 1)
  }
  flush(lines.length - 1)
  return blocks
}

function makeChunks(
  blocks: ContentBlock[],
  fileId: string,
  fileType: SupportedTextDocumentType,
  chunkSizeTokens: number,
  overlap: number,
  countTokens: DocumentTokenCounter,
): ParsedDocumentChunk[] {
  const chunks: ParsedDocumentChunk[] = []
  let current: ContentBlock[] = []

  const contentFor = (items: ContentBlock[]) => {
    const heading = items[0]?.headingPath.filter(Boolean).join(' > ') ?? ''
    const body = items.map((item) => item.text).join('\n\n')
    return `${heading ? `Heading path: ${heading}\n` : ''}${body}`
  }
  const fits = (items: ContentBlock[]) => countTokens(contentFor(items)) <= chunkSizeTokens
  const overlapTail = (block: ContentBlock) => {
    if (!overlap) return ''
    const words = block.text.match(/\S+\s*/gu) ?? []
    let suffix = ''
    for (let index = words.length - 1; index >= 0; index--) {
      const candidate = `${words[index]}${suffix}`
      if (
        countTokens(
          `${block.headingPath.length ? `Heading path: ${block.headingPath.join(' > ')}\n` : ''}${candidate}`,
        ) > overlap
      )
        break
      suffix = candidate
    }
    return suffix.trim()
  }

  const push = (items: ContentBlock[]) => {
    if (!items.length) return
    const headingPath = items[items.length - 1]!.headingPath
    const content = contentFor(items)
    const paragraphStart = Math.min(...items.map((item) => item.paragraphStart))
    const paragraphEnd = Math.max(...items.map((item) => item.paragraphEnd))
    const lineStart = Math.min(...items.map((item) => item.sourceStart))
    const lineEnd = Math.max(...items.map((item) => item.sourceEnd))
    const sourceLocation =
      fileType === 'docx'
        ? `paragraphs ${paragraphStart}-${paragraphEnd}`
        : `lines ${lineStart}-${lineEnd}`
    const contentHash = createHash('sha256').update(content).digest('hex')
    const chunkId = `doc_${createHash('sha256')
      .update(`${fileId}:${sourceLocation}:${contentHash}`)
      .digest('hex')
      .slice(0, 40)}`
    chunks.push({
      chunkId,
      documentId: fileId,
      content,
      chunkIndex: chunks.length,
      contentHash,
      sourceLocation,
      headingPath: [...headingPath],
      paragraphStart,
      paragraphEnd,
      ...(fileType === 'docx' ? {} : { lineStart, lineEnd }),
    })
  }

  const splitOversized = (block: ContentBlock) => {
    const headingBlock = (text: string): ContentBlock => ({ ...block, text })
    const bounded = (text: string): string[] => {
      if (countTokens(contentFor([headingBlock(text)])) <= chunkSizeTokens) return [text]
      const units =
        block.kind === 'code' || block.kind === 'table'
          ? text.split(/(?<=\n)/u)
          : (text.match(/\S+\s*/gu) ?? [])
      const segments: string[] = []
      let part = ''
      for (const unit of units) {
        let candidate = part + unit
        if (part && countTokens(contentFor([headingBlock(candidate)])) > chunkSizeTokens) {
          segments.push(part.trimEnd())
          const suffix = overlapTail(headingBlock(part))
          part = suffix ? `${suffix} ${unit.trimStart()}` : unit
          candidate = part
        }
        if (!part && countTokens(contentFor([headingBlock(unit)])) > chunkSizeTokens) {
          // A single oversized line/word still gets split by Unicode code point, with a
          // tokenizer check guarding every actual chunk boundary.
          let hardPart = ''
          for (const character of Array.from(unit)) {
            const hardCandidate = hardPart + character
            if (
              hardPart &&
              countTokens(contentFor([headingBlock(hardCandidate)])) > chunkSizeTokens
            ) {
              segments.push(hardPart)
              const suffix = overlapTail(headingBlock(hardPart))
              hardPart = `${suffix}${suffix ? ' ' : ''}${character}`
            } else hardPart = hardCandidate
          }
          part = hardPart
        } else part = candidate
      }
      if (part.trim()) segments.push(part.trim())
      return segments
    }
    return bounded(block.text).map((text) => ({ ...block, text }))
  }

  for (const original of blocks) {
    if (
      current.length &&
      JSON.stringify(current[current.length - 1]!.headingPath) !==
        JSON.stringify(original.headingPath)
    ) {
      push(current)
      current = []
    }
    const pieces = fits([original]) ? [original] : splitOversized(original)
    for (const piece of pieces) {
      if (current.length && !fits([...current, piece])) {
        push(current)
        const previous = current[current.length - 1]!
        const suffix = overlapTail(previous)
        const overlapBlock = suffix ? { ...previous, text: suffix } : undefined
        current = overlapBlock && fits([overlapBlock, piece]) ? [overlapBlock, piece] : [piece]
      } else {
        current = [...current, piece]
      }
      if (!fits(current)) {
        // Extremely long heading context cannot be kept intact in an embedding-sized chunk.
        throw new Error('DOCUMENT_SECTION_EXCEEDS_CHUNK_SIZE')
      }
      if (countTokens(contentFor([piece])) >= chunkSizeTokens) {
        push(current)
        current = []
      }
    }
  }
  push(current)
  return chunks.filter(
    (chunk, index) => index === 0 || chunk.contentHash !== chunks[index - 1]!.contentHash,
  )
}

export async function parseTextDocument(
  bytes: Buffer,
  options: ParseTextDocumentOptions,
): Promise<ParsedTextDocument> {
  const fileType = extensionFor(options.fileName)
  const chunkSizeTokens =
    options.chunkSizeTokens ??
    settingWithLegacyChars(
      'SITEPILOT_DOCUMENT_CHUNK_SIZE_TOKENS',
      'SITEPILOT_DOCUMENT_CHUNK_SIZE_CHARS',
      DEFAULT_CHUNK_SIZE_TOKENS,
      64,
      480,
    )
  if (!Number.isSafeInteger(chunkSizeTokens) || chunkSizeTokens < 64 || chunkSizeTokens > 480)
    throw new Error('SITEPILOT_DOCUMENT_CHUNK_SIZE_TOKENS_INVALID')
  const chunkOverlapTokens =
    options.chunkOverlapTokens ??
    settingWithLegacyChars(
      'SITEPILOT_DOCUMENT_CHUNK_OVERLAP_TOKENS',
      'SITEPILOT_DOCUMENT_CHUNK_OVERLAP_CHARS',
      DEFAULT_CHUNK_OVERLAP_TOKENS,
      0,
      240,
    )
  if (
    !Number.isSafeInteger(chunkOverlapTokens) ||
    chunkOverlapTokens < 0 ||
    chunkOverlapTokens > 240
  )
    throw new Error('SITEPILOT_DOCUMENT_CHUNK_OVERLAP_TOKENS_INVALID')
  const overlap = Math.max(0, Math.min(Math.floor(chunkSizeTokens / 2), chunkOverlapTokens))
  let text: string
  let blocks: ContentBlock[]
  if (fileType === 'docx') {
    let result: Awaited<ReturnType<typeof mammoth.convertToHtml>>
    try {
      result = await mammoth.convertToHtml({ buffer: bytes }, { externalFileAccess: false })
    } catch {
      throw new Error('INVALID_DOCX_DOCUMENT')
    }
    blocks = docxBlocks(result.value)
    text = blocks.map((block) => block.text).join('\n\n')
  } else {
    text = normalizedDocumentText(decodeUtf8(bytes))
    blocks = fileType === 'md' ? markdownBlocks(text) : plainTextBlocks(text)
  }
  if (!text.trim()) throw new Error('EMPTY_DOCUMENT')
  if (text.length > MAX_DOCUMENT_CHARS) throw new Error('DOCUMENT_TEXT_TOO_LARGE')
  if (!blocks.length) throw new Error('EMPTY_DOCUMENT')
  const countTokens = options.tokenCounter ?? (await sitePilotDocumentTokenCounter())
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const chunks = makeChunks(blocks, options.fileId, fileType, chunkSizeTokens, overlap, countTokens)
  if (!chunks.length) throw new Error('EMPTY_DOCUMENT')
  if (chunks.length > MAX_DOCUMENT_CHUNKS) throw new Error('DOCUMENT_CHUNK_LIMIT_EXCEEDED')
  return {
    fileId: options.fileId,
    fileName: options.fileName,
    fileType,
    mimeType: mimeFor(fileType),
    contentHash,
    text: text.trim(),
    chunks,
  }
}
