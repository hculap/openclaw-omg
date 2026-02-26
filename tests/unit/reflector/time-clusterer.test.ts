import { describe, it, expect } from 'vitest'
import { createTimeClusters, type ClusteringConfig } from '../../../src/reflector/time-clusterer.js'
import type { RegistryNodeEntry } from '../../../src/graph/registry.js'

function makeEntry(updated: string, descLength = 10): RegistryNodeEntry {
  return {
    type: 'fact',
    kind: 'observation',
    description: 'x'.repeat(descLength),
    priority: 'medium',
    created: '2026-01-01T00:00:00Z',
    updated,
    filePath: '/test/node.md',
  }
}

const defaultConfig: ClusteringConfig = {
  windowSpanDays: 7,
  maxNodesPerCluster: 25,
  maxInputTokensPerCluster: 8000,
}

describe('createTimeClusters', () => {
  it('returns empty array for empty input', () => {
    expect(createTimeClusters('misc', [], defaultConfig)).toEqual([])
  })

  it('puts all entries in one cluster when they fit', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['a', makeEntry('2026-01-01T00:00:00Z')],
      ['b', makeEntry('2026-01-02T00:00:00Z')],
      ['c', makeEntry('2026-01-03T00:00:00Z')],
    ]
    const clusters = createTimeClusters('misc', entries, defaultConfig)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.nodeIds).toEqual(['a', 'b', 'c'])
    expect(clusters[0]!.domain).toBe('misc')
  })

  it('splits by time window', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['a', makeEntry('2026-01-01T00:00:00Z')],
      ['b', makeEntry('2026-01-03T00:00:00Z')],
      ['c', makeEntry('2026-01-15T00:00:00Z')], // > 7 days from a
    ]
    const clusters = createTimeClusters('misc', entries, defaultConfig)
    expect(clusters).toHaveLength(2)
    expect(clusters[0]!.nodeIds).toEqual(['a', 'b'])
    expect(clusters[1]!.nodeIds).toEqual(['c'])
  })

  it('splits by node count limit', () => {
    const config: ClusteringConfig = { ...defaultConfig, maxNodesPerCluster: 2 }
    const entries: [string, RegistryNodeEntry][] = [
      ['a', makeEntry('2026-01-01T00:00:00Z')],
      ['b', makeEntry('2026-01-02T00:00:00Z')],
      ['c', makeEntry('2026-01-03T00:00:00Z')],
    ]
    const clusters = createTimeClusters('test', entries, config)
    expect(clusters).toHaveLength(2)
    expect(clusters[0]!.nodeIds).toEqual(['a', 'b'])
    expect(clusters[1]!.nodeIds).toEqual(['c'])
  })

  it('splits by token budget', () => {
    // Each entry has description of 500 chars → 500/4 = 125 tokens base → 125*8 = 1000 estimated
    const config: ClusteringConfig = { ...defaultConfig, maxInputTokensPerCluster: 1500 }
    const entries: [string, RegistryNodeEntry][] = [
      ['a', makeEntry('2026-01-01T00:00:00Z', 500)],
      ['b', makeEntry('2026-01-02T00:00:00Z', 500)],
      ['c', makeEntry('2026-01-03T00:00:00Z', 500)],
    ]
    const clusters = createTimeClusters('test', entries, config)
    expect(clusters.length).toBeGreaterThanOrEqual(2)
  })

  it('preserves chronological order within clusters', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['c', makeEntry('2026-01-03T00:00:00Z')],
      ['a', makeEntry('2026-01-01T00:00:00Z')],
      ['b', makeEntry('2026-01-02T00:00:00Z')],
    ]
    const clusters = createTimeClusters('misc', entries, defaultConfig)
    expect(clusters[0]!.nodeIds).toEqual(['a', 'b', 'c'])
  })

  it('sets correct time ranges', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['a', makeEntry('2026-01-01T00:00:00Z')],
      ['b', makeEntry('2026-01-05T00:00:00Z')],
    ]
    const clusters = createTimeClusters('misc', entries, defaultConfig)
    expect(clusters[0]!.timeRange.start).toBe('2026-01-01T00:00:00Z')
    expect(clusters[0]!.timeRange.end).toBe('2026-01-05T00:00:00Z')
  })

  it('handles single entry', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['a', makeEntry('2026-01-01T00:00:00Z')],
    ]
    const clusters = createTimeClusters('misc', entries, defaultConfig)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.nodeIds).toEqual(['a'])
  })
})
