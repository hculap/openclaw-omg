import type { OmgConfig } from '../config.js'
import type { Message, OmgSessionState } from '../types.js'
import { estimateTokens } from '../utils/tokens.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recalculates the token count of messages not yet processed by the Observer.
 * Only messages after `state.observationBoundaryMessageIndex` are counted.
 *
 * Pure function — returns a new state object, never mutates the original.
 * Replaces (rather than adds to) `pendingMessageTokens`, so it is safe to
 * call multiple times across turns without double-counting.
 */
export function accumulateTokens(
  messages: readonly Message[],
  state: OmgSessionState
): OmgSessionState {
  const unobserved = messages.slice(state.observationBoundaryMessageIndex)
  const newTokens = unobserved.reduce((sum, msg) => sum + estimateTokens(msg.content), 0)
  return {
    ...state,
    pendingMessageTokens: newTokens,
  }
}

/**
 * Returns true if an observation run should be triggered based on the current
 * state and configuration.
 *
 * - `"every-turn"` — always returns true
 * - `"threshold"` — returns true when `pendingMessageTokens >= messageTokenThreshold`
 * - `"manual"` — always returns false (trigger via skill only)
 *
 * Pure function — no side effects.
 */
export function shouldTriggerObservation(state: OmgSessionState, config: OmgConfig): boolean {
  switch (config.observation.triggerMode) {
    case 'every-turn':
      return true
    case 'threshold':
      return state.pendingMessageTokens >= config.observation.messageTokenThreshold
    case 'manual':
      return false
  }
}

/**
 * Returns true if a reflection pass should be triggered based on the cumulative
 * observation token count.
 *
 * Pure function — no side effects.
 */
export function shouldTriggerReflection(state: OmgSessionState, config: OmgConfig): boolean {
  return state.totalObservationTokens >= config.reflection.observationTokenThreshold
}
