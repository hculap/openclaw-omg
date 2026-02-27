import { describe, it, expect, beforeEach } from 'vitest'
import {
  getNeighbors,
  getBacklinks,
  getSubgraph,
  findPaths,
  clearGraphCache,
} from '../../src/graph/traversal.js'
import type { RegistryNodeEntry } from '../../src/graph/registry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OMG_ROOT = '/test/omg'

function makeEntry(
  overrides: Partial<{
    type: RegistryNodeEntry['type']
    priority: RegistryNodeEntry['priority']
    description: string
    links: string[]
    tags: string[]
    updated: string
    archived: boolean
  }> = {}
): RegistryNodeEntry {
  const now = new Date().toISOString()
  return {
    type: overrides.type ?? 'fact',
    kind: 'observation',
    description: overrides.description ?? 'A test node',
    priority: overrides.priority ?? 'medium',
    created: now,
    updated: overrides.updated ?? now,
    filePath: '/test/node.md',
    links: overrides.links,
    tags: overrides.tags,
    ...(overrides.archived !== undefined ? { archived: overrides.archived } : {}),
  }
}

/**
 * Fixed graph fixture:
 *   A → [B, C]
 *   B → [D]
 *   C → [D, E]
 *   D → []
 *   E → [A]
 *   F → []
 */
function buildFixture(): readonly [string, RegistryNodeEntry][] {
  return [
    ['A', makeEntry({ links: ['B', 'C'], description: 'Node A', priority: 'high' })],
    ['B', makeEntry({ links: ['D'], description: 'Node B' })],
    ['C', makeEntry({ links: ['D', 'E'], description: 'Node C' })],
    ['D', makeEntry({ links: [], description: 'Node D', priority: 'low' })],
    ['E', makeEntry({ links: ['A'], description: 'Node E' })],
    ['F', makeEntry({ links: [], description: 'Node F isolated' })],
  ]
}

beforeEach(() => {
  clearGraphCache()
})

// ---------------------------------------------------------------------------
// getNeighbors
// ---------------------------------------------------------------------------

describe('getNeighbors', () => {
  it('forward depth 1: A → {B, C}', () => {
    const entries = buildFixture()
    const neighbors = getNeighbors(OMG_ROOT, entries, 'A', 'forward', 1)

    const ids = neighbors.map((n) => n.nodeId).sort()
    expect(ids).toEqual(['B', 'C'])
    expect(neighbors.every((n) => n.distance === 1)).toBe(true)
    expect(neighbors.every((n) => n.direction === 'forward')).toBe(true)
  })

  it('forward depth 2: A → {B, C, D, E}', () => {
    const entries = buildFixture()
    const neighbors = getNeighbors(OMG_ROOT, entries, 'A', 'forward', 2)

    const ids = neighbors.map((n) => n.nodeId).sort()
    expect(ids).toEqual(['B', 'C', 'D', 'E'])

    const depth1 = neighbors.filter((n) => n.distance === 1).map((n) => n.nodeId).sort()
    expect(depth1).toEqual(['B', 'C'])

    const depth2 = neighbors.filter((n) => n.distance === 2).map((n) => n.nodeId).sort()
    expect(depth2).toEqual(['D', 'E'])
  })

  it('backward depth 1: D ← {B, C}', () => {
    const entries = buildFixture()
    const neighbors = getNeighbors(OMG_ROOT, entries, 'D', 'backward', 1)

    const ids = neighbors.map((n) => n.nodeId).sort()
    expect(ids).toEqual(['B', 'C'])
    expect(neighbors.every((n) => n.direction === 'backward')).toBe(true)
  })

  it('both: B gets {D} forward + {A} backward', () => {
    const entries = buildFixture()
    const neighbors = getNeighbors(OMG_ROOT, entries, 'B', 'both', 1)

    const ids = neighbors.map((n) => n.nodeId).sort()
    expect(ids).toEqual(['A', 'D'])

    const forward = neighbors.find((n) => n.nodeId === 'D')
    expect(forward?.direction).toBe('forward')

    const backward = neighbors.find((n) => n.nodeId === 'A')
    expect(backward?.direction).toBe('backward')
  })

  it('unknown nodeId → empty array', () => {
    const entries = buildFixture()
    const neighbors = getNeighbors(OMG_ROOT, entries, 'UNKNOWN', 'both', 2)
    expect(neighbors).toEqual([])
  })

  it('does not include self in results', () => {
    // E → [A], A → [B, C], so backward of A includes E
    // forward of A includes B, C — A should not appear
    const entries = buildFixture()
    const neighbors = getNeighbors(OMG_ROOT, entries, 'A', 'both', 1)
    const ids = neighbors.map((n) => n.nodeId)
    expect(ids).not.toContain('A')
  })
})

// ---------------------------------------------------------------------------
// getBacklinks
// ---------------------------------------------------------------------------

describe('getBacklinks', () => {
  it('D ← {B, C}', () => {
    const entries = buildFixture()
    const backlinks = getBacklinks(OMG_ROOT, entries, 'D')
    expect([...backlinks].sort()).toEqual(['B', 'C'])
  })

  it('F ← {} (isolated node)', () => {
    const entries = buildFixture()
    const backlinks = getBacklinks(OMG_ROOT, entries, 'F')
    expect(backlinks).toEqual([])
  })

  it('A ← {E} (cycle)', () => {
    const entries = buildFixture()
    const backlinks = getBacklinks(OMG_ROOT, entries, 'A')
    expect([...backlinks]).toEqual(['E'])
  })
})

// ---------------------------------------------------------------------------
// getSubgraph
// ---------------------------------------------------------------------------

describe('getSubgraph', () => {
  it('from A depth 1: includes A, B, C with edges', () => {
    const entries = buildFixture()
    const subgraph = getSubgraph(OMG_ROOT, entries, ['A'], 1, 100)

    // A + its forward neighbors B, C + backward neighbor E
    expect(subgraph.nodeIds).toContain('A')
    expect(subgraph.nodeIds).toContain('B')
    expect(subgraph.nodeIds).toContain('C')

    // Edges should include A→B and A→C
    const edgeKeys = subgraph.edges.map((e) => `${e.fromId}→${e.toId}`)
    expect(edgeKeys).toContain('A→B')
    expect(edgeKeys).toContain('A→C')
  })

  it('respects maxNodes cap', () => {
    const entries = buildFixture()
    const subgraph = getSubgraph(OMG_ROOT, entries, ['A'], 2, 3)

    expect(subgraph.nodeIds.length).toBeLessThanOrEqual(3)
    expect(subgraph.nodeIds).toContain('A')
  })

  it('handles cycles (E→A→B,C)', () => {
    const entries = buildFixture()
    const subgraph = getSubgraph(OMG_ROOT, entries, ['E'], 2, 100)

    // E→A is depth 1, then A→B, A→C are depth 2
    expect(subgraph.nodeIds).toContain('E')
    expect(subgraph.nodeIds).toContain('A')

    // No infinite loop — all nodes appear at most once
    const uniqueIds = new Set(subgraph.nodeIds)
    expect(uniqueIds.size).toBe(subgraph.nodeIds.length)
  })

  it('skips seed nodes not in registry', () => {
    const entries = buildFixture()
    const subgraph = getSubgraph(OMG_ROOT, entries, ['UNKNOWN', 'A'], 1, 100)

    expect(subgraph.nodeIds).toContain('A')
    expect(subgraph.nodeIds).not.toContain('UNKNOWN')
  })
})

// ---------------------------------------------------------------------------
// findPaths
// ---------------------------------------------------------------------------

describe('findPaths', () => {
  it('A→D depth 2: finds two paths [[A,B,D], [A,C,D]]', () => {
    const entries = buildFixture()
    const paths = findPaths(OMG_ROOT, entries, 'A', 'D', 2)

    expect(paths.length).toBe(2)
    const pathSets = paths.map((p) => p.nodeIds.join('→')).sort()
    expect(pathSets).toEqual(['A→B→D', 'A→C→D'])
    expect(paths.every((p) => p.length === 2)).toBe(true)
  })

  it('A→F: no path (F is isolated)', () => {
    const entries = buildFixture()
    const paths = findPaths(OMG_ROOT, entries, 'A', 'F', 2)
    expect(paths).toEqual([])
  })

  it('A→B depth 1: finds direct path', () => {
    const entries = buildFixture()
    const paths = findPaths(OMG_ROOT, entries, 'A', 'B', 1)

    expect(paths.length).toBe(1)
    expect(paths[0]!.nodeIds).toEqual(['A', 'B'])
    expect(paths[0]!.length).toBe(1)
  })

  it('A→D depth 1: no path (D is 2 hops away)', () => {
    const entries = buildFixture()
    const paths = findPaths(OMG_ROOT, entries, 'A', 'D', 1)
    expect(paths).toEqual([])
  })

  it('same node → zero-length path', () => {
    const entries = buildFixture()
    const paths = findPaths(OMG_ROOT, entries, 'A', 'A', 2)
    expect(paths.length).toBe(1)
    expect(paths[0]!.nodeIds).toEqual(['A'])
    expect(paths[0]!.length).toBe(0)
  })

  it('unknown source → empty', () => {
    const entries = buildFixture()
    const paths = findPaths(OMG_ROOT, entries, 'UNKNOWN', 'A', 2)
    expect(paths).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// clearGraphCache
// ---------------------------------------------------------------------------

describe('clearGraphCache', () => {
  it('forces rebuild on next call after clear', () => {
    const entries = buildFixture()

    // Prime the cache
    const neighbors1 = getNeighbors(OMG_ROOT, entries, 'A', 'forward', 1)
    expect(neighbors1.map((n) => n.nodeId).sort()).toEqual(['B', 'C'])

    // Modify entries: remove C's link from A
    const modifiedEntries: [string, RegistryNodeEntry][] = entries.map(([id, entry]) => {
      if (id === 'A') return [id, { ...entry, links: ['B'] }]
      return [id, entry]
    })

    // Without clear, cache still returns old adjacency (entry count is same)
    // After clear, it rebuilds
    clearGraphCache(OMG_ROOT)
    const neighbors2 = getNeighbors(OMG_ROOT, modifiedEntries, 'A', 'forward', 1)
    expect(neighbors2.map((n) => n.nodeId)).toEqual(['B'])
  })
})

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

describe('scoring', () => {
  it('higher priority → higher score at same distance', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['root', makeEntry({ links: ['high-pri', 'low-pri'] })],
      ['high-pri', makeEntry({ priority: 'high' })],
      ['low-pri', makeEntry({ priority: 'low' })],
    ]

    const neighbors = getNeighbors(OMG_ROOT, entries, 'root', 'forward', 1)
    const highPri = neighbors.find((n) => n.nodeId === 'high-pri')!
    const lowPri = neighbors.find((n) => n.nodeId === 'low-pri')!

    expect(highPri.score).toBeGreaterThan(lowPri.score)
  })

  it('depth-2 < depth-1 (distance decay)', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['root', makeEntry({ links: ['hop1'] })],
      ['hop1', makeEntry({ links: ['hop2'] })],
      ['hop2', makeEntry({})],
    ]

    clearGraphCache()
    const neighbors = getNeighbors(OMG_ROOT, entries, 'root', 'forward', 2)
    const hop1 = neighbors.find((n) => n.nodeId === 'hop1')!
    const hop2 = neighbors.find((n) => n.nodeId === 'hop2')!

    expect(hop1.score).toBeGreaterThan(hop2.score)
    expect(hop1.distance).toBe(1)
    expect(hop2.distance).toBe(2)
  })

  it('results sorted by score descending', () => {
    const entries = buildFixture()
    const neighbors = getNeighbors(OMG_ROOT, entries, 'A', 'forward', 2)

    for (let i = 1; i < neighbors.length; i++) {
      expect(neighbors[i - 1]!.score).toBeGreaterThanOrEqual(neighbors[i]!.score)
    }
  })
})

// ---------------------------------------------------------------------------
// Archived node filtering
// ---------------------------------------------------------------------------

describe('archived node filtering', () => {
  it('excludes archived nodes from neighbors', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['A', makeEntry({ links: ['B', 'C'] })],
      ['B', makeEntry({ archived: true })],
      ['C', makeEntry({})],
    ]

    const neighbors = getNeighbors(OMG_ROOT, entries, 'A', 'forward', 1)
    const ids = neighbors.map((n) => n.nodeId)
    expect(ids).toEqual(['C'])
    expect(ids).not.toContain('B')
  })

  it('excludes archived nodes from backlinks', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['A', makeEntry({ links: ['C'] })],
      ['B', makeEntry({ links: ['C'], archived: true })],
      ['C', makeEntry({})],
    ]

    const backlinks = getBacklinks(OMG_ROOT, entries, 'C')
    expect(backlinks).toEqual(['A'])
    expect(backlinks).not.toContain('B')
  })

  it('excludes archived nodes from subgraph', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['A', makeEntry({ links: ['B', 'C'] })],
      ['B', makeEntry({ archived: true })],
      ['C', makeEntry({})],
    ]

    const subgraph = getSubgraph(OMG_ROOT, entries, ['A'], 1, 100)
    expect(subgraph.nodeIds).toContain('A')
    expect(subgraph.nodeIds).toContain('C')
    expect(subgraph.nodeIds).not.toContain('B')
  })

  it('excludes archived nodes from paths', () => {
    // A → B → C, but B is archived — no path should exist
    const entries: [string, RegistryNodeEntry][] = [
      ['A', makeEntry({ links: ['B'] })],
      ['B', makeEntry({ links: ['C'], archived: true })],
      ['C', makeEntry({})],
    ]

    const paths = findPaths(OMG_ROOT, entries, 'A', 'C', 2)
    expect(paths).toEqual([])
  })

  it('archived source node returns no neighbors', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['A', makeEntry({ links: ['B'], archived: true })],
      ['B', makeEntry({})],
    ]

    const neighbors = getNeighbors(OMG_ROOT, entries, 'A', 'forward', 1)
    expect(neighbors).toEqual([])
  })
})
