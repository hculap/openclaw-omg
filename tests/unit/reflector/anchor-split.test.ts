import { describe, it, expect } from 'vitest'
import { splitByAnchor } from '../../../src/reflector/anchor-split.js'
import type { ReflectionCluster } from '../../../src/reflector/time-clusterer.js'
import type { RegistryNodeEntry } from '../../../src/graph/registry.js'

function makeEntry(links: string[] = [], descLength = 10): RegistryNodeEntry {
  return {
    type: 'fact',
    kind: 'observation',
    description: 'x'.repeat(descLength),
    priority: 'medium',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    filePath: '/test/node.md',
    links,
  }
}

function makeCluster(nodeIds: string[], estimatedTokens = 10000): ReflectionCluster {
  return {
    domain: 'misc',
    timeRange: { start: '2026-01-01T00:00:00Z', end: '2026-01-07T00:00:00Z' },
    nodeIds,
    estimatedTokens,
  }
}

describe('splitByAnchor', () => {
  it('returns original cluster if under token budget', () => {
    const cluster = makeCluster(['a', 'b'], 100)
    const entries = new Map([
      ['a', makeEntry(['omg/moc-tools'])],
      ['b', makeEntry(['omg/moc-tools'])],
    ])
    const result = splitByAnchor(cluster, entries, 200)
    expect(result).toHaveLength(1)
    expect(result[0]!.nodeIds).toEqual(['a', 'b'])
  })

  it('returns original cluster if 2 or fewer nodes', () => {
    const cluster = makeCluster(['a', 'b'], 10000)
    const entries = new Map([
      ['a', makeEntry(['omg/moc-tools'])],
      ['b', makeEntry(['omg/moc-prefs'])],
    ])
    const result = splitByAnchor(cluster, entries, 100)
    expect(result).toHaveLength(1)
  })

  it('splits by most common anchor link', () => {
    const cluster = makeCluster(['a', 'b', 'c', 'd'], 10000)
    const entries = new Map([
      ['a', makeEntry(['omg/moc-tools'])],
      ['b', makeEntry(['omg/moc-tools'])],
      ['c', makeEntry(['omg/moc-prefs'])],
      ['d', makeEntry(['omg/moc-prefs', 'omg/moc-tools'])],
    ])
    const result = splitByAnchor(cluster, entries, 100)
    expect(result.length).toBeGreaterThanOrEqual(2)

    const allNodeIds = result.flatMap((r) => [...r.nodeIds])
    expect(allNodeIds.sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('does not split when anchor covers all nodes', () => {
    const cluster = makeCluster(['a', 'b', 'c'], 10000)
    const entries = new Map([
      ['a', makeEntry(['omg/moc-tools'])],
      ['b', makeEntry(['omg/moc-tools'])],
      ['c', makeEntry(['omg/moc-tools'])],
    ])
    const result = splitByAnchor(cluster, entries, 100)
    expect(result).toHaveLength(1)
  })

  it('does not split when no links', () => {
    const cluster = makeCluster(['a', 'b', 'c'], 10000)
    const entries = new Map([
      ['a', makeEntry()],
      ['b', makeEntry()],
      ['c', makeEntry()],
    ])
    const result = splitByAnchor(cluster, entries, 100)
    expect(result).toHaveLength(1)
  })
})
