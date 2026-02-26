/**
 * state.ts — Bootstrap state machine with cursor-based resume.
 *
 * Replaces the old sentinel file (`.bootstrap-done`) with a richer state file
 * (`.bootstrap-state.json`) that tracks per-batch completion. If the process
 * crashes mid-run, the next gateway start resumes from the first undone batch
 * instead of re-burning all LLM tokens.
 *
 * All state transitions are immutable — callers hold the latest snapshot and
 * pass it back for the next update.
 */

import path from 'node:path'
import { z } from 'zod'
import { atomicWrite, readFileOrNull } from '../utils/fs.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_VERSION = 2
const STATE_FILENAME = '.bootstrap-state.json'
const LEGACY_SENTINEL_FILENAME = '.bootstrap-done'
/** A running state older than this is considered stale (crashed process). */
const STALE_THRESHOLD_MS = 5 * 60 * 1000 // 5 min

// ---------------------------------------------------------------------------
// Schema & types
// ---------------------------------------------------------------------------

const bootstrapStateSchema = z.object({
  version: z.literal(STATE_VERSION),
  status: z.enum(['running', 'paused', 'completed', 'failed']),
  startedAt: z.string(),
  updatedAt: z.string(),
  /** First batch index NOT yet completed (contiguous prefix optimisation). */
  cursor: z.number().int().min(0),
  /** Total number of batches. */
  total: z.number().int().min(0),
  /** Chunks in batches that succeeded. */
  ok: z.number().int().min(0),
  /** Chunks in batches that failed. */
  fail: z.number().int().min(0),
  /** Set of completed batch indices. */
  done: z.array(z.number().int().min(0)),
  /** Last error message (informational). */
  lastError: z.string().nullable(),
  /** Whether post-bootstrap maintenance (dedup + reflection) has completed. */
  maintenanceDone: z.boolean().default(false),
})

export type BootstrapState = Readonly<z.infer<typeof bootstrapStateSchema>>

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Finds the first index in `[0, total)` that is NOT in `done`. */
export function computeCursor(done: readonly number[], total: number): number {
  const set = new Set(done)
  for (let i = 0; i < total; i++) {
    if (!set.has(i)) return i
  }
  return total
}

// ---------------------------------------------------------------------------
// State factories & transitions
// ---------------------------------------------------------------------------

/** Creates an initial `running` state for a fresh bootstrap run. */
export function createInitialState(totalBatches: number): BootstrapState {
  const now = new Date().toISOString()
  return {
    version: STATE_VERSION,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    cursor: 0,
    total: totalBatches,
    ok: 0,
    fail: 0,
    done: [],
    lastError: null,
    maintenanceDone: false,
  }
}

/**
 * Records a completed batch (immutable).
 *
 * @param state  Current snapshot.
 * @param batchId  Index of the batch that just finished.
 * @param result  Outcome — `chunkCount` and whether the observation succeeded.
 */
export function advanceBatch(
  state: BootstrapState,
  batchId: number,
  result: { readonly chunkCount: number; readonly observationSucceeded: boolean }
): BootstrapState {
  const done = [...state.done, batchId]
  const ok = result.observationSucceeded ? state.ok + result.chunkCount : state.ok
  const fail = result.observationSucceeded ? state.fail : state.fail + result.chunkCount
  return {
    ...state,
    updatedAt: new Date().toISOString(),
    cursor: computeCursor(done, state.total),
    ok,
    fail,
    done,
    lastError: result.observationSucceeded ? state.lastError : 'batch observation failed',
  }
}

/**
 * Marks the bootstrap as paused (immutable).
 * Used when a cron tick exhausts its batch budget but more batches remain.
 * The lock is released so the next tick can resume.
 */
export function pauseState(state: BootstrapState): BootstrapState {
  return {
    ...state,
    status: 'paused',
    updatedAt: new Date().toISOString(),
  }
}

/**
 * Marks the bootstrap as completed or failed (immutable).
 * Clears the `done` array to keep the file small post-run.
 */
export function finalizeState(state: BootstrapState): BootstrapState {
  const status: BootstrapState['status'] =
    state.ok > 0 || state.total === 0 ? 'completed' : 'failed'
  return {
    ...state,
    status,
    updatedAt: new Date().toISOString(),
    done: [],
    cursor: state.total,
    maintenanceDone: false,
  }
}

/**
 * Marks post-bootstrap maintenance as completed (immutable).
 */
export function markMaintenanceDone(state: BootstrapState): BootstrapState {
  return {
    ...state,
    maintenanceDone: true,
    updatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Decision helpers
// ---------------------------------------------------------------------------

/** Returns true when a `running` state has a stale `updatedAt`. */
export function isStaleRunning(state: BootstrapState): boolean {
  if (state.status !== 'running') return false
  const age = Date.now() - new Date(state.updatedAt).getTime()
  return age > STALE_THRESHOLD_MS
}

export interface BootstrapDecision {
  /** Whether bootstrap should run. */
  readonly needed: boolean
  /**
   * If resuming, the set of already-completed batch indices.
   * Undefined when starting fresh or when bootstrap is not needed.
   */
  readonly resumeFromDone?: readonly number[]
}

/**
 * Decides whether bootstrap should run based on existing state.
 *
 * | State            | force=false         | force=true  |
 * |------------------|---------------------|-------------|
 * | null             | needed, fresh       | needed      |
 * | completed        | skip                | needed      |
 * | failed           | resume from done    | needed      |
 * | running (stale)  | resume from done    | needed      |
 * | running (fresh)  | skip (another proc) | needed      |
 */
export function shouldBootstrap(
  state: BootstrapState | null,
  force: boolean
): BootstrapDecision {
  if (force) return { needed: true }
  if (state === null) return { needed: true }

  switch (state.status) {
    case 'completed':
      return { needed: false }
    case 'failed':
      return { needed: true, resumeFromDone: state.done }
    case 'paused':
      return { needed: true, resumeFromDone: state.done }
    case 'running':
      if (isStaleRunning(state)) {
        return { needed: true, resumeFromDone: state.done }
      }
      // Fresh running → another process is active, don't interfere
      return { needed: false }
    default:
      return { needed: true }
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function statePath(omgRoot: string): string {
  return path.join(omgRoot, STATE_FILENAME)
}

function legacySentinelPath(omgRoot: string): string {
  return path.join(omgRoot, LEGACY_SENTINEL_FILENAME)
}

/**
 * Reads and validates the state file. Returns null when the file is missing
 * or corrupted. If no state file exists but a legacy `.bootstrap-done` does,
 * synthesises a `completed` state and persists it.
 *
 * Never throws.
 */
export async function readBootstrapState(omgRoot: string): Promise<BootstrapState | null> {
  // Try the new state file first
  const raw = await readFileOrNull(statePath(omgRoot))
  if (raw !== null) {
    try {
      return bootstrapStateSchema.parse(JSON.parse(raw))
    } catch {
      console.error('[omg] state: corrupted state file — treating as absent')
      return null
    }
  }

  // Legacy migration: synthesise a completed state from the old sentinel
  const legacyRaw = await readFileOrNull(legacySentinelPath(omgRoot))
  if (legacyRaw !== null) {
    try {
      const legacy = JSON.parse(legacyRaw) as Record<string, unknown>
      const completedAt =
        typeof legacy['completedAt'] === 'string'
          ? legacy['completedAt']
          : new Date().toISOString()

      const migrated: BootstrapState = {
        version: STATE_VERSION,
        status: 'completed',
        startedAt: completedAt,
        updatedAt: completedAt,
        cursor: 0,
        total: 0,
        ok: typeof legacy['chunksSucceeded'] === 'number' ? (legacy['chunksSucceeded'] as number) : 0,
        fail: 0,
        done: [],
        lastError: null,
        maintenanceDone: true,
      }

      // Persist the migrated state so we never need to read the legacy file again
      await writeBootstrapState(omgRoot, migrated)
      return migrated
    } catch {
      // Legacy file unparseable — treat as absent
      return null
    }
  }

  return null
}

/**
 * Atomically writes the state file.
 * Returns true on success, false on failure (logged, non-fatal).
 */
export async function writeBootstrapState(
  omgRoot: string,
  state: BootstrapState
): Promise<boolean> {
  try {
    await atomicWrite(statePath(omgRoot), JSON.stringify(state, null, 2))
    return true
  } catch (err) {
    console.error(
      '[omg] state: failed to write state file — progress may be lost on restart:',
      err
    )
    return false
  }
}

// ---------------------------------------------------------------------------
// Debounced flush
// ---------------------------------------------------------------------------

export interface DebouncedFlush {
  /** Enqueue a write (coalesced). */
  flush(state: BootstrapState): void
  /** Force an immediate write (clears pending timer). */
  flushNow(state: BootstrapState): Promise<boolean>
}

/**
 * Creates a debounced writer that coalesces rapid state updates into a single
 * disk write per `delayMs` window. Workers call `flush()` after each batch;
 * the orchestrator calls `flushNow()` at the end to guarantee persistence.
 */
export function createDebouncedFlush(omgRoot: string, delayMs = 500): DebouncedFlush {
  let pending: BootstrapState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  async function flushNow(state: BootstrapState): Promise<boolean> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
    return writeBootstrapState(omgRoot, state)
  }

  function flush(state: BootstrapState): void {
    pending = state
    if (!timer) {
      timer = setTimeout(() => {
        timer = null
        if (pending) {
          writeBootstrapState(omgRoot, pending)
          pending = null
        }
      }, delayMs)
    }
  }

  return { flush, flushNow }
}
