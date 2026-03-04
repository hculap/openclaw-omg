/**
 * Cron job registration for the OMG plugin.
 *
 * Registers all cron jobs from `createCronDefinitions` with the OpenClaw plugin API.
 * When `api.scheduleCron` is unavailable (e.g. API changed or removed), falls back
 * to `setInterval`-based scheduling within the plugin process.
 *
 * Idempotent — OpenClaw deduplicates jobs by `jobId`, so calling this function
 * multiple times with the same `api` replaces rather than duplicates registrations.
 */

import type { PluginApi } from '../plugin.js'
import type { OmgConfig } from '../config.js'
import { createCronDefinitions, type CronContext, type CronDefinition } from './definitions.js'

// ---------------------------------------------------------------------------
// Cron health tracking
// ---------------------------------------------------------------------------

/** Tracks last successful execution timestamp per cron job ID. */
const lastCronRun = new Map<string, number>()

/** Active fallback intervals so they can be cleaned up. */
const activeIntervals = new Map<string, ReturnType<typeof setInterval>>()

/**
 * Records a successful cron execution. Called by cron handlers.
 */
export function recordCronSuccess(jobId: string): void {
  lastCronRun.set(jobId, Date.now())
}

/**
 * Returns the milliseconds since the last successful run for a job,
 * or null if the job has never run.
 */
export function getLastCronRunAge(jobId: string): number | null {
  const last = lastCronRun.get(jobId)
  if (last === undefined) return null
  return Date.now() - last
}

/**
 * Returns all cron health entries for diagnostics.
 */
export function getCronHealthSummary(): ReadonlyMap<string, number> {
  return lastCronRun
}

// ---------------------------------------------------------------------------
// Cron schedule parsing (minimal)
// ---------------------------------------------------------------------------

/**
 * Converts a simple cron schedule to a millisecond interval.
 * Handles common patterns; defaults to 24h for complex expressions.
 */
function cronToIntervalMs(schedule: string): number {
  const parts = schedule.trim().split(/\s+/)
  if (parts.length !== 5) return 24 * 60 * 60 * 1000

  const [minute, hour] = parts

  // */N * * * * → every N minutes
  if (minute?.startsWith('*/') && hour === '*') {
    const n = parseInt(minute.slice(2), 10)
    if (!Number.isNaN(n) && n > 0) return n * 60 * 1000
  }

  // 0 N * * * → daily at hour N → 24h interval
  // 0 N * * 0 → weekly → 7*24h interval
  const dow = parts[4]
  if (dow !== undefined && dow !== '*') {
    return 7 * 24 * 60 * 60 * 1000 // weekly
  }

  return 24 * 60 * 60 * 1000 // daily default
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Wraps a cron handler to record health on success.
 */
function wrapWithHealthTracking(def: CronDefinition): () => Promise<void> {
  return async () => {
    await def.handler()
    recordCronSuccess(def.id)
  }
}

/**
 * Registers all OMG cron jobs with the OpenClaw plugin API.
 * Falls back to setInterval-based scheduling when api.scheduleCron is unavailable.
 *
 * @param api    The OpenClaw plugin API (provides `scheduleCron`).
 * @param config The validated OMG plugin configuration.
 * @param ctx    Context shared by all cron handlers.
 */
export function registerCronJobs(api: PluginApi, config: OmgConfig, ctx: CronContext): void {
  const definitions = createCronDefinitions(ctx)

  if (typeof api.scheduleCron === 'function') {
    for (const def of definitions) {
      api.scheduleCron(def.id, def.schedule, wrapWithHealthTracking(def))
    }
    return
  }

  // Fallback: setInterval-based scheduling
  console.warn(
    '[omg] registerCronJobs: api.scheduleCron is not available — using setInterval fallback'
  )

  for (const def of definitions) {
    // Clear any existing interval for this job (idempotency)
    const existing = activeIntervals.get(def.id)
    if (existing) clearInterval(existing)

    const intervalMs = cronToIntervalMs(def.schedule)
    const wrappedHandler = wrapWithHealthTracking(def)

    const interval = setInterval(() => {
      wrappedHandler().catch((err) =>
        console.error(`[omg] cron fallback: job "${def.id}" failed:`, err)
      )
    }, intervalMs)

    // Prevent the interval from keeping the process alive
    if (typeof interval === 'object' && 'unref' in interval) {
      interval.unref()
    }

    activeIntervals.set(def.id, interval)
    console.warn(
      `[omg] cron fallback: registered "${def.id}" with interval ${Math.round(intervalMs / 1000)}s`
    )
  }
}
