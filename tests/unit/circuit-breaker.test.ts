import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createCircuitBreaker } from '../../src/hooks/circuit-breaker.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Advance Date.now() by `ms` milliseconds. */
function advanceTime(ms: number): void {
  vi.advanceTimersByTime(ms)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createCircuitBreaker', () => {
  it('returns a fresh circuit breaker in closed state', () => {
    const cb = createCircuitBreaker()
    expect(cb.shouldSkip()).toBe(false)
  })

  it('stays closed after fewer than 3 consecutive failures', () => {
    const cb = createCircuitBreaker()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.shouldSkip()).toBe(false)
  })

  it('opens after 3 consecutive failures', () => {
    const cb = createCircuitBreaker()
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.shouldSkip()).toBe(true)
  })

  it('resets to closed on recordSuccess', () => {
    const cb = createCircuitBreaker()
    cb.recordFailure()
    cb.recordFailure()
    cb.recordSuccess()
    // Counter reset — need 3 fresh failures to re-open
    cb.recordFailure()
    expect(cb.shouldSkip()).toBe(false)
  })

  it('stays open within the 5-minute cooldown window', () => {
    const cb = createCircuitBreaker()
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()

    advanceTime(4 * 60 * 1000) // 4 minutes
    expect(cb.shouldSkip()).toBe(true)
  })

  it('transitions to half-open after 5-minute cooldown', () => {
    const cb = createCircuitBreaker()
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()

    advanceTime(5 * 60 * 1000) // exactly 5 minutes
    // Half-open: allows one probe call
    expect(cb.shouldSkip()).toBe(false)
  })

  it('closes fully when probe call succeeds in half-open state', () => {
    const cb = createCircuitBreaker()
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()

    advanceTime(5 * 60 * 1000)
    cb.shouldSkip() // transition to half-open
    cb.recordSuccess()

    // Fully closed — should not skip
    expect(cb.shouldSkip()).toBe(false)
  })

  it('re-opens when probe call fails in half-open state', () => {
    const cb = createCircuitBreaker()
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()

    advanceTime(5 * 60 * 1000)
    cb.shouldSkip() // transition to half-open (consecutiveFailures = 2)
    cb.recordFailure() // 2 + 1 = 3 → re-opens

    expect(cb.shouldSkip()).toBe(true)
  })

  it('allows another probe after second cooldown expires', () => {
    const cb = createCircuitBreaker()
    // First open
    cb.recordFailure()
    cb.recordFailure()
    cb.recordFailure()

    // First half-open → probe fails → re-open
    advanceTime(5 * 60 * 1000)
    cb.shouldSkip()
    cb.recordFailure()
    expect(cb.shouldSkip()).toBe(true)

    // Second cooldown → half-open again
    advanceTime(5 * 60 * 1000)
    expect(cb.shouldSkip()).toBe(false)
  })

  it('each createCircuitBreaker call returns an independent instance', () => {
    const a = createCircuitBreaker()
    const b = createCircuitBreaker()

    a.recordFailure()
    a.recordFailure()
    a.recordFailure()

    expect(a.shouldSkip()).toBe(true)
    expect(b.shouldSkip()).toBe(false)
  })
})
