import type { WorkspaceCitation } from './sitepilot-workspace.mjs'

export interface AgentEvidenceItem {
  content: string
  citation: WorkspaceCitation
}

export interface GroundedAnswer {
  text: string
  citations: WorkspaceCitation[]
  references: number[]
}

/**
 * Accept only answer sentences that explicitly reference retrieved evidence. Each referenced
 * source must share meaningful wording with the sentence, and every stated number must occur
 * in that source. Citation markers are stripped before text is returned to the caller.
 */
export function groundAnswerInEvidence(
  answer: string,
  evidence: readonly AgentEvidenceItem[],
  options: { allowParaphrase?: boolean } = {},
): GroundedAnswer | null {
  const sentences = answer
    .trim()
    .split(/(?<=[.!?؟])\s+|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
  if (!sentences.length) return null

  const citationIndexes = new Set<number>()
  for (const sentence of sentences) {
    const references = [
      ...new Set([...sentence.matchAll(/\[(\d+)\]/gu)].map((match) => Number(match[1]) - 1)),
    ]
    if (!references.length || references.some((index) => index < 0 || index >= evidence.length))
      return null
    const claim = sentence.replace(/\[(\d+)\]/gu, '').trim()
    if (!claim) return null
    const claimTerms = meaningfulTerms(claim)
    // Citation markers are reference IDs, not numbers asserted by the answer.
    const claimNumbers = normalizedNumbers(claim.replace(/\[(\d+)\]/gu, ''))
    const relevantEvidence: Array<{ index: number; content: string }> = []
    for (const index of references) {
      const sourceItem = evidence[index]!
      if (!sourceItem.citation.source?.trim()) continue
      const sourceTerms = meaningfulTerms(sourceItem.content)
      if (options.allowParaphrase || [...claimTerms].some((term) => sourceTerms.has(term)))
        relevantEvidence.push({ index, content: sourceItem.content })
    }
    if (relevantEvidence.length !== references.length) return null
    const combinedEvidence = relevantEvidence.map((item) => item.content).join('\n')
    const combinedTerms = meaningfulTerms(combinedEvidence)
    const combinedNumbers = normalizedNumbers(combinedEvidence)
    const hasSupportedTerms = [...claimTerms].some((term) => combinedTerms.has(term))
    const numbersSupported = [...claimNumbers].every((number) => combinedNumbers.has(number))
    const entitiesSupported = namedPhrases(claim).every((entity) =>
      combinedEvidence.toLocaleLowerCase().includes(entity.toLocaleLowerCase()),
    )
    if ((!options.allowParaphrase && !hasSupportedTerms) || !numbersSupported || !entitiesSupported)
      return null
    for (const item of relevantEvidence) citationIndexes.add(item.index)
  }

  const citations = [...citationIndexes].map((index) => evidence[index]!.citation)
  if (!citations.length) return null
  return {
    text: answer
      .replace(/\s*\[(\d+)\]/gu, '')
      .replace(/[ \t]+([.!?؟])/gu, '$1')
      .trim(),
    citations: uniqueCitations(citations),
    references: [...citationIndexes].map((index) => index + 1),
  }
}

export type EvidenceDecision = 'supported' | 'insufficient' | 'conflicting'

export function parseEvidenceDecision(value: string): EvidenceDecision | null {
  try {
    const start = value.indexOf('{')
    const end = value.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    const result = JSON.parse(value.slice(start, end + 1)) as { status?: unknown }
    return result.status === 'supported' ||
      result.status === 'insufficient' ||
      result.status === 'conflicting'
      ? result.status
      : null
  } catch {
    return null
  }
}

function meaningfulTerms(value: string) {
  const stopWords = new Set([
    'a',
    'an',
    'and',
    'are',
    'as',
    'at',
    'be',
    'by',
    'for',
    'from',
    'has',
    'have',
    'in',
    'is',
    'it',
    'of',
    'on',
    'or',
    'that',
    'the',
    'this',
    'to',
    'was',
    'were',
    'with',
    'عن',
    'على',
    'في',
    'من',
    'هذا',
    'هذه',
    'هو',
    'هي',
    'و',
    'أو',
    'الى',
    'إلى',
    'تم',
  ])
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}]{2,}|\d+/gu) ?? []).filter(
      (term) => !stopWords.has(term),
    ),
  )
}

function normalizedNumbers(value: string) {
  return new Set(
    (value.match(/\d+(?:[,.]\d+)*/gu) ?? []).map((number) => number.replace(/,/gu, '')),
  )
}

function namedPhrases(value: string) {
  const capitalized = String.raw`[A-Z][\p{L}\p{M}'’.-]*`
  const connector = String.raw`(?:of|the|de|van|bin|al)`
  const phrase = new RegExp(
    `(?<![\\p{L}])(?:${capitalized})(?:\\s+(?:${connector}\\s+)?${capitalized})+(?![\\p{L}])`,
    'gu',
  )
  return [...value.matchAll(phrase)].map((match) =>
    match[0]!.trim().replace(/^(?:the|a|an)\s+/iu, ''),
  )
}

function uniqueCitations(citations: readonly WorkspaceCitation[]) {
  const unique = new Map<string, WorkspaceCitation>()
  for (const citation of citations) {
    const key = [
      citation.source,
      citation.sheet ?? '',
      citation.rowStart ?? '',
      citation.rowEnd ?? '',
      citation.sourceRange ?? '',
    ].join('\u0000')
    unique.set(key, citation)
  }
  return [...unique.values()]
}
