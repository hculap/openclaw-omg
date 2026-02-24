import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { vol } from 'memfs'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

import {
  computeCursor,
  createInitialState,
  advanceBatch,
  finalizeState,
  pauseState,
  isStaleRunning,
  shouldBootstrap,
  readBootstrapState,
  writeBootstrapState,
  createDebouncedFlush,
  type BootstrapState,
} from '../../../src/bootstrap/state.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<BootstrapState> = {}): BootstrapState {
  return {
    version: 2,
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cursor: 0,
    total: 3,
    ok: 0,
    fail: 0,
    done: [],
    lastError: null,
    ...overrides,
  }
}

const OMG_ROOT = '/workspace/memory/omg'
const STATE_PATH = `${OMG_ROOT}/.bootstrap-state.json`
const LEGACY_PATH = `${OMG_ROOT}/.bootstrap-done`

beforeEach(() => {
  vol.reset()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// computeCursor
// ---------------------------------------------------------------------------

describe('computeCursor', () => {
  it('returns 0 for empty done set', () => {
    expect(computeCursor([], 5)).toBe(0)
  })

  it('returns contiguous prefix length for sequential done', () => {
    expect(computeCursor([0, 1, 2], 5)).toBe(3)
  })

  it('stops at first gap', () => {
    expect(computeCursor([0, 1, 3], 5)).toBe(2)
  })

  it('returns total when all done', () => {
    expect(computeCursor([0, 1, 2, 3, 4], 5)).toBe(5)
  })

  it('handles out-of-order done list', () => {
    expect(computeCursor([2, 0, 1], 5)).toBe(3)
  })

  it('returns 0 when first batch missing', () => {
    expect(computeCursor([1, 2], 5)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// createInitialState
// ---------------------------------------------------------------------------

describe('createInitialState', () => {
  it('creates a running state with correct defaults', () => {
    const state = createInitialState(5)
    expect(state.version).toBe(2)
    expect(state.status).toBe('running')
    expect(state.cursor).toBe(0)
    expect(state.total).toBe(5)
    expect(state.ok).toBe(0)
    expect(state.fail).toBe(0)
    expect(state.done).toEqual([])
    expect(state.lastError).toBeNull()
  })

  it('sets timestamps', () => {
    const before = new Date().toISOString()
    const state = createInitialState(1)
    const after = new Date().toISOString()
    expect(state.startedAt >= before).toBe(true)
    expect(state.startedAt <= after).toBe(true)
    expect(state.updatedAt).toBe(state.startedAt)
  })

  it('handles zero batches', () => {
    const state = createInitialState(0)
    expect(state.total).toBe(0)
    expect(state.cursor).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// advanceBatch
// ---------------------------------------------------------------------------

describe('advanceBatch', () => {
  it('adds batchId to done and increments ok on success', () => {
    const state = makeState({ total: 3 })
    const next = advanceBatch(state, 0, { chunkCount: 2, observationSucceeded: true })
    expect(next.done).toEqual([0])
    expect(next.ok).toBe(2)
    expect(next.fail).toBe(0)
    expect(next.cursor).toBe(1)
  })

  it('increments fail on failure', () => {
    const state = makeState({ total: 3 })
    const next = advanceBatch(state, 0, { chunkCount: 3, observationSucceeded: false })
    expect(next.done).toEqual([0])
    expect(next.ok).toBe(0)
    expect(next.fail).toBe(3)
    expect(next.lastError).toBe('batch observation failed')
  })

  it('does not mutate the input state', () => {
    const state = makeState({ total: 3, done: [0] })
    const originalDone = [...state.done]
    advanceBatch(state, 1, { chunkCount: 1, observationSucceeded: true })
    expect(state.done).toEqual(originalDone)
    expect(state.ok).toBe(0)
  })

  it('recomputes cursor across multiple advances', () => {
    let state = makeState({ total: 4 })
    state = advanceBatch(state, 0, { chunkCount: 1, observationSucceeded: true })
    expect(state.cursor).toBe(1)
    // Skip batch 1, do batch 2
    state = advanceBatch(state, 2, { chunkCount: 1, observationSucceeded: true })
    expect(state.cursor).toBe(1) // batch 1 still missing
    // Now do batch 1
    state = advanceBatch(state, 1, { chunkCount: 1, observationSucceeded: true })
    expect(state.cursor).toBe(3) // 0,1,2 done → cursor=3
  })
})

// ---------------------------------------------------------------------------
// finalizeState
// ---------------------------------------------------------------------------

describe('finalizeState', () => {
  it('sets status to completed when ok > 0', () => {
    const state = makeState({ ok: 3, fail: 1, done: [0, 1, 2], total: 3 })
    const final = finalizeState(state)
    expect(final.status).toBe('completed')
    expect(final.done).toEqual([])
    expect(final.cursor).toBe(3)
  })

  it('sets status to failed when ok = 0 and total > 0', () => {
    const state = makeState({ ok: 0, fail: 3, done: [0, 1, 2], total: 3 })
    const final = finalizeState(state)
    expect(final.status).toBe('failed')
  })

  it('sets status to completed when total = 0', () => {
    const state = makeState({ ok: 0, fail: 0, done: [], total: 0 })
    const final = finalizeState(state)
    expect(final.status).toBe('completed')
  })

  it('clears done array', () => {
    const state = makeState({ done: [0, 1, 2], total: 3, ok: 3 })
    const final = finalizeState(state)
    expect(final.done).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// isStaleRunning
// ---------------------------------------------------------------------------

describe('isStaleRunning', () => {
  it('returns false for completed state', () => {
    const state = makeState({ status: 'completed' })
    expect(isStaleRunning(state)).toBe(false)
  })

  it('returns false for fresh running state', () => {
    const state = makeState({ status: 'running', updatedAt: new Date().toISOString() })
    expect(isStaleRunning(state)).toBe(false)
  })

  it('returns true for stale running state', () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const state = makeState({ status: 'running', updatedAt: staleTime })
    expect(isStaleRunning(state)).toBe(true)
  })

  it('returns false for failed state even if stale', () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const state = makeState({ status: 'failed', updatedAt: staleTime })
    expect(isStaleRunning(state)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shouldBootstrap
// ---------------------------------------------------------------------------

describe('shouldBootstrap', () => {
  it('returns needed when state is null', () => {
    const decision = shouldBootstrap(null, false)
    expect(decision.needed).toBe(true)
    expect(decision.resumeFromDone).toBeUndefined()
  })

  it('returns not needed when completed', () => {
    const state = makeState({ status: 'completed' })
    expect(shouldBootstrap(state, false).needed).toBe(false)
  })

  it('returns resume when failed', () => {
    const state = makeState({ status: 'failed', done: [0, 2] })
    const decision = shouldBootstrap(state, false)
    expect(decision.needed).toBe(true)
    expect(decision.resumeFromDone).toEqual([0, 2])
  })

  it('returns resume when running but stale', () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const state = makeState({ status: 'running', updatedAt: staleTime, done: [0] })
    const decision = shouldBootstrap(state, false)
    expect(decision.needed).toBe(true)
    expect(decision.resumeFromDone).toEqual([0])
  })

  it('returns not needed when running and fresh', () => {
    const state = makeState({ status: 'running', updatedAt: new Date().toISOString() })
    expect(shouldBootstrap(state, false).needed).toBe(false)
  })

  it('returns needed with force regardless of state', () => {
    const state = makeState({ status: 'completed' })
    const decision = shouldBootstrap(state, true)
    expect(decision.needed).toBe(true)
    expect(decision.resumeFromDone).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// readBootstrapState
// ---------------------------------------------------------------------------

describe('readBootstrapState', () => {
  it('returns null when no files exist', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/nodes/.keep`]: '' })
    expect(await readBootstrapState(OMG_ROOT)).toBeNull()
  })

  it('parses valid state file', async () => {
    const state = makeState({ status: 'completed', total: 5, ok: 4, fail: 1 })
    vol.fromJSON({ [STATE_PATH]: JSON.stringify(state) })
    const result = await readBootstrapState(OMG_ROOT)
    expect(result).not.toBeNull()
    expect(result!.status).toBe('completed')
    expect(result!.total).toBe(5)
    expect(result!.ok).toBe(4)
  })

  it('returns null for corrupted JSON', async () => {
    vol.fromJSON({ [STATE_PATH]: '{not valid json' })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await readBootstrapState(OMG_ROOT)).toBeNull()
    consoleSpy.mockRestore()
  })

  it('returns null for wrong version', async () => {
    const badState = { ...makeState(), version: 1 }
    vol.fromJSON({ [STATE_PATH]: JSON.stringify(badState) })
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await readBootstrapState(OMG_ROOT)).toBeNull()
    consoleSpy.mockRestore()
  })

  it('migrates legacy sentinel to completed state', async () => {
    vol.fromJSON({
      [LEGACY_PATH]: JSON.stringify({
        completedAt: '2026-01-01T00:00:00Z',
        chunksProcessed: 10,
        chunksSucceeded: 8,
      }),
    })

    const result = await readBootstrapState(OMG_ROOT)
    expect(result).not.toBeNull()
    expect(result!.status).toBe('completed')
    expect(result!.ok).toBe(8)
    expect(result!.version).toBe(2)

    // State file should have been written
    expect(vol.existsSync(STATE_PATH)).toBe(true)
  })

  it('prefers state file over legacy sentinel', async () => {
    const state = makeState({ status: 'failed', ok: 2, fail: 1 })
    vol.fromJSON({
      [STATE_PATH]: JSON.stringify(state),
      [LEGACY_PATH]: JSON.stringify({
        completedAt: '2026-01-01T00:00:00Z',
        chunksProcessed: 10,
        chunksSucceeded: 10,
      }),
    })

    const result = await readBootstrapState(OMG_ROOT)
    expect(result!.status).toBe('failed')
    expect(result!.ok).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// writeBootstrapState
// ---------------------------------------------------------------------------

describe('writeBootstrapState', () => {
  it('writes valid JSON and returns true', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/nodes/.keep`]: '' })
    const state = makeState({ status: 'completed' })
    const ok = await writeBootstrapState(OMG_ROOT, state)
    expect(ok).toBe(true)

    const raw = vol.readFileSync(STATE_PATH, 'utf-8') as string
    const parsed = JSON.parse(raw)
    expect(parsed.status).toBe('completed')
    expect(parsed.version).toBe(2)
  })

  it('returns false when directory is missing', async () => {
    // No vol setup → directory doesn't exist
    vol.fromJSON({})
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ok = await writeBootstrapState('/nonexistent/path', makeState())
    expect(ok).toBe(false)
    consoleSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// createDebouncedFlush
// ---------------------------------------------------------------------------

describe('createDebouncedFlush', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('flushNow writes immediately', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/nodes/.keep`]: '' })
    const { flushNow } = createDebouncedFlush(OMG_ROOT, 1000)
    const state = makeState({ status: 'completed', ok: 5 })

    const ok = await flushNow(state)
    expect(ok).toBe(true)
    expect(vol.existsSync(STATE_PATH)).toBe(true)
  })

  it('flush coalesces multiple calls', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/nodes/.keep`]: '' })
    const { flush } = createDebouncedFlush(OMG_ROOT, 100)

    const state1 = makeState({ ok: 1 })
    const state2 = makeState({ ok: 2 })
    const state3 = makeState({ ok: 3 })

    flush(state1)
    flush(state2)
    flush(state3)

    // Nothing written yet (timer hasn't fired)
    expect(vol.existsSync(STATE_PATH)).toBe(false)

    // Advance timers to fire the debounce
    await vi.advanceTimersByTimeAsync(150)

    // Should have written the last state
    expect(vol.existsSync(STATE_PATH)).toBe(true)
    const raw = vol.readFileSync(STATE_PATH, 'utf-8') as string
    const parsed = JSON.parse(raw)
    expect(parsed.ok).toBe(3)
  })

  it('flushNow clears pending timer', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/nodes/.keep`]: '' })
    const { flush, flushNow } = createDebouncedFlush(OMG_ROOT, 1000)

    const state1 = makeState({ ok: 1 })
    const state2 = makeState({ ok: 99 })

    flush(state1) // queued
    await flushNow(state2) // immediate, should clear timer

    const raw = vol.readFileSync(STATE_PATH, 'utf-8') as string
    const parsed = JSON.parse(raw)
    expect(parsed.ok).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// pauseState
// ---------------------------------------------------------------------------

describe('pauseState', () => {
  it('sets status to paused', () => {
    const state = makeState({ status: 'running' })
    const paused = pauseState(state)
    expect(paused.status).toBe('paused')
  })

  it('updates the updatedAt timestamp', () => {
    const oldTime = '2025-01-01T00:00:00Z'
    const state = makeState({ status: 'running', updatedAt: oldTime })
    const paused = pauseState(state)
    expect(paused.updatedAt).not.toBe(oldTime)
    expect(new Date(paused.updatedAt).getTime()).toBeGreaterThan(new Date(oldTime).getTime())
  })

  it('does not mutate the input state', () => {
    const state = makeState({ status: 'running' })
    pauseState(state)
    expect(state.status).toBe('running')
  })

  it('preserves all other fields', () => {
    const state = makeState({
      status: 'running',
      cursor: 5,
      total: 10,
      ok: 3,
      fail: 1,
      done: [0, 1, 2, 3, 4],
      lastError: 'some error',
    })
    const paused = pauseState(state)
    expect(paused.cursor).toBe(5)
    expect(paused.total).toBe(10)
    expect(paused.ok).toBe(3)
    expect(paused.fail).toBe(1)
    expect(paused.done).toEqual([0, 1, 2, 3, 4])
    expect(paused.lastError).toBe('some error')
  })
})

// ---------------------------------------------------------------------------
// shouldBootstrap — paused status
// ---------------------------------------------------------------------------

describe('shouldBootstrap — paused status', () => {
  it('returns needed with resumeFromDone when status is paused', () => {
    const state = makeState({ status: 'paused', done: [0, 1, 3] })
    const decision = shouldBootstrap(state, false)
    expect(decision.needed).toBe(true)
    expect(decision.resumeFromDone).toEqual([0, 1, 3])
  })

  it('returns needed without resumeFromDone when force is true and status is paused', () => {
    const state = makeState({ status: 'paused', done: [0, 1] })
    const decision = shouldBootstrap(state, true)
    expect(decision.needed).toBe(true)
    expect(decision.resumeFromDone).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// isStaleRunning — paused status
// ---------------------------------------------------------------------------

describe('isStaleRunning — paused status', () => {
  it('returns false for paused state (not running)', () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const state = makeState({ status: 'paused', updatedAt: staleTime })
    expect(isStaleRunning(state)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// readBootstrapState — paused status
// ---------------------------------------------------------------------------

describe('readBootstrapState — paused status', () => {
  it('parses a valid paused state file', async () => {
    const state = makeState({ status: 'paused', done: [0, 1], cursor: 2, total: 5 })
    vol.fromJSON({ [STATE_PATH]: JSON.stringify(state) })
    const result = await readBootstrapState(OMG_ROOT)
    expect(result).not.toBeNull()
    expect(result!.status).toBe('paused')
    expect(result!.done).toEqual([0, 1])
  })
})
