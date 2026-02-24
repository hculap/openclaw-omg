import { describe, it, expect } from 'vitest'
import { computeBackoffMs, BACKOFF_DELAYS_MS } from '../../../src/bootstrap/backoff.js'

describe('computeBackoffMs', () => {
  it('returns 15_000ms for 1 consecutive failure', () => {
    expect(computeBackoffMs(1)).toBe(15_000)
  })

  it('returns 30_000ms for 2 consecutive failures', () => {
    expect(computeBackoffMs(2)).toBe(30_000)
  })

  it('returns 60_000ms for 3 consecutive failures', () => {
    expect(computeBackoffMs(3)).toBe(60_000)
  })

  it('returns 120_000ms for 4 consecutive failures', () => {
    expect(computeBackoffMs(4)).toBe(120_000)
  })

  it('returns 300_000ms for 5 consecutive failures', () => {
    expect(computeBackoffMs(5)).toBe(300_000)
  })

  it('clamps to 300_000ms for failures beyond array length', () => {
    expect(computeBackoffMs(10)).toBe(300_000)
    expect(computeBackoffMs(100)).toBe(300_000)
  })

  it('max value equals last entry in BACKOFF_DELAYS_MS', () => {
    const last = BACKOFF_DELAYS_MS[BACKOFF_DELAYS_MS.length - 1]!
    expect(computeBackoffMs(BACKOFF_DELAYS_MS.length + 100)).toBe(last)
  })
})
