import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../src/bootstrap/backoff.js', () => ({
  computeBackoffMs: vi.fn().mockReturnValue(0),
  sleep: vi.fn().mockResolvedValue(undefined),
}))

import { RateLimitBreaker, MAX_RETRY_ATTEMPTS } from '../../../src/bootstrap/rate-limit-breaker.js'
import { PipelineAbortedError } from '../../../src/llm/errors.js'

// MAX_CONSECUTIVE_RATE_LIMITS is 5 (not exported, tested via behaviour)
const MAX_CONSECUTIVE = 5

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RateLimitBreaker — startBackoff', () => {
  it('returns true for failures below the threshold', () => {
    const breaker = new RateLimitBreaker()
    for (let i = 0; i < MAX_CONSECUTIVE - 1; i++) {
      expect(breaker.startBackoff()).toBe(true)
    }
  })

  it('returns false and sets aborted when threshold is reached', () => {
    const breaker = new RateLimitBreaker()
    for (let i = 0; i < MAX_CONSECUTIVE - 1; i++) {
      breaker.startBackoff()
    }
    expect(breaker.startBackoff()).toBe(false)
    expect(breaker.aborted).toBe(true)
  })

  it('increments consecutiveFailures on each call', () => {
    const breaker = new RateLimitBreaker()
    breaker.startBackoff()
    expect(breaker.consecutiveFailures).toBe(1)
    breaker.startBackoff()
    expect(breaker.consecutiveFailures).toBe(2)
  })

  it('piggybacks on existing gate — sleep called only once per backoff window', async () => {
    const { sleep } = await import('../../../src/bootstrap/backoff.js')
    const breaker = new RateLimitBreaker()

    breaker.startBackoff()
    breaker.startBackoff()
    breaker.startBackoff()

    expect(sleep).toHaveBeenCalledTimes(1)
  })
})

describe('RateLimitBreaker — onSuccess', () => {
  it('resets consecutiveFailures to zero', () => {
    const breaker = new RateLimitBreaker()
    breaker.startBackoff()
    breaker.startBackoff()
    expect(breaker.consecutiveFailures).toBe(2)

    breaker.onSuccess()
    expect(breaker.consecutiveFailures).toBe(0)
  })
})

describe('RateLimitBreaker — awaitGate', () => {
  it('resolves immediately when not aborted and no backoff pending', async () => {
    const breaker = new RateLimitBreaker()
    await expect(breaker.awaitGate()).resolves.toBeUndefined()
  })

  it('throws PipelineAbortedError when aborted', async () => {
    const breaker = new RateLimitBreaker()
    // Exhaust all retries to abort
    for (let i = 0; i < MAX_CONSECUTIVE; i++) {
      breaker.startBackoff()
    }
    await expect(breaker.awaitGate()).rejects.toBeInstanceOf(PipelineAbortedError)
  })

  it('blocks until sleep resolves when backoff is pending', async () => {
    const { sleep } = await import('../../../src/bootstrap/backoff.js')
    let sleepResolve!: () => void
    vi.mocked(sleep).mockReturnValueOnce(
      new Promise<void>((resolve) => { sleepResolve = resolve })
    )

    const breaker = new RateLimitBreaker()
    breaker.startBackoff()

    let resolved = false
    const gatePromise = breaker.awaitGate().then(() => { resolved = true })

    // Gate should not have resolved yet
    await Promise.resolve()
    expect(resolved).toBe(false)

    // Resolve the sleep
    sleepResolve()
    await gatePromise
    expect(resolved).toBe(true)
  })
})

describe('RateLimitBreaker — MAX_RETRY_ATTEMPTS export', () => {
  it('exports MAX_RETRY_ATTEMPTS as 5', () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(5)
  })
})

describe('RateLimitBreaker — post-backoff reset', () => {
  it('creates a fresh gate after the first backoff window resolves', async () => {
    const { sleep } = await import('../../../src/bootstrap/backoff.js')
    let firstResolve!: () => void
    let secondResolve!: () => void
    vi.mocked(sleep)
      .mockReturnValueOnce(new Promise<void>((r) => { firstResolve = r }))
      .mockReturnValueOnce(new Promise<void>((r) => { secondResolve = r }))

    const breaker = new RateLimitBreaker()

    // First backoff window
    breaker.startBackoff()
    await Promise.resolve()
    // Gate is pending — awaitGate should block
    let firstGateSettled = false
    const g1 = breaker.awaitGate().then(() => { firstGateSettled = true })
    await Promise.resolve()
    expect(firstGateSettled).toBe(false)

    // Resolve first window
    firstResolve()
    await g1
    expect(firstGateSettled).toBe(true)

    // Second rate-limit — should create a new gate
    breaker.startBackoff()
    let secondGateSettled = false
    const g2 = breaker.awaitGate().then(() => { secondGateSettled = true })
    await Promise.resolve()
    expect(secondGateSettled).toBe(false)

    secondResolve()
    await g2
    expect(secondGateSettled).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(2)
  })
})

describe('RateLimitBreaker — abort()', () => {
  it('sets aborted=true immediately', () => {
    const breaker = new RateLimitBreaker()
    expect(breaker.aborted).toBe(false)
    breaker.abort()
    expect(breaker.aborted).toBe(true)
  })

  it('awaitGate throws PipelineAbortedError after abort()', async () => {
    const breaker = new RateLimitBreaker()
    breaker.abort()
    await expect(breaker.awaitGate()).rejects.toBeInstanceOf(PipelineAbortedError)
  })
})
