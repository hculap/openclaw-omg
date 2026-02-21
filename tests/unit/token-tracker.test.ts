import { describe, it, expect } from 'vitest'
import { parseConfig } from '../../src/config.js'
import { accumulateTokens, shouldTriggerObservation, shouldTriggerReflection } from '../../src/state/token-tracker.js'
import type { OmgSessionState, Message } from '../../src/types.js'

function defaultState(overrides: Partial<OmgSessionState> = {}): OmgSessionState {
  return {
    lastObservedAtMs: 0,
    pendingMessageTokens: 0,
    totalObservationTokens: 0,
    lastReflectionTotalTokens: 0,
    observationBoundaryMessageIndex: 0,
    nodeCount: 0,
    lastObservationNodeIds: [],
    ...overrides,
  }
}

const MSG = (content: string): Message => ({ role: 'user', content })

// ---------------------------------------------------------------------------
// accumulateTokens
// ---------------------------------------------------------------------------

describe('accumulateTokens', () => {
  it('accumulates tokens from messages after the boundary index', () => {
    const messages: Message[] = [
      MSG('old message'),   // index 0 — already observed
      MSG('new message 1'), // index 1 — not yet observed
      MSG('new message 2'), // index 2 — not yet observed
    ]
    const state = defaultState({ observationBoundaryMessageIndex: 1 })
    const next = accumulateTokens(messages, state)
    // 'new message 1' + 'new message 2' = 26 chars ≈ 7 tokens
    expect(next.pendingMessageTokens).toBeGreaterThan(0)
  })

  it('does not mutate the original state', () => {
    const state = defaultState({ pendingMessageTokens: 100 })
    const messages: Message[] = [MSG('hello')]
    accumulateTokens(messages, state)
    expect(state.pendingMessageTokens).toBe(100)
  })

  it('returns a new state object', () => {
    const state = defaultState()
    const next = accumulateTokens([MSG('hi')], state)
    expect(next).not.toBe(state)
  })

  it('accumulates tokens from 3 messages correctly', () => {
    const messages: Message[] = [
      MSG('a'.repeat(40)),  // 10 tokens
      MSG('b'.repeat(40)),  // 10 tokens
      MSG('c'.repeat(40)),  // 10 tokens
    ]
    const state = defaultState({ observationBoundaryMessageIndex: 0 })
    const next = accumulateTokens(messages, state)
    expect(next.pendingMessageTokens).toBe(30)
  })

  it('replaces pendingMessageTokens with a fresh recalculation (no double-counting)', () => {
    // Any previously saved pendingMessageTokens must be discarded; only the
    // current messages from the boundary onward should count.
    const messages: Message[] = [MSG('a'.repeat(40))]
    const state = defaultState({ pendingMessageTokens: 50, observationBoundaryMessageIndex: 0 })
    const next = accumulateTokens(messages, state)
    expect(next.pendingMessageTokens).toBe(10) // 40 chars ≈ 10 tokens; 50 is NOT added
  })

  it('returns same pending count when no new messages since boundary', () => {
    const messages: Message[] = [MSG('already observed')]
    const state = defaultState({
      pendingMessageTokens: 0,
      observationBoundaryMessageIndex: 1, // boundary is past all messages
    })
    const next = accumulateTokens(messages, state)
    expect(next.pendingMessageTokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// shouldTriggerObservation
// ---------------------------------------------------------------------------

describe('shouldTriggerObservation', () => {
  it('every-turn mode always returns true', () => {
    const config = parseConfig({ observation: { triggerMode: 'every-turn' } })
    const state = defaultState({ pendingMessageTokens: 0 })
    expect(shouldTriggerObservation(state, config)).toBe(true)
  })

  it('manual mode always returns false', () => {
    const config = parseConfig({ observation: { triggerMode: 'manual' } })
    const state = defaultState({ pendingMessageTokens: 999_999 })
    expect(shouldTriggerObservation(state, config)).toBe(false)
  })

  it('threshold mode returns false when below threshold', () => {
    const config = parseConfig({ observation: { triggerMode: 'threshold', messageTokenThreshold: 1000 } })
    const state = defaultState({ pendingMessageTokens: 500 })
    expect(shouldTriggerObservation(state, config)).toBe(false)
  })

  it('threshold mode returns true when at threshold', () => {
    const config = parseConfig({ observation: { triggerMode: 'threshold', messageTokenThreshold: 1000 } })
    const state = defaultState({ pendingMessageTokens: 1000 })
    expect(shouldTriggerObservation(state, config)).toBe(true)
  })

  it('threshold mode returns true when above threshold', () => {
    const config = parseConfig({ observation: { triggerMode: 'threshold', messageTokenThreshold: 1000 } })
    const state = defaultState({ pendingMessageTokens: 1500 })
    expect(shouldTriggerObservation(state, config)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// shouldTriggerReflection
// ---------------------------------------------------------------------------

describe('shouldTriggerReflection', () => {
  it('returns false when below threshold', () => {
    const config = parseConfig({ reflection: { observationTokenThreshold: 40_000 } })
    const state = defaultState({ totalObservationTokens: 10_000 })
    expect(shouldTriggerReflection(state, config)).toBe(false)
  })

  it('returns true when at threshold', () => {
    const config = parseConfig({ reflection: { observationTokenThreshold: 40_000 } })
    const state = defaultState({ totalObservationTokens: 40_000 })
    expect(shouldTriggerReflection(state, config)).toBe(true)
  })

  it('returns true when above threshold', () => {
    const config = parseConfig({ reflection: { observationTokenThreshold: 40_000 } })
    const state = defaultState({ totalObservationTokens: 50_000 })
    expect(shouldTriggerReflection(state, config)).toBe(true)
  })

  it('returns false when delta since last reflection is below threshold even if cumulative is high', () => {
    const config = parseConfig({ reflection: { observationTokenThreshold: 40_000 } })
    // Cumulative is 80k but last reflection was at 50k → delta = 30k < 40k threshold
    const state = defaultState({ totalObservationTokens: 80_000, lastReflectionTotalTokens: 50_000 })
    expect(shouldTriggerReflection(state, config)).toBe(false)
  })

  it('returns true when delta since last reflection meets threshold', () => {
    const config = parseConfig({ reflection: { observationTokenThreshold: 40_000 } })
    // Cumulative is 90k, last reflection was at 50k → delta = 40k >= 40k threshold
    const state = defaultState({ totalObservationTokens: 90_000, lastReflectionTotalTokens: 50_000 })
    expect(shouldTriggerReflection(state, config)).toBe(true)
  })
})
