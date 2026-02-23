import { describe, it, expect, vi, beforeEach } from 'vitest'
import { vol } from 'memfs'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})
vi.mock('node:os', () => ({
  default: { homedir: () => '/home/user' },
  homedir: () => '/home/user',
}))

// Mock observer and graph modules
vi.mock('../../../src/observer/observer.js', () => ({
  runObservation: vi.fn(),
  EXTRACT_MAX_TOKENS: 4096,
}))
vi.mock('../../../src/graph/node-writer.js', () => ({
  writeObservationNode: vi.fn(),
  writeNowNode: vi.fn(),
}))
vi.mock('../../../src/graph/moc-manager.js', () => ({
  regenerateMoc: vi.fn(),
  applyMocUpdate: vi.fn(),
}))
vi.mock('../../../src/graph/registry.js', () => ({
  getNodeIndex: vi.fn().mockResolvedValue([]),
  getRegistryEntries: vi.fn().mockResolvedValue([]),
  getNodeFilePaths: vi.fn().mockResolvedValue(new Map()),
}))

import { runBootstrap } from '../../../src/bootstrap/bootstrap.js'
import { runObservation } from '../../../src/observer/observer.js'
import { writeObservationNode } from '../../../src/graph/node-writer.js'
import { parseConfig } from '../../../src/config.js'
import type { LlmClient } from '../../../src/llm/client.js'
import type { BootstrapState } from '../../../src/bootstrap/state.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config = parseConfig({})

const mockLlmClient: LlmClient = {
  generate: vi.fn().mockResolvedValue({
    content: '<observations><operations></operations><now-update>now</now-update></observations>',
    usage: { inputTokens: 10, outputTokens: 5 },
  }),
}

const EMPTY_OBSERVER_OUTPUT = {
  operations: [],
  nowUpdate: null,
  mocUpdates: [],
}

const OMG_ROOT = '/workspace/memory/omg'
const STATE_PATH = `${OMG_ROOT}/.bootstrap-state.json`
const LEGACY_PATH = `${OMG_ROOT}/.bootstrap-done`

function makeBootstrapParams(overrides = {}) {
  return {
    workspaceDir: '/workspace',
    config,
    llmClient: mockLlmClient,
    ...overrides,
  }
}

function makeCompletedState(overrides: Partial<BootstrapState> = {}): BootstrapState {
  return {
    version: 2,
    status: 'completed',
    startedAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    cursor: 0,
    total: 0,
    ok: 5,
    fail: 0,
    done: [],
    lastError: null,
    ...overrides,
  }
}

beforeEach(() => {
  vol.reset()
  vi.clearAllMocks()
  vi.mocked(runObservation).mockResolvedValue(EMPTY_OBSERVER_OUTPUT)
  vi.mocked(writeObservationNode).mockResolvedValue({
    frontmatter: {
      id: 'omg/fact/test',
      description: 'test',
      type: 'fact',
      priority: 'low',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    },
    body: 'test body',
    filePath: '/workspace/memory/omg/nodes/fact/fact-test.md',
  })
})

// ---------------------------------------------------------------------------
// State skip
// ---------------------------------------------------------------------------

describe('runBootstrap — state', () => {
  it('returns ran:false when state is completed and force is false', async () => {
    vol.fromJSON({
      [STATE_PATH]: JSON.stringify(makeCompletedState()),
    })

    const result = await runBootstrap(makeBootstrapParams())
    expect(result.ran).toBe(false)
    expect(result.chunksProcessed).toBe(0)
  })

  it('runs when force is true even if state is completed', async () => {
    vol.fromJSON({
      [STATE_PATH]: JSON.stringify(makeCompletedState()),
    })

    const result = await runBootstrap(makeBootstrapParams({ force: true }))
    expect(result.ran).toBe(true)
  })

  it('writes state file after completion', async () => {
    vol.fromJSON({ '/workspace/memory/omg/nodes/.keep': '' })

    const result = await runBootstrap(makeBootstrapParams())
    expect(result.ran).toBe(true)

    // State file should have been written
    expect(vol.existsSync(STATE_PATH)).toBe(true)

    const raw = vol.readFileSync(STATE_PATH, 'utf-8') as string
    const state = JSON.parse(raw) as BootstrapState
    expect(state.version).toBe(2)
    expect(state.status).toBe('completed')
  })

  it('returns ran:false for legacy sentinel (migrated to completed)', async () => {
    vol.fromJSON({
      [LEGACY_PATH]: JSON.stringify({
        completedAt: '2026-01-01T00:00:00Z',
        chunksProcessed: 5,
        chunksSucceeded: 5,
      }),
    })

    const result = await runBootstrap(makeBootstrapParams())
    expect(result.ran).toBe(false)

    // Migration should have written the new state file
    expect(vol.existsSync(STATE_PATH)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// No-content short circuit
// ---------------------------------------------------------------------------

describe('runBootstrap — no content', () => {
  it('returns ran:true with zero chunks when no sources have content', async () => {
    vol.fromJSON({ '/workspace/memory/omg/nodes/.keep': '' })

    const result = await runBootstrap(makeBootstrapParams())
    expect(result.ran).toBe(true)
    expect(result.chunksProcessed).toBe(0)
    expect(result.chunksSucceeded).toBe(0)
    expect(result.nodesWritten).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

describe('runBootstrap — source selection', () => {
  it('only reads memory when source=memory', async () => {
    vol.fromJSON({
      '/workspace/memory/MEMORY.md': '# Memory content that is long enough to process',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    await runBootstrap(makeBootstrapParams({ source: 'memory' }))
    // Just verify it ran without error
    expect(runObservation).toHaveBeenCalled()
  })

  it('skips memory when source=logs', async () => {
    vol.fromJSON({
      '/workspace/memory/MEMORY.md': '# Memory content',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    await runBootstrap(makeBootstrapParams({ source: 'logs' }))
    // No log files exist, so observer should not be called
    expect(runObservation).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Chunk processing
// ---------------------------------------------------------------------------

describe('runBootstrap — chunk processing', () => {
  it('calls runObservation once per batch (small chunks batched together)', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    await runBootstrap(makeBootstrapParams({ source: 'memory' }))
    // Default budget=24000, two small chunks (~30 chars each) fit in one batch
    expect(runObservation).toHaveBeenCalledTimes(1)
  })

  it('calls runObservation once per chunk when batchCharBudget=0', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })
    await runBootstrap(makeBootstrapParams({ config: noBatchConfig, source: 'memory' }))
    expect(runObservation).toHaveBeenCalledTimes(2)
  })

  it('counts nodes written from successful operations', async () => {
    vol.fromJSON({
      '/workspace/memory/file.md': '# File\n\nSome content to process.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    vi.mocked(runObservation).mockResolvedValueOnce({
      operations: [
        {
          kind: 'upsert',
          canonicalKey: 'facts.test',
          type: 'fact',
          title: 'Test Fact',
          description: 'test',
          body: 'test body',
          priority: 'low',
        },
      ],
      nowUpdate: null,
      mocUpdates: [],
    })

    const result = await runBootstrap(makeBootstrapParams({ source: 'memory' }))
    expect(result.nodesWritten).toBe(1)
    // chunksSucceeded counts all chunks in fulfilled (non-erroring) batches
    expect(result.chunksSucceeded).toBe(1)
  })

  it('counts chunks as succeeded even when batch produces zero nodes', async () => {
    vol.fromJSON({
      '/workspace/memory/file.md': '# File\n\nSome noise content.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    // EMPTY_OBSERVER_OUTPUT has 0 operations → 0 nodes written
    vi.mocked(runObservation).mockResolvedValueOnce(EMPTY_OBSERVER_OUTPUT)

    const result = await runBootstrap(makeBootstrapParams({ source: 'memory' }))
    expect(result.nodesWritten).toBe(0)
    // Batch fulfilled without error → chunks count as succeeded
    expect(result.chunksSucceeded).toBe(result.chunksProcessed)
  })

  it('handles LLM errors gracefully and continues processing other batches', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent.',
      '/workspace/memory/file2.md': '# File 2\n\nContent.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    // With batchCharBudget=0, each chunk is its own batch → 2 LLM calls
    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })

    vi.mocked(runObservation)
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockResolvedValueOnce(EMPTY_OBSERVER_OUTPUT)

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runBootstrap(makeBootstrapParams({ config: noBatchConfig, source: 'memory' }))
    expect(result.ran).toBe(true)
    // Both batches were attempted
    expect(runObservation).toHaveBeenCalledTimes(2)
    // Only the non-erroring batch counts its chunk as succeeded
    expect(result.chunksSucceeded).toBe(1)
    expect(result.chunksProcessed).toBe(2)

    consoleErrorSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

describe('runBootstrap — result shape', () => {
  it('returns correct shape with ran:true when bootstrap runs', async () => {
    vol.fromJSON({ '/workspace/memory/omg/nodes/.keep': '' })

    const result = await runBootstrap(makeBootstrapParams())
    expect(result).toMatchObject({
      ran: expect.any(Boolean),
      chunksProcessed: expect.any(Number),
      chunksSucceeded: expect.any(Number),
      nodesWritten: expect.any(Number),
    })
  })

  it('includes batchCount in result when bootstrap runs', async () => {
    vol.fromJSON({ '/workspace/memory/omg/nodes/.keep': '' })

    const result = await runBootstrap(makeBootstrapParams())
    expect(result.batchCount).toBeDefined()
    expect(typeof result.batchCount).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// Batch mode
// ---------------------------------------------------------------------------

describe('runBootstrap — batch mode', () => {
  it('batches multiple small chunks into fewer LLM calls', async () => {
    // Create 10 small files that fit within a single batch
    const files: Record<string, string> = {
      '/workspace/memory/omg/nodes/.keep': '',
    }
    for (let i = 0; i < 10; i++) {
      files[`/workspace/memory/file${i}.md`] = `# File ${i}\n\nContent for file ${i} to be processed.`
    }
    vol.fromJSON(files)

    await runBootstrap(makeBootstrapParams({ source: 'memory' }))

    // Default batchCharBudget=24000, each chunk is ~50 chars → all 10 fit in one batch
    const callCount = vi.mocked(runObservation).mock.calls.length
    expect(callCount).toBeLessThan(10)
    expect(callCount).toBeGreaterThan(0)
  })

  it('returns batchCount in result', async () => {
    vol.fromJSON({
      '/workspace/memory/file.md': '# File\n\nSome content to process.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const result = await runBootstrap(makeBootstrapParams({ source: 'memory' }))
    expect(result.batchCount).toBe(1)
  })

  it('passes maxOutputTokens to runObservation for multi-chunk batches', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent.',
      '/workspace/memory/file2.md': '# File 2\n\nContent.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    await runBootstrap(makeBootstrapParams({ source: 'memory' }))

    // Verify runObservation was called with maxOutputTokens
    const calls = vi.mocked(runObservation).mock.calls
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call[0].maxOutputTokens).toBeDefined()
      expect(typeof call[0].maxOutputTokens).toBe('number')
    }
  })

  it('with batchCharBudget=0, produces one LLM call per chunk (legacy behavior)', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/file3.md': '# File 3\n\nContent for file 3.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })
    await runBootstrap(makeBootstrapParams({ config: noBatchConfig, source: 'memory' }))

    expect(vi.mocked(runObservation).mock.calls.length).toBe(3)
  })

  it('deduplicates MOC domains across operations in a batch', async () => {
    vol.fromJSON({
      '/workspace/memory/file.md': '# File\n\nContent.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    vi.mocked(runObservation).mockResolvedValueOnce({
      operations: [],
      nowUpdate: null,
      // Duplicate domain entries — should be deduped
      mocUpdates: ['preferences', 'preferences', 'tools'],
    })

    // Should not throw
    await expect(runBootstrap(makeBootstrapParams({ source: 'memory' }))).resolves.toBeDefined()
  })

  it('writes now-node once per batch, not per chunk', async () => {
    const { writeNowNode } = await import('../../../src/graph/node-writer.js')

    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent.',
      '/workspace/memory/file2.md': '# File 2\n\nContent.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    vi.mocked(runObservation).mockResolvedValue({
      operations: [{
        kind: 'upsert',
        canonicalKey: 'facts.test',
        type: 'fact',
        title: 'Test',
        description: 'test',
        body: 'body',
        priority: 'low',
      }],
      nowUpdate: '## Current Focus\nBootstrap',
      mocUpdates: [],
    })

    await runBootstrap(makeBootstrapParams({ source: 'memory' }))

    // With default budget, both chunks should be in one batch → one now-node write
    const nowCalls = vi.mocked(writeNowNode).mock.calls.length
    expect(nowCalls).toBeLessThanOrEqual(vi.mocked(runObservation).mock.calls.length)
  })
})

// ---------------------------------------------------------------------------
// Resume from previous state
// ---------------------------------------------------------------------------

describe('runBootstrap — resume', () => {
  it('resumes from failed state, skipping already-done batches', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/file3.md': '# File 3\n\nContent for file 3.',
      '/workspace/memory/omg/nodes/.keep': '',
      // Pre-populate a failed state where batch 0 already completed
      [STATE_PATH]: JSON.stringify({
        version: 2,
        status: 'failed',
        startedAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        cursor: 1,
        total: 3,
        ok: 1,
        fail: 2,
        done: [0],
        lastError: 'batch observation failed',
      }),
    })

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })
    const result = await runBootstrap(makeBootstrapParams({ config: noBatchConfig, source: 'memory' }))

    expect(result.ran).toBe(true)
    // Only batches 1 and 2 should be processed (batch 0 already done)
    expect(runObservation).toHaveBeenCalledTimes(2)
  })

  it('resumes from stale running state', async () => {
    const staleTime = new Date(Date.now() - 10 * 60 * 1000).toISOString()

    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/omg/nodes/.keep': '',
      [STATE_PATH]: JSON.stringify({
        version: 2,
        status: 'running',
        startedAt: staleTime,
        updatedAt: staleTime,
        cursor: 1,
        total: 2,
        ok: 1,
        fail: 0,
        done: [0],
        lastError: null,
      }),
    })

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })
    const result = await runBootstrap(makeBootstrapParams({ config: noBatchConfig, source: 'memory' }))

    expect(result.ran).toBe(true)
    // Only batch 1 should run (batch 0 already done)
    expect(runObservation).toHaveBeenCalledTimes(1)
  })

  it('state file records completed status with progress', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    await runBootstrap(makeBootstrapParams({ source: 'memory' }))

    const raw = vol.readFileSync(STATE_PATH, 'utf-8') as string
    const state = JSON.parse(raw) as BootstrapState
    expect(state.status).toBe('completed')
    expect(state.version).toBe(2)
    // ok should reflect total chunks (both fit in one batch)
    expect(state.ok).toBeGreaterThan(0)
    // done is cleared after finalization
    expect(state.done).toEqual([])
  })

  it('tracks ok/fail counts correctly when one batch fails', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent.',
      '/workspace/memory/file2.md': '# File 2\n\nContent.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })

    vi.mocked(runObservation)
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockResolvedValueOnce(EMPTY_OBSERVER_OUTPUT)

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runBootstrap(makeBootstrapParams({ config: noBatchConfig, source: 'memory' }))

    // One batch succeeded (1 chunk), one failed (1 chunk)
    expect(result.chunksSucceeded).toBe(1)

    // Verify state file has correct counts
    const raw = vol.readFileSync(STATE_PATH, 'utf-8') as string
    const state = JSON.parse(raw) as BootstrapState
    expect(state.ok).toBe(1)
    expect(state.fail).toBe(1)
    // Still completed because ok > 0
    expect(state.status).toBe('completed')

    consoleErrorSpy.mockRestore()
  })
})
