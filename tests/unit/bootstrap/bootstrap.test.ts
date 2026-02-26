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

// Make backoff delays instant so rate-limit tests don't slow the suite
vi.mock('../../../src/bootstrap/backoff.js', () => ({
  computeBackoffMs: vi.fn().mockReturnValue(0),
  sleep: vi.fn().mockResolvedValue(undefined),
  BACKOFF_DELAYS_MS: [0, 0, 0, 0, 0],
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

import { runBootstrap, runBootstrapTick, runBootstrapRetry } from '../../../src/bootstrap/bootstrap.js'
import { _clearActiveClaims } from '../../../src/bootstrap/lock.js'
import { runObservation } from '../../../src/observer/observer.js'
import { writeObservationNode } from '../../../src/graph/node-writer.js'
import { parseConfig } from '../../../src/config.js'
import { parseBatchIndices } from '../../../src/plugin.js'
import type { LlmClient } from '../../../src/llm/client.js'
import type { BootstrapState } from '../../../src/bootstrap/state.js'
import type { BootstrapFailureEntry } from '../../../src/bootstrap/failure-log.js'

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
const FAILURE_LOG_PATH = `${OMG_ROOT}/.bootstrap-failures.jsonl`

function makeBootstrapParams(overrides = {}) {
  return {
    workspaceDir: '/workspace',
    config,
    llmClient: mockLlmClient,
    ...overrides,
  }
}

function makeRetryParams(overrides = {}) {
  return {
    workspaceDir: '/workspace',
    config,
    llmClient: mockLlmClient,
    ...overrides,
  }
}

function makeFailureEntry(overrides: Partial<BootstrapFailureEntry> = {}): BootstrapFailureEntry {
  return {
    batchIndex: 0,
    labels: ['test-chunk'],
    errorType: 'llm-error',
    error: 'LLM timeout',
    timestamp: '2026-01-01T00:00:00Z',
    diagnostics: null,
    chunkCount: 1,
    ...overrides,
  }
}

function writeFailureLog(entries: readonly BootstrapFailureEntry[]): string {
  return entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '')
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
    maintenanceDone: false,
    ...overrides,
  }
}

beforeEach(() => {
  vol.reset()
  vi.clearAllMocks()
  _clearActiveClaims()
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

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

describe('runBootstrap — locking', () => {
  it('returns ran:false without processing when another process holds the lock', async () => {
    const LOCK_PATH = `${OMG_ROOT}/.bootstrap-lock`
    const now = new Date().toISOString()
    vol.fromJSON({
      [LOCK_PATH]: JSON.stringify({
        pid: 99999,
        token: '00000000-0000-0000-0000-000000000099',
        startedAt: now,
        updatedAt: now,
      }),
      '/workspace/memory/omg/nodes/.keep': '',
    })

    // Foreign PID is alive — lock should not be stolen
    vi.spyOn(process, 'kill').mockImplementation(() => true as never)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runBootstrap(makeBootstrapParams())

    expect(result.ran).toBe(false)
    expect(result.chunksProcessed).toBe(0)
    expect(runObservation).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Rate limit handling
// ---------------------------------------------------------------------------

describe('runBootstrap — rate limit handling', () => {
  it('retries on RateLimitError and succeeds on next attempt', async () => {
    vol.fromJSON({
      '/workspace/memory/file.md': '# File\n\nSome content to process.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const { RateLimitError } = await import('../../../src/llm/errors.js')
    vi.mocked(runObservation)
      .mockRejectedValueOnce(new RateLimitError('rate limit'))
      .mockResolvedValueOnce(EMPTY_OBSERVER_OUTPUT)

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runBootstrap(makeBootstrapParams({ source: 'memory' }))

    expect(result.ran).toBe(true)
    // Initial attempt + 1 retry
    expect(runObservation).toHaveBeenCalledTimes(2)

    consoleErrorSpy.mockRestore()
  })

  it('awaits backoff sleep between rate-limit retries', async () => {
    vol.fromJSON({
      '/workspace/memory/file.md': '# File\n\nSome content.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const { RateLimitError } = await import('../../../src/llm/errors.js')
    const { sleep } = await import('../../../src/bootstrap/backoff.js')

    vi.mocked(runObservation)
      .mockRejectedValueOnce(new RateLimitError('rate limit'))
      .mockResolvedValueOnce(EMPTY_OBSERVER_OUTPUT)

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runBootstrap(makeBootstrapParams({ source: 'memory' }))

    // Sleep should have been called once for the one rate-limit backoff
    expect(sleep).toHaveBeenCalledTimes(1)

    consoleErrorSpy.mockRestore()
  })

  it('aborts pipeline after MAX_CONSECUTIVE rate limits and persists failed state', async () => {
    vol.fromJSON({
      '/workspace/memory/file.md': '# File\n\nSome content.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const { RateLimitError } = await import('../../../src/llm/errors.js')
    // Always fail with rate limit
    vi.mocked(runObservation).mockRejectedValue(new RateLimitError('rate limit'))

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runBootstrap(makeBootstrapParams({ source: 'memory' }))

    expect(result.ran).toBe(true)

    // State file should be 'failed'
    const raw = vol.readFileSync(STATE_PATH, 'utf-8') as string
    const state = JSON.parse(raw) as BootstrapState
    expect(state.status).toBe('failed')
    expect(state.lastError).toContain('Rate limit')

    consoleErrorSpy.mockRestore()
  })

  it('non-rate-limit errors still skip batch without retry (existing behavior)', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent.',
      '/workspace/memory/file2.md': '# File 2\n\nContent.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })

    vi.mocked(runObservation)
      .mockRejectedValueOnce(new Error('LLM connection timeout'))
      .mockResolvedValueOnce(EMPTY_OBSERVER_OUTPUT)

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runBootstrap(makeBootstrapParams({ config: noBatchConfig, source: 'memory' }))

    // No retry for non-rate-limit errors — exactly 2 calls (one per batch)
    expect(runObservation).toHaveBeenCalledTimes(2)
    expect(result.chunksSucceeded).toBe(1)
    expect(result.chunksProcessed).toBe(2)

    consoleErrorSpy.mockRestore()
  })

  it('abandons batch after exactly MAX_RETRY_ATTEMPTS retries (per-batch boundary)', async () => {
    vol.fromJSON({
      '/workspace/memory/file.md': '# File\n\nContent.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const { RateLimitError } = await import('../../../src/llm/errors.js')
    const { MAX_RETRY_ATTEMPTS } = await import('../../../src/bootstrap/rate-limit-breaker.js')

    // Always rate-limit so we can count attempts
    vi.mocked(runObservation).mockRejectedValue(new RateLimitError('rate limit'))

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await runBootstrap(makeBootstrapParams({ source: 'memory' }))

    // 1 initial + MAX_RETRY_ATTEMPTS retries = MAX_RETRY_ATTEMPTS + 1 total calls
    // (pipeline aborts when breaker threshold is reached, which may cap calls earlier)
    expect(runObservation).toHaveBeenCalled()
    // Key assertion: never more than MAX_RETRY_ATTEMPTS + 1 calls for a single batch
    expect(vi.mocked(runObservation).mock.calls.length).toBeLessThanOrEqual(MAX_RETRY_ATTEMPTS + 1)

    consoleErrorSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// runBootstrapTick — bounded, resumable
// ---------------------------------------------------------------------------

describe('runBootstrapTick', () => {
  it('returns correct shape with ran and completed fields', async () => {
    vol.fromJSON({ '/workspace/memory/omg/nodes/.keep': '' })

    const result = await runBootstrapTick(makeBootstrapParams())
    expect(result).toMatchObject({
      ran: expect.any(Boolean),
      batchesProcessed: expect.any(Number),
      chunksSucceeded: expect.any(Number),
      nodesWritten: expect.any(Number),
      moreWorkRemains: expect.any(Boolean),
      completed: expect.any(Boolean),
    })
  })

  it('returns ran:false when state is completed', async () => {
    vol.fromJSON({
      [STATE_PATH]: JSON.stringify(makeCompletedState()),
    })

    const result = await runBootstrapTick(makeBootstrapParams())
    expect(result.ran).toBe(false)
    expect(result.completed).toBe(false)
    expect(result.moreWorkRemains).toBe(false)
  })

  it('processes only batchBudgetPerRun batches when more exist', async () => {
    // Create enough files to produce multiple batches (one per chunk with budget=0)
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/file3.md': '# File 3\n\nContent for file 3.',
      '/workspace/memory/file4.md': '# File 4\n\nContent for file 4.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    // batchCharBudget=0 → each chunk is its own batch → 4 batches
    // batchBudgetPerRun=2 → only process 2 batches per tick
    const tickConfig = parseConfig({
      bootstrap: { batchCharBudget: 0, batchBudgetPerRun: 2 },
    })

    const result = await runBootstrapTick(makeBootstrapParams({ config: tickConfig, source: 'memory' }))

    expect(result.ran).toBe(true)
    expect(result.batchesProcessed).toBe(2)
    expect(result.moreWorkRemains).toBe(true)
    expect(result.completed).toBe(false)
    expect(runObservation).toHaveBeenCalledTimes(2)
  })

  it('sets state to paused when budget is exhausted with remaining work', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/file3.md': '# File 3\n\nContent for file 3.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const tickConfig = parseConfig({
      bootstrap: { batchCharBudget: 0, batchBudgetPerRun: 1 },
    })

    await runBootstrapTick(makeBootstrapParams({ config: tickConfig, source: 'memory' }))

    const raw = vol.readFileSync(STATE_PATH, 'utf-8') as string
    const state = JSON.parse(raw) as BootstrapState
    expect(state.status).toBe('paused')
  })

  it('sets state to completed when all batches are processed within budget', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const tickConfig = parseConfig({
      bootstrap: { batchCharBudget: 0, batchBudgetPerRun: 20 },
    })

    const result = await runBootstrapTick(makeBootstrapParams({ config: tickConfig, source: 'memory' }))

    expect(result.ran).toBe(true)
    expect(result.completed).toBe(true)
    expect(result.moreWorkRemains).toBe(false)

    const raw = vol.readFileSync(STATE_PATH, 'utf-8') as string
    const state = JSON.parse(raw) as BootstrapState
    expect(state.status).toBe('completed')
  })

  it('resumes from paused state on subsequent tick', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/file3.md': '# File 3\n\nContent for file 3.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    const tickConfig = parseConfig({
      bootstrap: { batchCharBudget: 0, batchBudgetPerRun: 1 },
    })

    // Tick 1: process 1 batch → paused
    await runBootstrapTick(makeBootstrapParams({ config: tickConfig, source: 'memory' }))
    _clearActiveClaims()
    vi.clearAllMocks()
    vi.mocked(runObservation).mockResolvedValue(EMPTY_OBSERVER_OUTPUT)

    // Tick 2: process 1 more batch → still paused (3 total, 2 done)
    const result2 = await runBootstrapTick(makeBootstrapParams({ config: tickConfig, source: 'memory' }))
    expect(result2.ran).toBe(true)
    expect(result2.batchesProcessed).toBe(1)
    expect(runObservation).toHaveBeenCalledTimes(1)
    _clearActiveClaims()
    vi.clearAllMocks()
    vi.mocked(runObservation).mockResolvedValue(EMPTY_OBSERVER_OUTPUT)

    // Tick 3: process last batch → completed
    const result3 = await runBootstrapTick(makeBootstrapParams({ config: tickConfig, source: 'memory' }))
    expect(result3.ran).toBe(true)
    expect(result3.completed).toBe(true)
    expect(result3.moreWorkRemains).toBe(false)
  })

  it('returns completed when no sources have content', async () => {
    vol.fromJSON({ '/workspace/memory/omg/nodes/.keep': '' })

    const result = await runBootstrapTick(makeBootstrapParams())
    expect(result.ran).toBe(true)
    expect(result.completed).toBe(true)
    expect(result.batchesProcessed).toBe(0)
  })

  it('uses default batchBudgetPerRun=20 when not configured', async () => {
    vol.fromJSON({
      '/workspace/memory/file.md': '# File\n\nContent.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    // Default config has batchBudgetPerRun=20, which is more than 1 batch
    const result = await runBootstrapTick(makeBootstrapParams({ source: 'memory' }))
    expect(result.ran).toBe(true)
    expect(result.completed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// runBootstrap — unchanged behavior (full run, no maxBatches)
// ---------------------------------------------------------------------------

describe('runBootstrap — still processes all batches (no budget limit)', () => {
  it('processes all batches regardless of batchBudgetPerRun config', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/file3.md': '# File 3\n\nContent for file 3.',
      '/workspace/memory/file4.md': '# File 4\n\nContent for file 4.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    // batchBudgetPerRun=1 should NOT limit runBootstrap (only runBootstrapTick)
    const fullConfig = parseConfig({
      bootstrap: { batchCharBudget: 0, batchBudgetPerRun: 1 },
    })

    const result = await runBootstrap(makeBootstrapParams({ config: fullConfig, source: 'memory' }))
    expect(result.ran).toBe(true)
    expect(runObservation).toHaveBeenCalledTimes(4)

    const raw = vol.readFileSync(STATE_PATH, 'utf-8') as string
    const state = JSON.parse(raw) as BootstrapState
    expect(state.status).toBe('completed')
  })
})

// ---------------------------------------------------------------------------
// runBootstrapRetry — filtering & timeout
// ---------------------------------------------------------------------------

describe('runBootstrapRetry — error-type filtering', () => {
  it('retries only llm-error failures, preserving parse-empty entries', async () => {
    const llmFailure = makeFailureEntry({ batchIndex: 0, errorType: 'llm-error', error: 'timeout' })
    const parseFailure = makeFailureEntry({ batchIndex: 1, errorType: 'parse-empty', error: 'no ops' })

    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/omg/nodes/.keep': '',
      [STATE_PATH]: JSON.stringify(makeCompletedState()),
      [FAILURE_LOG_PATH]: writeFailureLog([llmFailure, parseFailure]),
    })

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })
    const result = await runBootstrapRetry(makeRetryParams({
      config: noBatchConfig,
      errorTypeFilter: 'llm-error' as const,
    }))

    expect(result.ran).toBe(true)
    expect(result.retriedCount).toBe(1)

    // Read back failure log — parse-empty entry should be preserved
    const remaining = vol.readFileSync(FAILURE_LOG_PATH, 'utf-8') as string
    const lines = remaining.trim().split('\n').filter((l) => l.trim() !== '')
    // At minimum the parse-empty entry is preserved; the llm-error entry
    // may or may not be re-appended depending on LLM success
    const preserved = lines.map((l) => JSON.parse(l) as BootstrapFailureEntry)
    expect(preserved.some((f) => f.errorType === 'parse-empty' && f.batchIndex === 1)).toBe(true)
  })
})

describe('runBootstrapRetry — batch-index filtering', () => {
  it('retries only specified batch indices', async () => {
    const failure0 = makeFailureEntry({ batchIndex: 0, errorType: 'llm-error' })
    const failure1 = makeFailureEntry({ batchIndex: 1, errorType: 'llm-error' })
    const failure2 = makeFailureEntry({ batchIndex: 2, errorType: 'llm-error' })

    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/file3.md': '# File 3\n\nContent for file 3.',
      '/workspace/memory/omg/nodes/.keep': '',
      [STATE_PATH]: JSON.stringify(makeCompletedState()),
      [FAILURE_LOG_PATH]: writeFailureLog([failure0, failure1, failure2]),
    })

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })
    const result = await runBootstrapRetry(makeRetryParams({
      config: noBatchConfig,
      batchIndices: [0, 2],
    }))

    expect(result.ran).toBe(true)
    // Only batches 0 and 2 retried
    expect(result.retriedBatchIndices).toBeDefined()
    expect(result.retriedBatchIndices).toContain(0)
    expect(result.retriedBatchIndices).toContain(2)
    expect(result.retriedBatchIndices).not.toContain(1)

    // Failure log should preserve batch 1 entry
    const remaining = vol.readFileSync(FAILURE_LOG_PATH, 'utf-8') as string
    const lines = remaining.trim().split('\n').filter((l) => l.trim() !== '')
    const preserved = lines.map((l) => JSON.parse(l) as BootstrapFailureEntry)
    expect(preserved.some((f) => f.batchIndex === 1)).toBe(true)
  })
})

describe('runBootstrapRetry — combined filters', () => {
  it('applies both error-type and batch-index filters', async () => {
    const failure0 = makeFailureEntry({ batchIndex: 0, errorType: 'llm-error' })
    const failure1 = makeFailureEntry({ batchIndex: 1, errorType: 'parse-empty' })
    const failure2 = makeFailureEntry({ batchIndex: 2, errorType: 'llm-error' })

    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/file3.md': '# File 3\n\nContent for file 3.',
      '/workspace/memory/omg/nodes/.keep': '',
      [STATE_PATH]: JSON.stringify(makeCompletedState()),
      [FAILURE_LOG_PATH]: writeFailureLog([failure0, failure1, failure2]),
    })

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })
    const result = await runBootstrapRetry(makeRetryParams({
      config: noBatchConfig,
      errorTypeFilter: 'llm-error' as const,
      batchIndices: [2],
    }))

    expect(result.ran).toBe(true)
    // Only batch 2 (llm-error AND in batchIndices) gets retried
    expect(result.retriedBatchIndices).toEqual([2])
  })
})

describe('runBootstrapRetry — no-match batch indices', () => {
  it('returns ran:false when batch indices do not match any failures', async () => {
    const failure0 = makeFailureEntry({ batchIndex: 0, errorType: 'llm-error' })

    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/omg/nodes/.keep': '',
      [STATE_PATH]: JSON.stringify(makeCompletedState()),
      [FAILURE_LOG_PATH]: writeFailureLog([failure0]),
    })

    const result = await runBootstrapRetry(makeRetryParams({
      batchIndices: [99, 100],
    }))

    expect(result.ran).toBe(false)
    expect(result.retriedCount).toBe(0)
    // Original failures are still counted
    expect(result.stillFailedCount).toBe(1)
  })
})

describe('runBootstrapRetry — timeout override', () => {
  it('calls factory with correct timeout when timeoutMs and factory are provided', async () => {
    const failure0 = makeFailureEntry({ batchIndex: 0, errorType: 'llm-error' })

    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/omg/nodes/.keep': '',
      [STATE_PATH]: JSON.stringify(makeCompletedState()),
      [FAILURE_LOG_PATH]: writeFailureLog([failure0]),
    })

    const factoryClient: LlmClient = {
      generate: vi.fn().mockResolvedValue({
        content: '<observations><operations></operations><now-update>now</now-update></observations>',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    }
    const factory = vi.fn().mockReturnValue(factoryClient)

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })
    await runBootstrapRetry(makeRetryParams({
      config: noBatchConfig,
      timeoutMs: 300_000,
      createLlmClientWithTimeout: factory,
    }))

    expect(factory).toHaveBeenCalledWith(300_000)
  })

  it('warns and uses default client when timeoutMs provided without factory', async () => {
    const failure0 = makeFailureEntry({ batchIndex: 0, errorType: 'llm-error' })

    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/omg/nodes/.keep': '',
      [STATE_PATH]: JSON.stringify(makeCompletedState()),
      [FAILURE_LOG_PATH]: writeFailureLog([failure0]),
    })

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })
    const result = await runBootstrapRetry(makeRetryParams({
      config: noBatchConfig,
      timeoutMs: 300_000,
      // no createLlmClientWithTimeout
    }))

    expect(result.ran).toBe(true)
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('timeoutMs specified but no createLlmClientWithTimeout factory provided')
    )

    consoleWarnSpy.mockRestore()
  })
})

describe('runBootstrapRetry — selective failure log preservation', () => {
  it('preserves entries for batches not being retried', async () => {
    const failure0 = makeFailureEntry({ batchIndex: 0, errorType: 'llm-error' })
    const failure1 = makeFailureEntry({ batchIndex: 1, errorType: 'parse-empty', error: 'low signal' })
    const failure2 = makeFailureEntry({ batchIndex: 2, errorType: 'zero-operations', error: 'rejected' })

    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/file3.md': '# File 3\n\nContent for file 3.',
      '/workspace/memory/omg/nodes/.keep': '',
      [STATE_PATH]: JSON.stringify(makeCompletedState()),
      [FAILURE_LOG_PATH]: writeFailureLog([failure0, failure1, failure2]),
    })

    const noBatchConfig = parseConfig({ bootstrap: { batchCharBudget: 0 } })
    await runBootstrapRetry(makeRetryParams({
      config: noBatchConfig,
      errorTypeFilter: 'llm-error' as const,
    }))

    // After retry, parse-empty and zero-operations entries should be preserved
    const remaining = vol.readFileSync(FAILURE_LOG_PATH, 'utf-8') as string
    const lines = remaining.trim().split('\n').filter((l) => l.trim() !== '')
    const preserved = lines.map((l) => JSON.parse(l) as BootstrapFailureEntry)

    // Batch 1 (parse-empty) and batch 2 (zero-operations) must be preserved
    expect(preserved.some((f) => f.batchIndex === 1 && f.errorType === 'parse-empty')).toBe(true)
    expect(preserved.some((f) => f.batchIndex === 2 && f.errorType === 'zero-operations')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseBatchIndices
// ---------------------------------------------------------------------------

describe('parseBatchIndices', () => {
  it('parses valid comma-separated indices', () => {
    expect(parseBatchIndices('6,12,25')).toEqual([6, 12, 25])
  })

  it('handles whitespace around indices', () => {
    expect(parseBatchIndices(' 6 , 12 , 25 ')).toEqual([6, 12, 25])
  })

  it('throws on non-integer values', () => {
    expect(() => parseBatchIndices('6,abc,25')).toThrow('Invalid batch index "abc"')
  })

  it('throws on negative values', () => {
    expect(() => parseBatchIndices('6,-1,25')).toThrow('Invalid batch index "-1"')
  })

  it('throws on floating-point values', () => {
    expect(() => parseBatchIndices('6,1.5,25')).toThrow('Invalid batch index "1.5"')
  })

  it('returns empty array for empty string', () => {
    expect(parseBatchIndices('')).toEqual([])
  })

  it('handles single index', () => {
    expect(parseBatchIndices('42')).toEqual([42])
  })
})
