import { describe, it, expect } from 'vitest'
import {
  checkSourceOverlap,
  suppressDuplicateCandidates,
  updateRecentFingerprints,
} from '../../../src/observer/extraction-guardrails.js'
import { buildFingerprint, type SourceFingerprint } from '../../../src/observer/source-fingerprint.js'
import { parseConfig } from '../../../src/config.js'
import type { Message, ExtractCandidate } from '../../../src/types.js'
import type { RegistryNodeEntry } from '../../../src/graph/registry.js'

function msgs(...contents: string[]): Message[] {
  return contents.map((content) => ({ role: 'user', content }))
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    extractionGuardrails: { enabled: true, ...overrides },
  })
}

function makeDisabledConfig() {
  return parseConfig({ extractionGuardrails: { enabled: false } })
}

function makeCandidate(key: string, desc: string): ExtractCandidate {
  return {
    type: 'fact',
    canonicalKey: key,
    title: desc,
    description: desc,
    body: 'Some body.',
    priority: 'medium',
  }
}

function makeEntry(key: string, desc: string): [string, RegistryNodeEntry] {
  return [
    `omg/${key}`,
    {
      type: 'fact',
      kind: 'observation',
      description: desc,
      priority: 'medium',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      filePath: `/fake/${key}.md`,
      canonicalKey: key,
    },
  ]
}

// ---------------------------------------------------------------------------
// checkSourceOverlap
// ---------------------------------------------------------------------------

describe('checkSourceOverlap', () => {
  it('returns proceed when guardrails disabled', () => {
    const config = makeDisabledConfig()
    const messages = msgs('Hello world some long enough text for fingerprinting purposes')
    const recent = [buildFingerprint(messages)]
    const decision = checkSourceOverlap(messages, recent, config)
    expect(decision.action).toBe('proceed')
  })

  it('returns proceed when no recent fingerprints', () => {
    const config = makeConfig()
    const decision = checkSourceOverlap(msgs('Hello world testing'), [], config)
    expect(decision.action).toBe('proceed')
    expect(decision.overlapScore).toBe(0)
  })

  it('returns proceed when no messages', () => {
    const config = makeConfig()
    const recent = [buildFingerprint(msgs('something'))]
    const decision = checkSourceOverlap([], recent, config)
    expect(decision.action).toBe('proceed')
  })

  it('returns skip when overlap exceeds skipOverlapThreshold', () => {
    const config = makeConfig({ skipOverlapThreshold: 0.8 })
    const text = 'The quick brown fox jumps over the lazy dog and runs away from the forest into the hills'
    const messages = msgs(text)
    const recent = [buildFingerprint(msgs(text))]
    const decision = checkSourceOverlap(messages, recent, config)
    expect(decision.action).toBe('skip')
    expect(decision.overlapScore).toBeGreaterThanOrEqual(0.8)
  })

  it('returns proceed when overlap is below truncateOverlapThreshold', () => {
    const config = makeConfig({ truncateOverlapThreshold: 0.5 })
    const messages = msgs('Quantum computing enables parallel processing of very complex operations today')
    const recent = [buildFingerprint(msgs('The weather forecast predicts sunny skies and warm temperatures throughout the week'))]
    const decision = checkSourceOverlap(messages, recent, config)
    expect(decision.action).toBe('proceed')
    expect(decision.overlapScore).toBeLessThan(0.5)
  })
})

// ---------------------------------------------------------------------------
// suppressDuplicateCandidates
// ---------------------------------------------------------------------------

describe('suppressDuplicateCandidates', () => {
  it('returns all candidates when guardrails disabled', () => {
    const config = makeDisabledConfig()
    const candidates = [makeCandidate('facts.test', 'A test fact')]
    const { survivors, suppressed } = suppressDuplicateCandidates(
      candidates, ['omg/facts.test'], [makeEntry('facts.test', 'A test fact')], config,
    )
    expect(survivors).toHaveLength(1)
    expect(suppressed).toHaveLength(0)
  })

  it('returns all candidates when no recent node IDs', () => {
    const config = makeConfig()
    const candidates = [makeCandidate('facts.test', 'A test fact')]
    const { survivors } = suppressDuplicateCandidates(candidates, [], [], config)
    expect(survivors).toHaveLength(1)
  })

  it('suppresses candidate matching a recent node', () => {
    const config = makeConfig({ candidateSuppressionThreshold: 0.5 })
    const candidates = [makeCandidate('facts.test-fact', 'A specific test fact')]
    const entries: [string, RegistryNodeEntry][] = [
      makeEntry('facts.test-fact', 'A specific test fact'),
    ]
    const { survivors, suppressed } = suppressDuplicateCandidates(
      candidates, ['omg/facts.test-fact'], entries, config,
    )
    expect(suppressed).toHaveLength(1)
    expect(suppressed[0]).toBe('facts.test-fact')
    expect(survivors).toHaveLength(0)
  })

  it('keeps candidate when similarity is below threshold', () => {
    const config = makeConfig({ candidateSuppressionThreshold: 0.9 })
    const candidates = [makeCandidate('facts.quantum-computing', 'Quantum computing capabilities')]
    const entries: [string, RegistryNodeEntry][] = [
      makeEntry('facts.weather-patterns', 'Weather patterns in Europe'),
    ]
    const { survivors, suppressed } = suppressDuplicateCandidates(
      candidates, ['omg/facts.weather-patterns'], entries, config,
    )
    expect(suppressed).toHaveLength(0)
    expect(survivors).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// updateRecentFingerprints
// ---------------------------------------------------------------------------

describe('updateRecentFingerprints', () => {
  it('appends new fingerprint', () => {
    const fp = buildFingerprint(msgs('test'))
    const result = updateRecentFingerprints([], fp, 5)
    expect(result).toHaveLength(1)
  })

  it('trims to window size', () => {
    const fps: SourceFingerprint[] = Array.from({ length: 5 }, (_, i) =>
      buildFingerprint(msgs(`msg ${i}`))
    )
    const newFp = buildFingerprint(msgs('new'))
    const result = updateRecentFingerprints(fps, newFp, 5)
    expect(result).toHaveLength(5)
    // Should have dropped the oldest
    expect(result[result.length - 1]).toBe(newFp)
  })
})
