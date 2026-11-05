import { describe, expect, it } from 'vitest'
import {
  groundAnswerInEvidence,
  parseEvidenceDecision,
} from '../src/sitepilot/agent/sitepilot-evidence.mjs'
import type { WorkspaceCitation } from '../src/sitepilot/agent/sitepilot-workspace.mjs'

function evidence(content: string, source: string, sourceRange: string) {
  return {
    content,
    citation: {
      source,
      sheet: 'Synthetic',
      rowStart: 2,
      rowEnd: 2,
      sourceRange,
    } satisfies WorkspaceCitation,
  }
}

describe('general evidence grounding', () => {
  it('rejects a claimed real bank name based only on a generic USD ledger label', () => {
    const account = evidence(
      'Account title: بنك - دولار أمريكي; Account type: USD bank account; code: 1010.',
      'synthetic-accounts.xlsx',
      'A2:C2',
    )
    expect(
      groundAnswerInEvidence('The actual bank is Synthetic Trust Bank [1].', [account]),
    ).toBeNull()
  })

  it('accepts a directly stated entity and returns only its cited source', () => {
    const stated = evidence(
      'USD account; Bank name: Synthetic Trust Bank.',
      'synthetic-accounts.xlsx',
      'A3:C3',
    )
    const unrelated = evidence('EUR account; Bank name: Other Institution.', 'other.xlsx', 'A9:C9')
    expect(
      groundAnswerInEvidence('Synthetic Trust Bank is named for the USD account [1].', [
        stated,
        unrelated,
      ]),
    ).toMatchObject({
      text: 'Synthetic Trust Bank is named for the USD account.',
      citations: [stated.citation],
      references: [1],
    })
  })

  it('accepts conflicting as a distinct verifier decision instead of choosing one source', () => {
    expect(parseEvidenceDecision('{"status":"conflicting"}')).toBe('conflicting')
    expect(parseEvidenceDecision('{"status":"supported"}')).toBe('supported')
    expect(parseEvidenceDecision('not json')).toBeNull()
  })

  it('rejects missing references, unsupported numbers, and unrelated sources', () => {
    const source = evidence(
      'Account label: Operating account; recorded balance: 500 dollars.',
      'synthetic-account-fixture.xlsx',
      'A2:B2',
    )
    expect(groundAnswerInEvidence('The account balance is 999 dollars [1].', [source])).toBeNull()
    expect(groundAnswerInEvidence('The account balance is 500 dollars.', [source])).toBeNull()
    expect(groundAnswerInEvidence('The supplier is Example Bank [1].', [source])).toBeNull()
  })

  it('does not treat the citation reference number as an asserted fact', () => {
    const source = evidence(
      'The onboarding process is described in the source.',
      'process.md',
      'lines 2-4',
    )
    expect(
      groundAnswerInEvidence('The onboarding process is described in the source [1].', [source], {
        allowParaphrase: true,
      }),
    ).toMatchObject({ references: [1], citations: [source.citation] })
  })

  it('excludes irrelevant citations even when other retrieved results exist', () => {
    const irrelevant = evidence('Region: South; Amount: 40; Category: B', 'other.xlsx', 'A5:C5')
    const relevant = evidence('Region: North; Amount: 10; Category: A', 'source.xlsx', 'A2:C2')
    expect(
      groundAnswerInEvidence('The amount is 10 for North [2].', [irrelevant, relevant]),
    ).toEqual({
      text: 'The amount is 10 for North.',
      citations: [relevant.citation],
      references: [2],
    })
  })

  it('grounds a cross-document comparison across both directly relevant citations', () => {
    const east = evidence('The synthetic East site value is 12.', 'comparison-east.md', 'lines 3-3')
    const west = evidence('The synthetic West site value is 19.', 'comparison-west.md', 'lines 4-4')
    expect(
      groundAnswerInEvidence('East reports 12, while West reports 19 [1] [2].', [east, west]),
    ).toMatchObject({
      text: 'East reports 12, while West reports 19.',
      citations: [east.citation, west.citation],
      references: [1, 2],
    })
  })

  it('defers paraphrase semantics to the verifier while keeping numeric checks local', () => {
    const unconfirmed = evidence(
      'The official Enterprise amount has not yet been confirmed in current commercial materials.',
      'pricing.md',
      'lines 4-7',
    )
    expect(groundAnswerInEvidence('لم يتم تأكيد المبلغ الرسمي بعد [1].', [unconfirmed])).toBeNull()
    expect(
      groundAnswerInEvidence('لم يتم تأكيد المبلغ الرسمي بعد [1].', [unconfirmed], {
        allowParaphrase: true,
      })?.citations,
    ).toEqual([unconfirmed.citation])
    expect(
      groundAnswerInEvidence('The unconfirmed amount is $900 per month [1].', [unconfirmed], {
        allowParaphrase: true,
      }),
    ).toBeNull()
  })
})
