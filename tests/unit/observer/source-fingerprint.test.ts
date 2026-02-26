import { describe, it, expect } from 'vitest'
import { buildFingerprint, computeOverlap } from '../../../src/observer/source-fingerprint.js'
import type { Message } from '../../../src/types.js'

function msgs(...contents: string[]): Message[] {
  return contents.map((content) => ({ role: 'user', content }))
}

describe('buildFingerprint', () => {
  it('returns empty shingle set for empty messages', () => {
    const fp = buildFingerprint([])
    expect(fp.shingleHashes).toHaveLength(0)
    expect(fp.messageCount).toBe(0)
    expect(fp.totalChars).toBe(0)
  })

  it('produces non-empty fingerprint for real messages', () => {
    const fp = buildFingerprint(msgs('The quick brown fox jumps over the lazy dog'))
    expect(fp.shingleHashes.length).toBeGreaterThan(0)
    expect(fp.messageCount).toBe(1)
    expect(fp.totalChars).toBeGreaterThan(0)
  })

  it('handles short messages with fewer than 5 words', () => {
    const fp = buildFingerprint(msgs('Hello world'))
    expect(fp.shingleHashes.length).toBeGreaterThan(0)
    expect(fp.messageCount).toBe(1)
  })

  it('concatenates multiple messages', () => {
    const fp = buildFingerprint(msgs('Hello world', 'Goodbye world'))
    expect(fp.messageCount).toBe(2)
    expect(fp.totalChars).toBe('Hello world\nGoodbye world'.length)
  })

  it('includes timestamp', () => {
    const fp = buildFingerprint(msgs('test'))
    expect(fp.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('computeOverlap', () => {
  it('returns 0 for two empty fingerprints', () => {
    const a = buildFingerprint([])
    const b = buildFingerprint([])
    expect(computeOverlap(a, b)).toBe(0)
  })

  it('returns 1 for identical messages', () => {
    const text = 'The quick brown fox jumps over the lazy dog and runs away quickly'
    const a = buildFingerprint(msgs(text))
    const b = buildFingerprint(msgs(text))
    expect(computeOverlap(a, b)).toBe(1)
  })

  it('returns near-0 for completely different messages', () => {
    const a = buildFingerprint(msgs('The quick brown fox jumps over the lazy dog every morning'))
    const b = buildFingerprint(msgs('Quantum computing enables parallel processing of complex mathematical operations'))
    expect(computeOverlap(a, b)).toBeLessThan(0.1)
  })

  it('returns intermediate score for partial overlap', () => {
    const a = buildFingerprint(msgs(
      'The quick brown fox jumps over the lazy dog. It runs fast through the forest.'
    ))
    const b = buildFingerprint(msgs(
      'The quick brown fox jumps over the lazy dog. It then sleeps in the sun.'
    ))
    const score = computeOverlap(a, b)
    expect(score).toBeGreaterThan(0.2)
    expect(score).toBeLessThan(0.9)
  })

  it('is symmetric', () => {
    const a = buildFingerprint(msgs('Alpha beta gamma delta epsilon zeta eta theta'))
    const b = buildFingerprint(msgs('Beta gamma delta epsilon zeta eta theta iota'))
    expect(computeOverlap(a, b)).toBeCloseTo(computeOverlap(b, a))
  })
})
