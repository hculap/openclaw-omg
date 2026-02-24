/**
 * Circuit breaker that coordinates rate-limit backoff across concurrent batch workers.
 *
 * All workers call `awaitGate()` before each LLM attempt. During backoff
 * (`_gate` is a pending sleep), new attempts from all workers are blocked.
 * After `MAX_CONSECUTIVE_RATE_LIMITS` failures the pipeline is aborted and
 * `awaitGate()` throws `PipelineAbortedError` for all subsequent callers.
 */

import { PipelineAbortedError } from '../llm/errors.js'
import { computeBackoffMs, sleep } from './backoff.js'

const MAX_CONSECUTIVE_RATE_LIMITS = 5
export const MAX_RETRY_ATTEMPTS = 5

export class RateLimitBreaker {
  private _consecutiveFailures = 0
  private _aborted = false
  private _backoffPending = false
  private _gate: Promise<void> = Promise.resolve()

  get aborted(): boolean {
    return this._aborted
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures
  }

  /**
   * Await before each LLM call attempt. Blocks all workers during backoff.
   * Throws `PipelineAbortedError` when the failure threshold has been reached.
   */
  async awaitGate(): Promise<void> {
    await this._gate
    if (this._aborted) throw new PipelineAbortedError()
  }

  /**
   * Called when a rate limit is encountered.
   * Sets the backoff gate (first call per backoff window only — others piggyback).
   * @returns true if retry is allowed, false if the pipeline should abort
   */
  startBackoff(): boolean {
    this._consecutiveFailures++
    if (this._consecutiveFailures >= MAX_CONSECUTIVE_RATE_LIMITS) {
      this._aborted = true
      console.error(
        `[omg] bootstrap: rate limit threshold reached (${this._consecutiveFailures} consecutive) — aborting pipeline`
      )
      return false
    }
    if (!this._backoffPending) {
      this._backoffPending = true
      const delay = computeBackoffMs(this._consecutiveFailures)
      console.error(
        `[omg] bootstrap: rate limit ${this._consecutiveFailures}/${MAX_CONSECUTIVE_RATE_LIMITS} — backing off ${delay / 1000}s`
      )
      this._gate = sleep(delay).then(() => {
        this._backoffPending = false
      })
    }
    return true
  }

  onSuccess(): void {
    this._consecutiveFailures = 0
  }

  /**
   * Immediately marks the pipeline as aborted, unblocking `awaitGate()` callers
   * who will receive a `PipelineAbortedError`. Used when a non-rate-limit failure
   * (e.g. `GatewayUnreachableError`) makes further attempts futile for all workers.
   */
  abort(): void {
    this._aborted = true
  }
}
