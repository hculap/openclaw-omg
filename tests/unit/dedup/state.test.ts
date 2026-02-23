import { describe, it, expect, beforeEach } from 'vitest'
import { vol } from 'memfs'
import {
  loadDedupState,
  saveDedupState,
} from '../../../src/dedup/state.js'
import { getDefaultDedupState } from '../../../src/dedup/types.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

import { vi } from 'vitest'

const OMG_ROOT = '/workspace/memory/omg'

beforeEach(() => {
  vol.reset()
  vol.fromJSON({ [`${OMG_ROOT}/.keep`]: '' })
})

// ---------------------------------------------------------------------------
// loadDedupState
// ---------------------------------------------------------------------------

describe('loadDedupState', () => {
  it('returns defaults when no state file exists', async () => {
    const state = await loadDedupState(OMG_ROOT)
    expect(state.lastDedupAt).toBeNull()
    expect(state.runsCompleted).toBe(0)
    expect(state.totalMerges).toBe(0)
  })

  it('loads persisted state correctly', async () => {
    const persisted = {
      lastDedupAt: '2024-06-01T03:00:00Z',
      runsCompleted: 5,
      totalMerges: 12,
    }
    vol.fromJSON({ [`${OMG_ROOT}/.dedup-state.json`]: JSON.stringify(persisted) })

    const state = await loadDedupState(OMG_ROOT)
    expect(state.lastDedupAt).toBe('2024-06-01T03:00:00Z')
    expect(state.runsCompleted).toBe(5)
    expect(state.totalMerges).toBe(12)
  })

  it('returns defaults when file contains invalid JSON', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/.dedup-state.json`]: 'not-json' })
    const state = await loadDedupState(OMG_ROOT)
    expect(state).toEqual(getDefaultDedupState())
  })

  it('returns defaults when file contains invalid schema', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/.dedup-state.json`]: JSON.stringify({ foo: 'bar' }) })
    const state = await loadDedupState(OMG_ROOT)
    expect(state).toEqual(getDefaultDedupState())
  })
})

// ---------------------------------------------------------------------------
// saveDedupState
// ---------------------------------------------------------------------------

describe('saveDedupState', () => {
  it('persists state to disk', async () => {
    const state = {
      lastDedupAt: '2024-07-01T03:00:00Z',
      runsCompleted: 3,
      totalMerges: 7,
    }
    await saveDedupState(OMG_ROOT, state)
    const loaded = await loadDedupState(OMG_ROOT)
    expect(loaded.lastDedupAt).toBe('2024-07-01T03:00:00Z')
    expect(loaded.runsCompleted).toBe(3)
    expect(loaded.totalMerges).toBe(7)
  })

  it('round-trips state correctly', async () => {
    const state = {
      lastDedupAt: null,
      runsCompleted: 0,
      totalMerges: 0,
    }
    await saveDedupState(OMG_ROOT, state)
    const loaded = await loadDedupState(OMG_ROOT)
    expect(loaded).toEqual(state)
  })
})
