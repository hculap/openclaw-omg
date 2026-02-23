import { describe, it, expect, beforeEach } from 'vitest'
import { vol } from 'memfs'
import {
  appendAuditEntry,
  readAuditLog,
} from '../../../src/dedup/audit.js'
import type { DedupAuditEntry } from '../../../src/dedup/types.js'

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

function makeEntry(keepNodeId: string): DedupAuditEntry {
  return {
    timestamp: '2024-06-01T03:00:00Z',
    keepNodeId,
    mergedNodeIds: ['omg/preference/loser'],
    aliasKeys: ['preferences.old_key'],
    conflicts: [],
    patch: { description: 'Updated description' },
  }
}

beforeEach(() => {
  vol.reset()
  vol.fromJSON({ [`${OMG_ROOT}/.keep`]: '' })
})

// ---------------------------------------------------------------------------
// appendAuditEntry
// ---------------------------------------------------------------------------

describe('appendAuditEntry', () => {
  it('creates audit log file with one entry', async () => {
    const entry = makeEntry('omg/preference/keeper')
    await appendAuditEntry(OMG_ROOT, entry)
    const entries = await readAuditLog(OMG_ROOT)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.keepNodeId).toBe('omg/preference/keeper')
  })

  it('appends multiple entries', async () => {
    await appendAuditEntry(OMG_ROOT, makeEntry('omg/preference/a'))
    await appendAuditEntry(OMG_ROOT, makeEntry('omg/preference/b'))
    await appendAuditEntry(OMG_ROOT, makeEntry('omg/preference/c'))
    const entries = await readAuditLog(OMG_ROOT)
    expect(entries).toHaveLength(3)
  })

  it('entries are in insertion order', async () => {
    await appendAuditEntry(OMG_ROOT, makeEntry('omg/preference/first'))
    await appendAuditEntry(OMG_ROOT, makeEntry('omg/preference/second'))
    const entries = await readAuditLog(OMG_ROOT)
    expect(entries[0]!.keepNodeId).toBe('omg/preference/first')
    expect(entries[1]!.keepNodeId).toBe('omg/preference/second')
  })
})

// ---------------------------------------------------------------------------
// readAuditLog
// ---------------------------------------------------------------------------

describe('readAuditLog', () => {
  it('returns empty array when file does not exist', async () => {
    const entries = await readAuditLog(OMG_ROOT)
    expect(entries).toEqual([])
  })

  it('skips malformed JSONL lines', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/.dedup-audit.jsonl`]:
        `{"keepNodeId":"omg/a","mergedNodeIds":[],"aliasKeys":[],"conflicts":[],"patch":{},"timestamp":"2024-01-01T00:00:00Z"}\nnot-valid-json\n{"keepNodeId":"omg/b","mergedNodeIds":[],"aliasKeys":[],"conflicts":[],"patch":{},"timestamp":"2024-01-01T00:00:00Z"}\n`,
    })
    const entries = await readAuditLog(OMG_ROOT)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.keepNodeId).toBe('omg/a')
    expect(entries[1]!.keepNodeId).toBe('omg/b')
  })

  it('returns empty array for empty file', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/.dedup-audit.jsonl`]: '' })
    const entries = await readAuditLog(OMG_ROOT)
    expect(entries).toEqual([])
  })
})
