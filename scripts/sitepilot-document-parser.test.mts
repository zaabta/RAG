import JSZip from 'jszip'
import { describe, expect, it } from 'vitest'
import { parseTextDocument } from '../src/sitepilot/documents/sitepilot-document-parser.mjs'
import {
  safeFileName,
  UploadRequestError,
  validateDocxArchive,
  validateSupportedUpload,
} from '../src/sitepilot/api/sitepilot-upload-server.mjs'

const tokenCounter = (text: string) => (text.match(/\S+/gu) ?? []).length

async function docxFixture() {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  )
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`,
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Synthetic Q3 Report</w:t></w:r></w:p><w:p><w:r><w:t>The forecast target is amber.</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tblGrid/><w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Accounts</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`,
  )
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

describe('SitePilot document parsing and validation', () => {
  it('normalizes UTF-8 TXT and preserves paragraphs and stable chunk IDs', async () => {
    const bytes = Buffer.from('İstanbul\r\nÇalışma tamamlandı.\r\n\r\nمرحبا بالعالم', 'utf8')
    const options = { fileId: 'fixture_text', fileName: 'synthetic.txt', tokenCounter }
    const first = await parseTextDocument(bytes, options)
    const retry = await parseTextDocument(bytes, options)
    expect(first.text).toBe('İstanbul\nÇalışma tamamlandı.\n\nمرحبا بالعالم')
    expect(first.chunks.map((chunk) => chunk.chunkId)).toEqual(
      retry.chunks.map((chunk) => chunk.chunkId),
    )
    expect(first.chunks[0]?.sourceLocation).toBe('lines 1-4')
    expect(first.chunks[0]?.lineStart).toBe(1)
    expect(first.chunks[0]?.lineEnd).toBe(4)
  })

  it('retains Markdown heading hierarchy, lists, tables, and code blocks', async () => {
    const source = [
      '# Quarterly report',
      '',
      'Summary paragraph.',
      '',
      '## Details',
      '',
      '- First item',
      '- Second item',
      '',
      '| Metric | Value |',
      '| --- | ---: |',
      '| Accounts | 12 |',
      '',
      '```ts',
      'const answer = 42',
      '```',
    ].join('\n')
    const parsed = await parseTextDocument(Buffer.from(source), {
      fileId: 'fixture_markdown',
      fileName: 'synthetic.md',
      tokenCounter,
    })
    expect(
      parsed.chunks.some((chunk) => chunk.content.includes('Heading path: Quarterly report')),
    ).toBe(true)
    expect(
      parsed.chunks.some((chunk) =>
        chunk.content.includes('Heading path: Quarterly report > Details'),
      ),
    ).toBe(true)
    expect(parsed.chunks.some((chunk) => chunk.content.includes('Table row: Accounts | 12'))).toBe(
      true,
    )
    expect(parsed.chunks.some((chunk) => chunk.content.includes('Code (ts):'))).toBe(true)
    expect(parsed.chunks.some((chunk) => chunk.content.includes('- First item'))).toBe(true)
    expect(
      parsed.chunks.some(
        (chunk) =>
          chunk.content.includes('Table row: Accounts | 12') &&
          chunk.lineStart! <= 12 &&
          chunk.lineEnd! >= 12,
      ),
    ).toBe(true)
    expect(
      parsed.chunks.some((chunk) => chunk.headingPath.join(' > ') === 'Quarterly report > Details'),
    ).toBe(true)
  })

  it('preserves Word heading, paragraph, table values, and their order', async () => {
    const bytes = await docxFixture()
    expect(validateDocxArchive(bytes).entries).toBeGreaterThan(0)
    const parsed = await parseTextDocument(bytes, {
      fileId: 'fixture_docx',
      fileName: 'synthetic.docx',
      tokenCounter,
    })
    expect(parsed.text.indexOf('Synthetic Q3 Report')).toBeLessThan(
      parsed.text.indexOf('The forecast target is amber.'),
    )
    expect(parsed.text).toContain('Table 1: Accounts | 12')
    expect(parsed.chunks.some((chunk) => chunk.headingPath.includes('Synthetic Q3 Report'))).toBe(
      true,
    )
    expect(parsed.chunks[0]?.sourceLocation).toContain('paragraph')
  })

  it('chunks long text with deterministic IDs and overlap', async () => {
    const bytes = Buffer.from(`Heading: ${'synthetic evidence '.repeat(90)}`)
    const options = {
      fileId: 'fixture_large',
      fileName: 'synthetic.txt',
      chunkSizeTokens: 64,
      chunkOverlapTokens: 8,
      tokenCounter,
    }
    const first = await parseTextDocument(bytes, options)
    const retry = await parseTextDocument(bytes, options)
    expect(first.chunks.length).toBeGreaterThan(1)
    expect(
      first.chunks.every((chunk) => tokenCounter(chunk.content) <= options.chunkSizeTokens),
    ).toBe(true)
    expect(first.chunks.map((chunk) => chunk.chunkId)).toEqual(
      retry.chunks.map((chunk) => chunk.chunkId),
    )
  })

  it('rejects unsupported, corrupt, empty, binary, and MIME-mismatched documents', async () => {
    expect(() => safeFileName('old.doc')).toThrow('LEGACY_DOC_UNSUPPORTED')
    expect(() => safeFileName('archive.pdf')).toThrow('UNSUPPORTED_DOCUMENT_FORMAT')
    expect(() => validateSupportedUpload('note.txt', 'text/plain', Buffer.from([0xff]))).toThrow(
      'INVALID_UTF8_DOCUMENT',
    )
    expect(() => validateSupportedUpload('blank.md', 'text/markdown', Buffer.from(' \n '))).toThrow(
      'EMPTY_DOCUMENT',
    )
    expect(() =>
      validateSupportedUpload('note.txt', 'application/pdf', Buffer.from('text')),
    ).toThrow('DOCUMENT_MIME_TYPE_MISMATCH')
    expect(() => validateDocxArchive(Buffer.from('not a Word package'))).toThrow(UploadRequestError)
    await expect(
      parseTextDocument(Buffer.from('not a Word package'), {
        fileId: 'invalid_docx',
        fileName: 'invalid.docx',
      }),
    ).rejects.toThrow('INVALID_DOCX_DOCUMENT')
    await expect(
      parseTextDocument(Buffer.alloc(0), { fileId: 'empty', fileName: 'empty.md' }),
    ).rejects.toThrow('EMPTY_DOCUMENT')
  })
})
