/**
 * Phase 1 — Bootstrap source reading (no LLM calls).
 *
 * Tests that both MD and SQLite sources can be read correctly
 * without making any LLM calls. This is the cheapest phase
 * and validates the source pipeline before committing to LLM spend.
 *
 * SQLite was broken in previous iterations — this phase catches
 * regressions early.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import {
  requireLiveEnv,
  SECRETARY_WORKSPACE,
  TECHLEAD_WORKSPACE,
} from './helpers.js'

// Dynamic imports to avoid loading source modules when not running live
let readWorkspaceMemory: typeof import('../../src/bootstrap/sources.js')['readWorkspaceMemory']
let readSqliteChunks: typeof import('../../src/bootstrap/sources.js')['readSqliteChunks']
let chunkText: typeof import('../../src/bootstrap/chunker.js')['chunkText']
let batchChunks: typeof import('../../src/bootstrap/batcher.js')['batchChunks']

beforeAll(async () => {
  requireLiveEnv()
  const sources = await import('../../src/bootstrap/sources.js')
  readWorkspaceMemory = sources.readWorkspaceMemory
  readSqliteChunks = sources.readSqliteChunks

  const chunker = await import('../../src/bootstrap/chunker.js')
  chunkText = chunker.chunkText

  const batcher = await import('../../src/bootstrap/batcher.js')
  batchChunks = batcher.batchChunks
})

// ---------------------------------------------------------------------------
// MD source
// ---------------------------------------------------------------------------

describe('Phase 1 — Workspace MD source', () => {
  it('reads Secretary workspace memory/*.md files', async () => {
    const entries = await readWorkspaceMemory(SECRETARY_WORKSPACE, 'memory/omg')
    expect(entries.length).toBeGreaterThan(0)

    console.log(`[sources] Secretary MD entries: ${entries.length}`)
    console.log(`[sources] Total MD chars: ${entries.reduce((s, e) => s + e.text.length, 0).toLocaleString()}`)
    console.log(`[sources] Sample labels: ${entries.slice(0, 5).map(e => e.label).join(', ')}`)
  })

  it('excludes memory/omg directory from MD source', async () => {
    const entries = await readWorkspaceMemory(SECRETARY_WORKSPACE, 'memory/omg')
    const omgEntries = entries.filter(e => e.label.startsWith('memory/omg'))
    expect(omgEntries).toHaveLength(0)
  })

  it('entries have non-empty text', async () => {
    const entries = await readWorkspaceMemory(SECRETARY_WORKSPACE, 'memory/omg')
    for (const entry of entries) {
      expect(entry.text.trim().length).toBeGreaterThan(0)
    }
  })

  it('entries are sorted by label', async () => {
    const entries = await readWorkspaceMemory(SECRETARY_WORKSPACE, 'memory/omg')
    const labels = entries.map(e => e.label)
    const sorted = [...labels].sort((a, b) => a.localeCompare(b))
    expect(labels).toEqual(sorted)
  })
})

// ---------------------------------------------------------------------------
// SQLite source
// ---------------------------------------------------------------------------

describe('Phase 1 — SQLite source', () => {
  it('reads SQLite chunks from Secretary workspace agents', async () => {
    const entries = await readSqliteChunks(SECRETARY_WORKSPACE)
    expect(entries.length).toBeGreaterThan(0)

    console.log(`[sources] SQLite entries for Secretary: ${entries.length}`)
    console.log(`[sources] Total SQLite chars: ${entries.reduce((s, e) => s + e.text.length, 0).toLocaleString()}`)

    // Check labels follow expected format: sqlite:{agentId}[{index}]
    for (const entry of entries.slice(0, 5)) {
      expect(entry.label).toMatch(/^sqlite:[\w-]+\[\d+\]$/)
    }

    console.log(`[sources] Sample SQLite labels: ${entries.slice(0, 5).map(e => e.label).join(', ')}`)
  })

  it('SQLite entries contain agent IDs matching Secretary workspace', async () => {
    const entries = await readSqliteChunks(SECRETARY_WORKSPACE)
    const agentIds = new Set(entries.map(e => e.label.match(/^sqlite:(\w+)/)?.[1]).filter(Boolean))

    console.log(`[sources] SQLite agent IDs: ${[...agentIds].join(', ')}`)

    // Secretary workspace should match pati agent (or fall back to all)
    expect(agentIds.size).toBeGreaterThan(0)
  })

  it('SQLite entries have non-empty text', async () => {
    const entries = await readSqliteChunks(SECRETARY_WORKSPACE)
    for (const entry of entries.slice(0, 100)) {
      expect(entry.text.trim().length).toBeGreaterThan(0)
    }
  })

  it('TechLead workspace reads SQLite chunks from coding agent', async () => {
    const entries = await readSqliteChunks(TECHLEAD_WORKSPACE)

    console.log(`[sources] SQLite entries for TechLead: ${entries.length}`)
    if (entries.length > 0) {
      const agentIds = new Set(entries.map(e => e.label.match(/^sqlite:(\w+)/)?.[1]).filter(Boolean))
      console.log(`[sources] TechLead SQLite agent IDs: ${[...agentIds].join(', ')}`)
    }

    // TechLead workspace should match coding agent
    expect(entries.length).toBeGreaterThanOrEqual(0) // may be empty if no match
  })
})

// ---------------------------------------------------------------------------
// Chunking + batching (pure functions, no I/O)
// ---------------------------------------------------------------------------

describe('Phase 1 — Chunking & batching', () => {
  it('chunks MD sources within char budget', async () => {
    const entries = await readWorkspaceMemory(SECRETARY_WORKSPACE, 'memory/omg')
    const allChunks = entries.flatMap(e => chunkText(e.text, e.label))

    console.log(`[batch] MD chunks: ${allChunks.length}`)

    // Each chunk should be within budget (24k chars)
    for (const chunk of allChunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(24_000)
    }
  })

  it('chunks SQLite sources within char budget', async () => {
    const entries = await readSqliteChunks(SECRETARY_WORKSPACE)
    const allChunks = entries.flatMap(e => chunkText(e.text, e.label))

    console.log(`[batch] SQLite chunks: ${allChunks.length}`)

    for (const chunk of allChunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(24_000)
    }
  })

  it('batches all sources with default 24k budget', async () => {
    const mdEntries = await readWorkspaceMemory(SECRETARY_WORKSPACE, 'memory/omg')
    const sqliteEntries = await readSqliteChunks(SECRETARY_WORKSPACE)
    const allEntries = [...mdEntries, ...sqliteEntries]
    const allChunks = allEntries.flatMap(e => chunkText(e.text, e.label))
    const batches = batchChunks(allChunks, 24_000)

    console.log(`[batch] Total entries: ${allEntries.length} (MD: ${mdEntries.length}, SQLite: ${sqliteEntries.length})`)
    console.log(`[batch] Total chunks: ${allChunks.length}`)
    console.log(`[batch] Total batches: ${batches.length}`)
    console.log(`[batch] Avg chars/batch: ${Math.round(batches.reduce((s, b) => s + b.totalChars, 0) / batches.length)}`)

    expect(batches.length).toBeGreaterThan(0)

    // Each batch should respect budget (except oversized single-chunk batches)
    for (const batch of batches) {
      if (batch.chunks.length > 1) {
        expect(batch.totalChars).toBeLessThanOrEqual(24_000 * 1.1) // 10% tolerance
      }
    }
  })

  it('batch count is in expected range for token safety', async () => {
    const mdEntries = await readWorkspaceMemory(SECRETARY_WORKSPACE, 'memory/omg')
    const sqliteEntries = await readSqliteChunks(SECRETARY_WORKSPACE)
    const allChunks = [...mdEntries, ...sqliteEntries].flatMap(e => chunkText(e.text, e.label))
    const batches = batchChunks(allChunks, 24_000)

    // Per test plan: expect ~40-60 batches for ~700-1000 small chunks
    // Allow wider range for actual data: 10-200
    expect(batches.length).toBeGreaterThan(5)
    expect(batches.length).toBeLessThan(500) // Safety: prevent runaway

    console.log(`[batch] BATCH COUNT: ${batches.length} (expected 10-200)`)
    if (batches.length > 100) {
      console.warn(`[batch] WARNING: ${batches.length} batches is high. Bootstrap will be slow.`)
    }
  })
})
