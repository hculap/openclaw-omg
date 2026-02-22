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
}))
vi.mock('../../../src/graph/node-writer.js', () => ({
  writeObservationNode: vi.fn(),
  writeNowNode: vi.fn(),
}))
vi.mock('../../../src/graph/moc-manager.js', () => ({
  regenerateMoc: vi.fn(),
  applyMocUpdate: vi.fn(),
}))
vi.mock('../../../src/graph/node-reader.js', () => ({
  listAllNodes: vi.fn(),
}))

import { runBootstrap } from '../../../src/bootstrap/bootstrap.js'
import { runObservation } from '../../../src/observer/observer.js'
import { writeObservationNode } from '../../../src/graph/node-writer.js'
import { listAllNodes } from '../../../src/graph/node-reader.js'
import { parseConfig } from '../../../src/config.js'
import type { LlmClient } from '../../../src/llm/client.js'

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

function makeBootstrapParams(overrides = {}) {
  return {
    workspaceDir: '/workspace',
    config,
    llmClient: mockLlmClient,
    ...overrides,
  }
}

beforeEach(() => {
  vol.reset()
  vi.clearAllMocks()
  vi.mocked(runObservation).mockResolvedValue(EMPTY_OBSERVER_OUTPUT)
  vi.mocked(listAllNodes).mockResolvedValue([])
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
// Sentinel skip
// ---------------------------------------------------------------------------

describe('runBootstrap — sentinel', () => {
  it('returns ran:false when sentinel exists and force is false', async () => {
    vol.fromJSON({
      '/workspace/memory/omg/.bootstrap-done': JSON.stringify({
        completedAt: '2026-01-01T00:00:00Z',
        chunksProcessed: 5,
        chunksSucceeded: 5,
      }),
    })

    const result = await runBootstrap(makeBootstrapParams())
    expect(result.ran).toBe(false)
    expect(result.chunksProcessed).toBe(0)
  })

  it('runs when force is true even if sentinel exists', async () => {
    vol.fromJSON({
      '/workspace/memory/omg/.bootstrap-done': JSON.stringify({
        completedAt: '2026-01-01T00:00:00Z',
        chunksProcessed: 5,
        chunksSucceeded: 5,
      }),
    })

    const result = await runBootstrap(makeBootstrapParams({ force: true }))
    expect(result.ran).toBe(true)
  })

  it('writes sentinel file after completion', async () => {
    vol.fromJSON({ '/workspace/memory/omg/nodes/.keep': '' })

    const result = await runBootstrap(makeBootstrapParams())
    expect(result.ran).toBe(true)

    // Sentinel should have been written
    const sentinelExists = vol.existsSync('/workspace/memory/omg/.bootstrap-done')
    expect(sentinelExists).toBe(true)
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
  it('calls runObservation for each chunk', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent for file 1.',
      '/workspace/memory/file2.md': '# File 2\n\nContent for file 2.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    await runBootstrap(makeBootstrapParams({ source: 'memory' }))
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
          kind: 'create',
          frontmatter: {
            id: 'omg/fact/test',
            description: 'test',
            type: 'fact',
            priority: 'low',
            created: '2026-01-01T00:00:00Z',
            updated: '2026-01-01T00:00:00Z',
          },
          body: 'test body',
        },
      ],
      nowUpdate: null,
      mocUpdates: [],
    })

    const result = await runBootstrap(makeBootstrapParams({ source: 'memory' }))
    expect(result.nodesWritten).toBe(1)
    expect(result.chunksSucceeded).toBe(1)
  })

  it('handles LLM errors gracefully and continues processing other chunks', async () => {
    vol.fromJSON({
      '/workspace/memory/file1.md': '# File 1\n\nContent.',
      '/workspace/memory/file2.md': '# File 2\n\nContent.',
      '/workspace/memory/omg/nodes/.keep': '',
    })

    vi.mocked(runObservation)
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockResolvedValueOnce(EMPTY_OBSERVER_OUTPUT)

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await runBootstrap(makeBootstrapParams({ source: 'memory' }))
    expect(result.ran).toBe(true)
    // Both chunks were attempted
    expect(runObservation).toHaveBeenCalledTimes(2)

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
})
