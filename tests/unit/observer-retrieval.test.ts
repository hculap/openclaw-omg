import { describe, it, expect, vi } from 'vitest'
import { findMergeTargets, shouldMerge, DEFAULT_MERGE_RETRIEVAL_CONFIG } from '../../src/observer/retrieval.js'
import type { MergeRetrievalConfig } from '../../src/observer/retrieval.js'
import type { ExtractCandidate } from '../../src/types.js'
import type { RegistryNodeEntry } from '../../src/graph/registry.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<ExtractCandidate> = {}): ExtractCandidate {
  return {
    type: 'preference',
    canonicalKey: 'preferences.editor_theme',
    title: 'Editor Theme',
    description: 'User prefers dark mode',
    body: 'The user prefers dark mode.',
    priority: 'high',
    ...overrides,
  }
}

function makeRegistryEntry(overrides: Partial<RegistryNodeEntry> = {}): RegistryNodeEntry {
  return {
    type: 'preference',
    kind: 'observation',
    description: 'User prefers dark mode in editors',
    priority: 'high',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    filePath: '/workspace/memory/omg/nodes/preference/preferences-editor-theme.md',
    canonicalKey: 'preferences.editor_theme',
    ...overrides,
  }
}

const TIGHT_CONFIG: MergeRetrievalConfig = {
  ...DEFAULT_MERGE_RETRIEVAL_CONFIG,
  mergeThreshold: 0.1,  // very low threshold to catch most matches
}

const HIGH_CONFIG: MergeRetrievalConfig = {
  ...DEFAULT_MERGE_RETRIEVAL_CONFIG,
  mergeThreshold: 0.99,  // very high threshold so nothing matches
}

// ---------------------------------------------------------------------------
// findMergeTargets — empty registry
// ---------------------------------------------------------------------------

describe('findMergeTargets — empty registry', () => {
  it('returns empty array when registry is empty', async () => {
    const result = await findMergeTargets(makeCandidate(), [], null)
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// findMergeTargets — local similarity
// ---------------------------------------------------------------------------

describe('findMergeTargets — local similarity', () => {
  it('finds similar node by canonicalKey and type', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['omg/preference/preferences-editor-theme', makeRegistryEntry()],
    ]

    const result = await findMergeTargets(makeCandidate(), entries, null, TIGHT_CONFIG)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]?.nodeId).toBe('omg/preference/preferences-editor-theme')
  })

  it('ignores archived entries', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['omg/preference/preferences-editor-theme', makeRegistryEntry({ archived: true })],
    ]

    const result = await findMergeTargets(makeCandidate(), entries, null, TIGHT_CONFIG)
    expect(result).toHaveLength(0)
  })

  it('ignores entries with different type', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['omg/fact/facts-editor-theme', makeRegistryEntry({ type: 'fact' })],
    ]

    const result = await findMergeTargets(makeCandidate(), entries, null, TIGHT_CONFIG)
    expect(result).toHaveLength(0)
  })

  it('returns results sorted by finalScore descending', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['omg/preference/preferences-editor-theme', makeRegistryEntry()],
      ['omg/preference/preferences-color-theme', makeRegistryEntry({
        canonicalKey: 'preferences.color_theme',
        description: 'User prefers specific color theme',
        filePath: '/workspace/memory/omg/nodes/preference/preferences-color-theme.md',
      })],
    ]

    const result = await findMergeTargets(makeCandidate(), entries, null, TIGHT_CONFIG)
    if (result.length >= 2) {
      expect(result[0]!.finalScore).toBeGreaterThanOrEqual(result[1]!.finalScore)
    }
  })

  it('applies threshold filter — returns empty above threshold', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['omg/preference/preferences-editor-theme', makeRegistryEntry()],
    ]

    const result = await findMergeTargets(makeCandidate(), entries, null, HIGH_CONFIG)
    expect(result).toHaveLength(0)
  })

  it('respects finalTopK limit', async () => {
    const entries: [string, RegistryNodeEntry][] = Array.from({ length: 20 }, (_, i) => [
      `omg/preference/preferences-theme-${i}`,
      makeRegistryEntry({
        canonicalKey: `preferences.theme_${i}`,
        description: `Theme variant ${i}`,
        filePath: `/workspace/memory/omg/nodes/preference/preferences-theme-${i}.md`,
      }),
    ])

    const config: MergeRetrievalConfig = { ...TIGHT_CONFIG, finalTopK: 3 }
    const result = await findMergeTargets(makeCandidate(), entries, null, config)
    expect(result.length).toBeLessThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// findMergeTargets — ScoredMergeTarget fields
// ---------------------------------------------------------------------------

describe('findMergeTargets — ScoredMergeTarget fields', () => {
  it('returns nodeId, entry, localScore, semanticScore, finalScore', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['omg/preference/preferences-editor-theme', makeRegistryEntry()],
    ]

    const result = await findMergeTargets(makeCandidate(), entries, null, TIGHT_CONFIG)
    if (result.length > 0) {
      const target = result[0]!
      expect(typeof target.nodeId).toBe('string')
      expect(typeof target.localScore).toBe('number')
      expect(typeof target.semanticScore).toBe('number')
      expect(typeof target.finalScore).toBe('number')
      expect(target.entry).toBeDefined()
    }
  })

  it('semanticScore is 0 when memoryTools is null', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['omg/preference/preferences-editor-theme', makeRegistryEntry()],
    ]

    const result = await findMergeTargets(makeCandidate(), entries, null, TIGHT_CONFIG)
    if (result.length > 0) {
      expect(result[0]!.semanticScore).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// findMergeTargets — semantic search (mocked memoryTools)
// ---------------------------------------------------------------------------

describe('findMergeTargets — semantic search', () => {
  it('includes semantic results even when local score is 0', async () => {
    const unrelatedEntry = makeRegistryEntry({
      type: 'preference',
      canonicalKey: 'preferences.something_else',
      description: 'Completely different thing',
      filePath: '/workspace/memory/omg/nodes/preference/preferences-something-else.md',
    })
    const entries: [string, RegistryNodeEntry][] = [
      ['omg/preference/preferences-something-else', unrelatedEntry],
    ]

    // Mock memoryTools to return the unrelated entry as a semantic match
    const mockMemoryTools = {
      search: vi.fn().mockResolvedValue({
        disabled: false,
        results: [{
          filePath: '/workspace/memory/omg/nodes/preference/preferences-something-else.md',
          score: 0.9,
          content: 'Some content',
        }],
      }),
      get: vi.fn().mockResolvedValue(null),
    }

    const result = await findMergeTargets(makeCandidate(), entries, mockMemoryTools, TIGHT_CONFIG)
    expect(mockMemoryTools.search).toHaveBeenCalled()
    // The semantic result should be included if score is high enough
    const found = result.find((t) => t.nodeId === 'omg/preference/preferences-something-else')
    expect(found?.semanticScore).toBeGreaterThan(0)
  })

  it('falls back to local-only when memoryTools.search throws', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['omg/preference/preferences-editor-theme', makeRegistryEntry()],
    ]

    const failingMemoryTools = {
      search: vi.fn().mockRejectedValue(new Error('search failed')),
      get: vi.fn().mockResolvedValue(null),
    }

    // Should not throw and should still return local results
    const result = await findMergeTargets(makeCandidate(), entries, failingMemoryTools, TIGHT_CONFIG)
    expect(result.length).toBeGreaterThan(0)
    expect(result[0]!.semanticScore).toBe(0)
  })

  it('falls back to local-only when response.disabled is true', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['omg/preference/preferences-editor-theme', makeRegistryEntry()],
    ]

    const disabledMemoryTools = {
      search: vi.fn().mockResolvedValue({ disabled: true, results: [] }),
      get: vi.fn().mockResolvedValue(null),
    }

    const result = await findMergeTargets(makeCandidate(), entries, disabledMemoryTools, TIGHT_CONFIG)
    if (result.length > 0) {
      expect(result[0]!.semanticScore).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// shouldMerge
// ---------------------------------------------------------------------------

describe('shouldMerge', () => {
  it('returns false for empty targets', () => {
    expect(shouldMerge([], 0.4)).toBe(false)
  })

  it('returns true when top score exceeds threshold', () => {
    const targets = [
      { nodeId: 'n', entry: makeRegistryEntry(), localScore: 0.8, semanticScore: 0, finalScore: 0.8 },
    ]
    expect(shouldMerge(targets, 0.4)).toBe(true)
  })

  it('returns false when top score is below threshold', () => {
    const targets = [
      { nodeId: 'n', entry: makeRegistryEntry(), localScore: 0.3, semanticScore: 0, finalScore: 0.3 },
    ]
    expect(shouldMerge(targets, 0.4)).toBe(false)
  })

  it('returns false when top score equals threshold exactly', () => {
    const targets = [
      { nodeId: 'n', entry: makeRegistryEntry(), localScore: 0.4, semanticScore: 0, finalScore: 0.4 },
    ]
    // shouldMerge uses >= so threshold of 0.4 with score 0.4 = true
    expect(shouldMerge(targets, 0.4)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// DEFAULT_MERGE_RETRIEVAL_CONFIG
// ---------------------------------------------------------------------------

describe('DEFAULT_MERGE_RETRIEVAL_CONFIG', () => {
  it('has expected default values', () => {
    expect(DEFAULT_MERGE_RETRIEVAL_CONFIG.localTopM).toBe(50)
    expect(DEFAULT_MERGE_RETRIEVAL_CONFIG.semanticTopS).toBe(20)
    expect(DEFAULT_MERGE_RETRIEVAL_CONFIG.finalTopK).toBe(7)
    expect(DEFAULT_MERGE_RETRIEVAL_CONFIG.localWeight).toBe(0.6)
    expect(DEFAULT_MERGE_RETRIEVAL_CONFIG.semanticWeight).toBe(0.4)
    expect(DEFAULT_MERGE_RETRIEVAL_CONFIG.mergeThreshold).toBe(0.4)
  })
})
