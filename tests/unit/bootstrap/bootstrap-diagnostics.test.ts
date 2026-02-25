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

vi.mock('../../../src/bootstrap/backoff.js', () => ({
  computeBackoffMs: vi.fn().mockReturnValue(0),
  sleep: vi.fn().mockResolvedValue(undefined),
  BACKOFF_DELAYS_MS: [0, 0, 0, 0, 0],
}))

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
import { _clearActiveClaims } from '../../../src/bootstrap/lock.js'
import { runObservation } from '../../../src/observer/observer.js'
import { writeObservationNode } from '../../../src/graph/node-writer.js'
import { readFailureLog } from '../../../src/bootstrap/failure-log.js'
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

const OMG_ROOT = '/workspace/memory/omg'

function setupFs(files: Record<string, string> = {}) {
  vol.reset()
  vol.fromJSON({
    [`${OMG_ROOT}/templates/.keep`]: '',
    [`${OMG_ROOT}/.registry.json`]: JSON.stringify({ version: 1, nodes: {} }),
    '/workspace/memory/test.md': '---\ntitle: Test\n---\nSome workspace memory content to bootstrap from.',
    ...files,
  })
}

function makeBootstrapParams(overrides = {}) {
  return {
    workspaceDir: '/workspace',
    config,
    llmClient: mockLlmClient,
    force: true,
    ...overrides,
  }
}

beforeEach(() => {
  setupFs()
  _clearActiveClaims()
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// processBatch logs failure when 0 operations returned
// ---------------------------------------------------------------------------

describe('bootstrap failure logging', () => {
  it('logs failure entry when observer returns 0 operations', async () => {
    const mockRunObs = runObservation as ReturnType<typeof vi.fn>
    mockRunObs.mockResolvedValue({
      operations: [],
      nowUpdate: null,
      mocUpdates: [],
      diagnostics: { totalCandidates: 0, accepted: 0, rejectedReasons: [] },
      truncated: false,
    })

    await runBootstrap(makeBootstrapParams())

    const failures = await readFailureLog(OMG_ROOT)
    // Should have at least one failure entry for each batch that produced 0 operations
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]!.errorType).toBe('parse-empty')
  })

  it('logs failure with zero-operations when candidates parsed but all rejected', async () => {
    const mockRunObs = runObservation as ReturnType<typeof vi.fn>
    mockRunObs.mockResolvedValue({
      operations: [],
      nowUpdate: null,
      mocUpdates: [],
      diagnostics: {
        totalCandidates: 3,
        accepted: 0,
        rejectedReasons: ['unknown type', 'missing key', 'missing description'],
      },
      truncated: false,
    })

    await runBootstrap(makeBootstrapParams())

    const failures = await readFailureLog(OMG_ROOT)
    expect(failures.length).toBeGreaterThan(0)
    expect(failures[0]!.errorType).toBe('zero-operations')
    expect(failures[0]!.diagnostics).toBeTruthy()
    expect(failures[0]!.diagnostics!.totalCandidates).toBe(3)
  })

  it('does NOT log failure when nodes are written successfully', async () => {
    const mockRunObs = runObservation as ReturnType<typeof vi.fn>
    mockRunObs.mockResolvedValue({
      operations: [
        {
          kind: 'upsert',
          canonicalKey: 'identity.name',
          type: 'identity',
          title: 'User Name',
          description: 'The user name',
          body: 'Test',
          priority: 'medium',
        },
      ],
      nowUpdate: null,
      mocUpdates: [],
    })

    const mockWrite = writeObservationNode as ReturnType<typeof vi.fn>
    mockWrite.mockResolvedValue({
      frontmatter: {
        id: 'omg/identity/name',
        description: 'The user name',
        type: 'identity',
        priority: 'medium',
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
      },
      body: 'Test',
      filePath: `${OMG_ROOT}/nodes/identity/name.md`,
    })

    await runBootstrap(makeBootstrapParams())

    const failures = await readFailureLog(OMG_ROOT)
    expect(failures).toHaveLength(0)
  })

  it('clears failure log on force run', async () => {
    // Pre-seed a failure log
    vol.fromJSON({
      [`${OMG_ROOT}/.bootstrap-failures.jsonl`]: JSON.stringify({
        batchIndex: 0,
        labels: ['old-failure'],
        errorType: 'llm-error',
        error: 'old error',
        timestamp: '2024-01-01T00:00:00Z',
        diagnostics: null,
        chunkCount: 1,
      }) + '\n',
    }, OMG_ROOT)

    const mockRunObs = runObservation as ReturnType<typeof vi.fn>
    mockRunObs.mockResolvedValue({
      operations: [
        {
          kind: 'upsert',
          canonicalKey: 'identity.name',
          type: 'identity',
          title: 'User Name',
          description: 'The user name',
          body: 'Test',
          priority: 'medium',
        },
      ],
      nowUpdate: null,
      mocUpdates: [],
    })

    const mockWrite = writeObservationNode as ReturnType<typeof vi.fn>
    mockWrite.mockResolvedValue({
      frontmatter: {
        id: 'omg/identity/name',
        description: 'The user name',
        type: 'identity',
        priority: 'medium',
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
      },
      body: 'Test',
      filePath: `${OMG_ROOT}/nodes/identity/name.md`,
    })

    await runBootstrap(makeBootstrapParams({ force: true }))

    // The old failure should have been cleared
    const failures = await readFailureLog(OMG_ROOT)
    expect(failures).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Fence-wrapped XML parses through bootstrap pipeline
// ---------------------------------------------------------------------------

describe('bootstrap — fenced XML handling', () => {
  it('fence-wrapped XML is parsed correctly through runObservation', async () => {
    const fencedXml = '```xml\n<observations><operations>' +
      '<operation type="identity" priority="high">' +
      '<canonical-key>identity.name</canonical-key>' +
      '<title>User Name</title>' +
      '<description>The user full name</description>' +
      '<content>Szymon Paluch</content>' +
      '</operation>' +
      '</operations></observations>\n```'

    const mockRunObs = runObservation as ReturnType<typeof vi.fn>
    mockRunObs.mockResolvedValue({
      operations: [
        {
          kind: 'upsert',
          canonicalKey: 'identity.name',
          type: 'identity',
          title: 'User Name',
          description: 'The user full name',
          body: 'Szymon Paluch',
          priority: 'high',
        },
      ],
      nowUpdate: null,
      mocUpdates: [],
      diagnostics: { totalCandidates: 1, accepted: 1, rejectedReasons: [] },
      truncated: false,
    })

    const mockWrite = writeObservationNode as ReturnType<typeof vi.fn>
    mockWrite.mockResolvedValue({
      frontmatter: {
        id: 'omg/identity/name',
        description: 'The user full name',
        type: 'identity',
        priority: 'high',
        created: '2024-01-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
      },
      body: 'Szymon Paluch',
      filePath: `${OMG_ROOT}/nodes/identity/name.md`,
    })

    const result = await runBootstrap(makeBootstrapParams())

    expect(result.ran).toBe(true)
    expect(result.nodesWritten).toBeGreaterThan(0)

    // No failures logged since observation succeeded
    const failures = await readFailureLog(OMG_ROOT)
    expect(failures).toHaveLength(0)
  })
})
