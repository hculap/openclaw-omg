import { describe, it, expect } from 'vitest'
import { generateSemanticBlocks } from '../../../src/dedup/semantic-blocks.js'
import type { RegistryNodeEntry } from '../../../src/graph/registry.js'
import type { SemanticDedupConfig } from '../../../src/dedup/semantic-types.js'

const DEFAULT_CONFIG: SemanticDedupConfig = {
  enabled: true,
  heuristicPrefilterThreshold: 0.25,
  semanticMergeThreshold: 85,
  maxBlockSize: 6,
  maxBlocksPerRun: 15,
  maxBodyCharsPerNode: 500,
  timeWindowDays: 30,
}

function makeEntry(
  type: string,
  desc: string,
  canonicalKey: string,
  updated: string = '2026-01-15T00:00:00Z',
  extra: Partial<RegistryNodeEntry> = {},
): [string, RegistryNodeEntry] {
  const id = `omg/${canonicalKey.replace(/\./g, '-')}`
  return [
    id,
    {
      type: type as RegistryNodeEntry['type'],
      kind: 'observation' as const,
      description: desc,
      priority: 'medium' as const,
      created: '2026-01-01T00:00:00Z',
      updated,
      filePath: `/fake/${id}.md`,
      canonicalKey,
      ...extra,
    },
  ]
}

describe('generateSemanticBlocks', () => {
  it('returns empty for empty entries', () => {
    expect(generateSemanticBlocks([], DEFAULT_CONFIG)).toHaveLength(0)
  })

  it('returns empty for single entry', () => {
    const entries = [makeEntry('fact', 'A fact', 'facts.one')]
    expect(generateSemanticBlocks(entries, DEFAULT_CONFIG)).toHaveLength(0)
  })

  it('excludes archived entries', () => {
    const entries = [
      makeEntry('fact', 'Similar fact A', 'facts.similar-a'),
      makeEntry('fact', 'Similar fact A again', 'facts.similar-a-again', '2026-01-15T00:00:00Z', { archived: true }),
    ]
    expect(generateSemanticBlocks(entries, DEFAULT_CONFIG)).toHaveLength(0)
  })

  it('excludes moc, index, now, reflection types', () => {
    const entries = [
      makeEntry('moc', 'MOC A', 'moc.a'),
      makeEntry('moc', 'MOC B', 'moc.b'),
      makeEntry('index', 'Index', 'index.main'),
      makeEntry('now', 'Now', 'now.current'),
    ]
    expect(generateSemanticBlocks(entries, DEFAULT_CONFIG)).toHaveLength(0)
  })

  it('groups entries by type and domain', () => {
    // Two similar facts in the same domain should form a block
    const entries = [
      makeEntry('fact', 'User prefers dark mode in editor', 'facts.dark-mode-pref'),
      makeEntry('fact', 'User prefers dark mode theme', 'facts.dark-mode-theme'),
    ]
    const blocks = generateSemanticBlocks(entries, DEFAULT_CONFIG)
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks[0]!.nodeIds).toHaveLength(2)
  })

  it('respects maxBlockSize', () => {
    const config = { ...DEFAULT_CONFIG, maxBlockSize: 2 }
    const entries = [
      makeEntry('fact', 'Similar fact A', 'facts.similar-a'),
      makeEntry('fact', 'Similar fact B', 'facts.similar-b'),
      makeEntry('fact', 'Similar fact C', 'facts.similar-c'),
    ]
    const blocks = generateSemanticBlocks(entries, config)
    for (const block of blocks) {
      expect(block.nodeIds.length).toBeLessThanOrEqual(2)
    }
  })

  it('respects maxBlocksPerRun', () => {
    const config = { ...DEFAULT_CONFIG, maxBlocksPerRun: 1, maxBlockSize: 2 }
    // Create enough similar entries to potentially form multiple blocks
    const entries = [
      makeEntry('fact', 'Similar topic alpha', 'facts.alpha'),
      makeEntry('fact', 'Similar topic alpha v2', 'facts.alpha-v2'),
      makeEntry('preference', 'Preference beta', 'preferences.beta'),
      makeEntry('preference', 'Preference beta v2', 'preferences.beta-v2'),
    ]
    const blocks = generateSemanticBlocks(entries, config)
    expect(blocks.length).toBeLessThanOrEqual(1)
  })

  it('filters by time window', () => {
    const config = { ...DEFAULT_CONFIG, timeWindowDays: 1 }
    const entries = [
      makeEntry('fact', 'Similar fact old', 'facts.similar-old', '2026-01-01T00:00:00Z'),
      makeEntry('fact', 'Similar fact new', 'facts.similar-new', '2026-02-15T00:00:00Z'),
    ]
    // These are 45 days apart, exceeding the 1-day window
    expect(generateSemanticBlocks(entries, config)).toHaveLength(0)
  })

  it('does not block entries with low heuristic similarity', () => {
    const config = { ...DEFAULT_CONFIG, heuristicPrefilterThreshold: 0.99 }
    const entries = [
      makeEntry('fact', 'Quantum computing architecture', 'facts.quantum'),
      makeEntry('fact', 'Weather patterns in Europe', 'facts.weather'),
    ]
    expect(generateSemanticBlocks(entries, config)).toHaveLength(0)
  })
})
