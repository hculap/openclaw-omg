/**
 * In-memory circuit breaker for LLM gateway calls.
 *
 * Prevents infinite retry loops when the gateway returns consecutive errors
 * (500s, timeouts). After {@link FAILURE_THRESHOLD} consecutive failures,
 * the circuit opens and all calls are skipped for {@link COOLDOWN_MS}.
 * After cooldown, one probe call is allowed (half-open). If it succeeds
 * the circuit closes; if it fails, cooldown resets.
 *
 * Scope: per-gateway instance (not per-session), since gateway errors
 * affect all sessions equally.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Consecutive failures before the circuit opens. */
const FAILURE_THRESHOLD = 3

/** Cooldown period in milliseconds (5 minutes). */
const COOLDOWN_MS = 5 * 60 * 1000

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface BreakerState {
  consecutiveFailures: number
  lastFailureMs: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CircuitBreaker {
  /** Returns true if the circuit is open and calls should be skipped. */
  shouldSkip(): boolean
  /** Record a successful call — resets the breaker. */
  recordSuccess(): void
  /** Record a failed call — increments toward opening the circuit. */
  recordFailure(): void
}

/**
 * Creates a new circuit breaker instance.
 * Pure factory — no global singletons. The caller owns the lifecycle.
 */
export function createCircuitBreaker(): CircuitBreaker {
  const state: BreakerState = {
    consecutiveFailures: 0,
    lastFailureMs: 0,
  }

  return {
    shouldSkip(): boolean {
      if (state.consecutiveFailures < FAILURE_THRESHOLD) return false
      const elapsed = Date.now() - state.lastFailureMs
      if (elapsed >= COOLDOWN_MS) {
        // Half-open: allow one probe call. Reset failure count so that if the
        // probe fails, the threshold is crossed again immediately (3 → 1 + 1 fail = reopen).
        state.consecutiveFailures = FAILURE_THRESHOLD - 1
        return false
      }
      return true
    },

    recordSuccess(): void {
      state.consecutiveFailures = 0
      state.lastFailureMs = 0
    },

    recordFailure(): void {
      state.consecutiveFailures++
      state.lastFailureMs = Date.now()
    },
  }
}
