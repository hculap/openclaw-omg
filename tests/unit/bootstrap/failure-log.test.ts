import { describe, it, expect, beforeEach } from 'vitest'
import { vol } from 'memfs'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

import { vi } from 'vitest'
import {
  appendFailureEntry,
  readFailureLog,
  clearFailureLog,
  type BootstrapFailureEntry,
} from '../../../src/bootstrap/failure-log.js'

const OMG_ROOT = '/workspace/memory/omg'

function makeEntry(batchIndex: number, errorType: BootstrapFailureEntry['errorType'] = 'parse-empty'): BootstrapFailureEntry {
  return {
    batchIndex,
    labels: [`chunk-${batchIndex}`],
    errorType,
    error: `test error for batch ${batchIndex}`,
    timestamp: '2024-06-01T03:00:00Z',
    diagnostics: null,
    chunkCount: 3,
  }
}

beforeEach(() => {
  vol.reset()
  vol.fromJSON({ [`${OMG_ROOT}/.keep`]: '' })
})

// ---------------------------------------------------------------------------
// appendFailureEntry
// ---------------------------------------------------------------------------

describe('appendFailureEntry', () => {
  it('creates failure log file with one entry', async () => {
    await appendFailureEntry(OMG_ROOT, makeEntry(0))
    const entries = await readFailureLog(OMG_ROOT)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.batchIndex).toBe(0)
  })

  it('appends multiple entries', async () => {
    await appendFailureEntry(OMG_ROOT, makeEntry(0))
    await appendFailureEntry(OMG_ROOT, makeEntry(1))
    await appendFailureEntry(OMG_ROOT, makeEntry(2))
    const entries = await readFailureLog(OMG_ROOT)
    expect(entries).toHaveLength(3)
  })

  it('entries are in insertion order', async () => {
    await appendFailureEntry(OMG_ROOT, makeEntry(5))
    await appendFailureEntry(OMG_ROOT, makeEntry(3))
    const entries = await readFailureLog(OMG_ROOT)
    expect(entries[0]!.batchIndex).toBe(5)
    expect(entries[1]!.batchIndex).toBe(3)
  })

  it('preserves diagnostics when present', async () => {
    const entry: BootstrapFailureEntry = {
      ...makeEntry(0, 'zero-operations'),
      diagnostics: {
        totalCandidates: 5,
        accepted: 0,
        rejectedReasons: ['unknown type', 'missing key'],
      },
    }
    await appendFailureEntry(OMG_ROOT, entry)
    const entries = await readFailureLog(OMG_ROOT)
    expect(entries[0]!.diagnostics).toEqual({
      totalCandidates: 5,
      accepted: 0,
      rejectedReasons: ['unknown type', 'missing key'],
    })
  })
})

// ---------------------------------------------------------------------------
// readFailureLog
// ---------------------------------------------------------------------------

describe('readFailureLog', () => {
  it('returns empty array when file does not exist', async () => {
    const entries = await readFailureLog(OMG_ROOT)
    expect(entries).toEqual([])
  })

  it('returns empty array for empty file', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/.bootstrap-failures.jsonl`]: '' })
    const entries = await readFailureLog(OMG_ROOT)
    expect(entries).toEqual([])
  })

  it('skips malformed JSONL lines', async () => {
    const valid1 = JSON.stringify(makeEntry(0))
    const valid2 = JSON.stringify(makeEntry(1))
    vol.fromJSON({
      [`${OMG_ROOT}/.bootstrap-failures.jsonl`]: `${valid1}\nnot-valid-json\n${valid2}\n`,
    })
    const entries = await readFailureLog(OMG_ROOT)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.batchIndex).toBe(0)
    expect(entries[1]!.batchIndex).toBe(1)
  })

  it('skips lines that fail schema validation', async () => {
    const valid = JSON.stringify(makeEntry(0))
    const invalid = JSON.stringify({ batchIndex: 'not-a-number' })
    vol.fromJSON({
      [`${OMG_ROOT}/.bootstrap-failures.jsonl`]: `${valid}\n${invalid}\n`,
    })
    const entries = await readFailureLog(OMG_ROOT)
    expect(entries).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// clearFailureLog
// ---------------------------------------------------------------------------

describe('clearFailureLog', () => {
  it('truncates the failure log', async () => {
    await appendFailureEntry(OMG_ROOT, makeEntry(0))
    await appendFailureEntry(OMG_ROOT, makeEntry(1))
    await clearFailureLog(OMG_ROOT)
    const entries = await readFailureLog(OMG_ROOT)
    expect(entries).toEqual([])
  })

  it('succeeds when file does not exist', async () => {
    await expect(clearFailureLog(OMG_ROOT)).resolves.not.toThrow()
  })
})
