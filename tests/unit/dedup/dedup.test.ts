/**
 * Tests for the main dedup orchestrator (runDedup).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { vol } from 'memfs'
import { clearRegistryCache } from '../../../src/graph/registry.js'
import { parseConfig } from '../../../src/config.js'
import type { LlmClient } from '../../../src/llm/client.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

const OMG_ROOT = '/workspace/memory/omg'

function makeMockLlm(responseJson?: string): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content: responseJson ?? JSON.stringify({ mergePlans: [] }),
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  }
}

function makeConfig(overrides = {}) {
  return parseConfig({
    dedup: {
      similarityThreshold: 0.3, // low threshold so test nodes get clustered
      maxClustersPerRun: 30,
      maxClusterSize: 8,
      ...overrides,
    },
    injection: { maxContextTokens: 4_000 },
  })
}

// Two nodes with similar canonical keys + descriptions that should cluster.
// IDs must match NODE_ID_RE: ^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$
const NODE_A_CONTENT = `---
id: omg/preference.dark-mode
description: User prefers dark mode interface
type: preference
priority: medium
created: 2024-01-01T00:00:00Z
updated: 2024-06-01T00:00:00Z
canonicalKey: preferences.dark_mode
---
User has expressed preference for dark mode.`

const NODE_B_CONTENT = `---
id: omg/preference.dark-theme
description: User prefers dark theme interface
type: preference
priority: medium
created: 2024-01-01T00:00:00Z
updated: 2024-06-02T00:00:00Z
canonicalKey: preferences.dark_theme
---
User prefers dark theme in their editor.`

beforeEach(() => {
  vol.reset()
  clearRegistryCache()
  vol.fromJSON({ [`${OMG_ROOT}/.keep`]: '' })
})

// ---------------------------------------------------------------------------
// Early exit — no candidates
// ---------------------------------------------------------------------------

describe('runDedup — early exit when no clusters', () => {
  it('returns zero metrics when registry is empty', async () => {
    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const result = await runDedup({ omgRoot: OMG_ROOT, config: makeConfig(), llmClient: makeMockLlm() })

    expect(result.clustersProcessed).toBe(0)
    expect(result.mergesExecuted).toBe(0)
    expect(result.nodesArchived).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('does not call LLM when no clusters found', async () => {
    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const llm = makeMockLlm()
    await runDedup({ omgRoot: OMG_ROOT, config: makeConfig(), llmClient: llm })

    expect(llm.generate).not.toHaveBeenCalled()
  })

  it('returns zero metrics with one node (no pairs possible)', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
    })

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const result = await runDedup({ omgRoot: OMG_ROOT, config: makeConfig(), llmClient: makeMockLlm() })

    expect(result.clustersProcessed).toBe(0)
    expect(result.mergesExecuted).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// LLM call with no merge plans
// ---------------------------------------------------------------------------

describe('runDedup — LLM returns no merge plans', () => {
  it('calls LLM when clusters are found', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
      [`${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`]: NODE_B_CONTENT,
    })

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const llm = makeMockLlm(JSON.stringify({ mergePlans: [] }))
    await runDedup({ omgRoot: OMG_ROOT, config: makeConfig(), llmClient: llm })

    expect(llm.generate).toHaveBeenCalledOnce()
  })

  it('returns zero merges when LLM finds no duplicates', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
      [`${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`]: NODE_B_CONTENT,
    })

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const result = await runDedup({
      omgRoot: OMG_ROOT,
      config: makeConfig(),
      llmClient: makeMockLlm(JSON.stringify({ mergePlans: [] })),
    })

    expect(result.mergesExecuted).toBe(0)
    expect(result.nodesArchived).toBe(0)
  })

  it('updates lastDedupAt even when no merges happen', async () => {
    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const { loadDedupState } = await import('../../../src/dedup/state.js')

    const before = await loadDedupState(OMG_ROOT)
    expect(before.lastDedupAt).toBeNull()

    await runDedup({ omgRoot: OMG_ROOT, config: makeConfig(), llmClient: makeMockLlm() })

    const after = await loadDedupState(OMG_ROOT)
    expect(after.lastDedupAt).not.toBeNull()
    expect(after.runsCompleted).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Merge execution
// ---------------------------------------------------------------------------

describe('runDedup — merge execution', () => {
  it('executes merges when LLM returns valid merge plans', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
      [`${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`]: NODE_B_CONTENT,
    })

    const mergePlan = {
      keepNodeId: 'omg/preference.dark-mode',
      keepUid: '',
      mergeNodeIds: ['omg/preference.dark-theme'],
      mergeUids: [],
      aliasKeys: ['preferences.dark_theme'],
      conflicts: [],
      patch: { tags: ['dark', 'theme'], description: 'User prefers dark mode interface' },
    }

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const result = await runDedup({
      omgRoot: OMG_ROOT,
      config: makeConfig(),
      llmClient: makeMockLlm(JSON.stringify({ mergePlans: [mergePlan] })),
    })

    expect(result.mergesExecuted).toBe(1)
    expect(result.nodesArchived).toBe(1)
  })

  it('archives loser nodes when merging', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
      [`${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`]: NODE_B_CONTENT,
    })

    const mergePlan = {
      keepNodeId: 'omg/preference.dark-mode',
      keepUid: '',
      mergeNodeIds: ['omg/preference.dark-theme'],
      mergeUids: [],
      aliasKeys: ['preferences.dark_theme'],
      conflicts: [],
      patch: {},
    }

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    await runDedup({
      omgRoot: OMG_ROOT,
      config: makeConfig(),
      llmClient: makeMockLlm(JSON.stringify({ mergePlans: [mergePlan] })),
    })

    const { promises: fs } = await import('node:fs')
    const loserContent = await fs.readFile(
      `${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`,
      'utf-8'
    )
    expect(loserContent).toContain('archived: true')
    expect(loserContent).toContain('mergedInto: omg/preference.dark-mode')
  })

  it('appends audit entry for each merge', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
      [`${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`]: NODE_B_CONTENT,
    })

    const mergePlan = {
      keepNodeId: 'omg/preference.dark-mode',
      keepUid: '',
      mergeNodeIds: ['omg/preference.dark-theme'],
      mergeUids: [],
      aliasKeys: [],
      conflicts: [],
      patch: {},
    }

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    await runDedup({
      omgRoot: OMG_ROOT,
      config: makeConfig(),
      llmClient: makeMockLlm(JSON.stringify({ mergePlans: [mergePlan] })),
    })

    const { readAuditLog } = await import('../../../src/dedup/audit.js')
    const log = await readAuditLog(OMG_ROOT)
    expect(log).toHaveLength(1)
    expect(log[0]?.keepNodeId).toBe('omg/preference.dark-mode')
    expect(log[0]?.mergedNodeIds).toContain('omg/preference.dark-theme')
  })

  it('increments totalMerges in state', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
      [`${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`]: NODE_B_CONTENT,
    })

    const mergePlan = {
      keepNodeId: 'omg/preference.dark-mode',
      keepUid: '',
      mergeNodeIds: ['omg/preference.dark-theme'],
      mergeUids: [],
      aliasKeys: [],
      conflicts: [],
      patch: {},
    }

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    await runDedup({
      omgRoot: OMG_ROOT,
      config: makeConfig(),
      llmClient: makeMockLlm(JSON.stringify({ mergePlans: [mergePlan] })),
    })

    const { loadDedupState } = await import('../../../src/dedup/state.js')
    const state = await loadDedupState(OMG_ROOT)
    expect(state.totalMerges).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Fail closed on LLM error
// ---------------------------------------------------------------------------

describe('runDedup — fail closed on LLM error', () => {
  it('does not update lastDedupAt when LLM call fails', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
      [`${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`]: NODE_B_CONTENT,
    })

    const failingLlm: LlmClient = {
      generate: vi.fn().mockRejectedValue(new Error('LLM timeout')),
    }

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const result = await runDedup({ omgRoot: OMG_ROOT, config: makeConfig(), llmClient: failingLlm })

    expect(result.mergesExecuted).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)

    const { loadDedupState } = await import('../../../src/dedup/state.js')
    const state = await loadDedupState(OMG_ROOT)
    // lastDedupAt should NOT advance on LLM failure (fail closed)
    expect(state.lastDedupAt).toBeNull()
  })

  it('does not update lastDedupAt when LLM returns invalid JSON', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
      [`${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`]: NODE_B_CONTENT,
    })

    const badLlm: LlmClient = {
      generate: vi.fn().mockResolvedValue({
        content: 'this is not json',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    }

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const result = await runDedup({ omgRoot: OMG_ROOT, config: makeConfig(), llmClient: badLlm })

    expect(result.mergesExecuted).toBe(0)
    expect(result.errors.length).toBeGreaterThan(0)

    const { loadDedupState } = await import('../../../src/dedup/state.js')
    const state = await loadDedupState(OMG_ROOT)
    expect(state.lastDedupAt).toBeNull()
  })

  it('does not update lastDedupAt when LLM returns schema-invalid response', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
      [`${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`]: NODE_B_CONTENT,
    })

    const badLlm: LlmClient = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ notMergePlans: 'wrong key' }),
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    }

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const result = await runDedup({ omgRoot: OMG_ROOT, config: makeConfig(), llmClient: badLlm })

    expect(result.errors.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// tokensUsed
// ---------------------------------------------------------------------------

describe('runDedup — tokensUsed', () => {
  it('returns tokensUsed from LLM response', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2024-01-01.md`]: NODE_A_CONTENT,
      [`${OMG_ROOT}/nodes/preference/preference-dark-theme-2024-01-01.md`]: NODE_B_CONTENT,
    })

    const llm: LlmClient = {
      generate: vi.fn().mockResolvedValue({
        content: JSON.stringify({ mergePlans: [] }),
        usage: { inputTokens: 200, outputTokens: 75 },
      }),
    }

    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const result = await runDedup({ omgRoot: OMG_ROOT, config: makeConfig(), llmClient: llm })

    expect(result.tokensUsed).toBe(275)
  })

  it('returns zero tokensUsed when no LLM call made', async () => {
    const { runDedup } = await import('../../../src/dedup/dedup.js')
    const result = await runDedup({ omgRoot: OMG_ROOT, config: makeConfig(), llmClient: makeMockLlm() })

    expect(result.tokensUsed).toBe(0)
  })
})
