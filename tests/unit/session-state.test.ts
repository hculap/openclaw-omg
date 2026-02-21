import { describe, it, expect, beforeEach } from 'vitest'
import { vi } from 'vitest'
import { vol } from 'memfs'
import { loadSessionState, saveSessionState, getDefaultSessionState } from '../../src/state/session-state.js'
import type { OmgSessionState } from '../../src/types.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

const WORKSPACE = '/workspace'
const SESSION_KEY = 'session-abc123'
const STATE_PATH = `${WORKSPACE}/.omg-state/${SESSION_KEY}.json`

function validState(): OmgSessionState {
  return {
    lastObservedAtMs: 1_000_000,
    pendingMessageTokens: 500,
    totalObservationTokens: 3000,
    lastReflectionTotalTokens: 0,
    observationBoundaryMessageIndex: 5,
    nodeCount: 12,
    lastObservationNodeIds: ['omg/fact/alpha', 'omg/fact/beta'],
  }
}

beforeEach(() => {
  vol.reset()
})

// ---------------------------------------------------------------------------
// getDefaultSessionState
// ---------------------------------------------------------------------------

describe('getDefaultSessionState', () => {
  it('returns all-zero numeric fields', () => {
    const state = getDefaultSessionState()
    expect(state.lastObservedAtMs).toBe(0)
    expect(state.pendingMessageTokens).toBe(0)
    expect(state.totalObservationTokens).toBe(0)
    expect(state.lastReflectionTotalTokens).toBe(0)
    expect(state.observationBoundaryMessageIndex).toBe(0)
    expect(state.nodeCount).toBe(0)
  })

  it('returns empty lastObservationNodeIds array', () => {
    const state = getDefaultSessionState()
    expect(state.lastObservationNodeIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// loadSessionState — missing file
// ---------------------------------------------------------------------------

describe('loadSessionState — missing file', () => {
  it('returns default state when file does not exist', async () => {
    const state = await loadSessionState(WORKSPACE, SESSION_KEY)
    const defaults = getDefaultSessionState()
    expect(state).toEqual(defaults)
  })
})

// ---------------------------------------------------------------------------
// saveSessionState + loadSessionState — round-trip
// ---------------------------------------------------------------------------

describe('saveSessionState + loadSessionState', () => {
  it('round-trips state correctly', async () => {
    const original = validState()
    await saveSessionState(WORKSPACE, SESSION_KEY, original)
    const loaded = await loadSessionState(WORKSPACE, SESSION_KEY)
    expect(loaded).toEqual(original)
  })

  it('creates .omg-state directory if it does not exist', async () => {
    await saveSessionState(WORKSPACE, SESSION_KEY, validState())
    const { fs } = await import('memfs')
    expect(fs.existsSync(STATE_PATH)).toBe(true)
  })

  it('overwrites existing state on subsequent saves', async () => {
    await saveSessionState(WORKSPACE, SESSION_KEY, validState())
    const updated: OmgSessionState = {
      ...validState(),
      pendingMessageTokens: 9999,
      nodeCount: 99,
    }
    await saveSessionState(WORKSPACE, SESSION_KEY, updated)
    const loaded = await loadSessionState(WORKSPACE, SESSION_KEY)
    expect(loaded.pendingMessageTokens).toBe(9999)
    expect(loaded.nodeCount).toBe(99)
  })

  it('persists lastObservationNodeIds correctly', async () => {
    const state: OmgSessionState = { ...validState(), lastObservationNodeIds: ['omg/fact/node-1', 'omg/fact/node-2'] }
    await saveSessionState(WORKSPACE, SESSION_KEY, state)
    const loaded = await loadSessionState(WORKSPACE, SESSION_KEY)
    expect(loaded.lastObservationNodeIds).toEqual(['omg/fact/node-1', 'omg/fact/node-2'])
  })

  it('isolates state per sessionKey', async () => {
    const stateA: OmgSessionState = { ...validState(), nodeCount: 1 }
    const stateB: OmgSessionState = { ...validState(), nodeCount: 2 }
    await saveSessionState(WORKSPACE, 'session-a', stateA)
    await saveSessionState(WORKSPACE, 'session-b', stateB)
    const loadedA = await loadSessionState(WORKSPACE, 'session-a')
    const loadedB = await loadSessionState(WORKSPACE, 'session-b')
    expect(loadedA.nodeCount).toBe(1)
    expect(loadedB.nodeCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// loadSessionState — invalid JSON graceful recovery
// ---------------------------------------------------------------------------

describe('loadSessionState — invalid JSON', () => {
  it('returns default state when file contains invalid JSON', async () => {
    vol.fromJSON({ [STATE_PATH]: 'not valid json {{{{' })
    const state = await loadSessionState(WORKSPACE, SESSION_KEY)
    expect(state).toEqual(getDefaultSessionState())
  })

  it('returns default state when file is empty', async () => {
    vol.fromJSON({ [STATE_PATH]: '' })
    const state = await loadSessionState(WORKSPACE, SESSION_KEY)
    expect(state).toEqual(getDefaultSessionState())
  })
})
