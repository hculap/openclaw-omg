/**
 * Exponential backoff utilities for the bootstrap pipeline's rate-limit retry loop.
 */

/** Delays in ms: 15s → 30s → 60s → 120s → 300s */
export const BACKOFF_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000] as const

export function computeBackoffMs(consecutiveFailures: number): number {
  const idx = Math.min(consecutiveFailures - 1, BACKOFF_DELAYS_MS.length - 1)
  return BACKOFF_DELAYS_MS[Math.max(0, idx)]!
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
