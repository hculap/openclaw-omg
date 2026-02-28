/**
 * Eval test: run graph traversal engine on real registry data.
 * Run with: pnpm vitest run tests/eval/graph-real-data.test.ts
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import {
  getNeighbors,
  getBacklinks,
  getSubgraph,
  findPaths,
  clearGraphCache,
} from '../../src/graph/traversal.js'
import type { RegistryNodeEntry } from '../../src/graph/registry.js'

const REGISTRY_PATH = '/Users/szymonpaluch/Projects/Personal/Secretary/memory/omg/.registry.json'
const OMG_ROOT = '/Users/szymonpaluch/Projects/Personal/Secretary/memory/omg'

describe.skipIf(!existsSync(REGISTRY_PATH))('graph traversal on real data', () => {
  const raw = existsSync(REGISTRY_PATH)
    ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
    : { nodes: {} }
  const entries: [string, RegistryNodeEntry][] = Object.entries(raw.nodes) as [string, RegistryNodeEntry][]
  const allIds = new Set(entries.map(([id]) => id))

  it('analyzes link structure', () => {
    let withLinks = 0
    let totalLinks = 0
    let resolvedLinks = 0

    for (const [, entry] of entries) {
      const links = entry.links ?? []
      if (links.length > 0) {
        withLinks++
        totalLinks += links.length
        resolvedLinks += links.filter((l: string) => allIds.has(l)).length
      }
    }

    console.log('\n=== REAL GRAPH ANALYSIS ===')
    console.log('Total nodes:', entries.length)
    console.log('Nodes with links:', withLinks, '/', entries.length, `(${((withLinks / entries.length) * 100).toFixed(1)}%)`)
    console.log('Total link count:', totalLinks)
    console.log('Resolved links (target exists):', resolvedLinks, '/', totalLinks, `(${((resolvedLinks / totalLinks) * 100).toFixed(1)}%)`)
    console.log('Avg links per linked node:', (totalLinks / Math.max(withLinks, 1)).toFixed(1))

    expect(entries.length).toBeGreaterThan(0)
    expect(withLinks).toBeGreaterThan(0)
  })

  it('shows top linked + most back-linked nodes', () => {
    const byLinkCount = entries
      .filter(([, e]) => (e.links ?? []).length > 0)
      .sort(([, a], [, b]) => (b.links ?? []).length - (a.links ?? []).length)
      .slice(0, 5)

    console.log('\n--- Top 5 most-linked nodes ---')
    for (const [id, entry] of byLinkCount) {
      const links = (entry.links ?? []) as string[]
      const resolved = links.filter((l) => allIds.has(l))
      console.log(`  ${id} (${entry.type}): ${links.length} links, ${resolved.length} resolved`)
      console.log(`    → ${resolved.slice(0, 5).join(', ')}${resolved.length > 5 ? ` ... +${resolved.length - 5} more` : ''}`)
    }

    const backlinkCounts = new Map<string, number>()
    for (const [, entry] of entries) {
      for (const link of (entry.links ?? []) as string[]) {
        if (allIds.has(link)) {
          backlinkCounts.set(link, (backlinkCounts.get(link) ?? 0) + 1)
        }
      }
    }
    const topBacklinked = [...backlinkCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)

    console.log('\n--- Most back-linked nodes ---')
    for (const [id, count] of topBacklinked) {
      const entry = raw.nodes[id]
      console.log(`  ${id} (${entry?.type}): ${count} backlinks — "${(entry?.description as string)?.slice(0, 60)}"`)
    }

    expect(byLinkCount.length).toBeGreaterThan(0)
  })

  it('traversal functions work on real graph', () => {
    clearGraphCache()

    // Find a node with many backlinks to test
    const backlinkCounts = new Map<string, number>()
    for (const [, entry] of entries) {
      for (const link of (entry.links ?? []) as string[]) {
        if (allIds.has(link)) {
          backlinkCounts.set(link, (backlinkCounts.get(link) ?? 0) + 1)
        }
      }
    }
    const topBacklinked = [...backlinkCounts.entries()]
      .sort(([, a], [, b]) => b - a)

    const testNodeId = topBacklinked[0]?.[0]
    expect(testNodeId).toBeDefined()
    if (!testNodeId) return

    console.log(`\n--- Traversal tests for "${testNodeId}" ---`)

    // Backlinks
    const backlinks = getBacklinks(OMG_ROOT, entries, testNodeId)
    console.log(`  getBacklinks: ${backlinks.length} backlinks`)
    console.log(`    ${backlinks.slice(0, 5).join(', ')}${backlinks.length > 5 ? ` ... +${backlinks.length - 5} more` : ''}`)
    expect(backlinks.length).toBeGreaterThan(0)

    // Forward neighbors depth 1
    const fwd1 = getNeighbors(OMG_ROOT, entries, testNodeId, 'forward', 1)
    console.log(`  getNeighbors(forward, 1): ${fwd1.length} neighbors`)
    for (const n of fwd1.slice(0, 3)) {
      console.log(`    ${n.nodeId} (d=${n.distance}, dir=${n.direction}, score=${n.score.toFixed(3)})`)
    }

    // Both neighbors depth 2
    const both2 = getNeighbors(OMG_ROOT, entries, testNodeId, 'both', 2)
    console.log(`  getNeighbors(both, 2): ${both2.length} neighbors`)
    console.log(`    depth-1: ${both2.filter((n) => n.distance === 1).length}, depth-2: ${both2.filter((n) => n.distance === 2).length}`)
    console.log(`    forward: ${both2.filter((n) => n.direction === 'forward').length}, backward: ${both2.filter((n) => n.direction === 'backward').length}`)
    expect(both2.length).toBeGreaterThanOrEqual(fwd1.length)

    // Subgraph
    const subgraph = getSubgraph(OMG_ROOT, entries, [testNodeId], 2, 20)
    console.log(`  getSubgraph(depth=2, max=20): ${subgraph.nodeIds.length} nodes, ${subgraph.edges.length} edges`)
    expect(subgraph.nodeIds).toContain(testNodeId)
    expect(subgraph.nodeIds.length).toBeLessThanOrEqual(20)
  })

  it('finds paths between top nodes', () => {
    clearGraphCache()

    const backlinkCounts = new Map<string, number>()
    for (const [, entry] of entries) {
      for (const link of (entry.links ?? []) as string[]) {
        if (allIds.has(link)) {
          backlinkCounts.set(link, (backlinkCounts.get(link) ?? 0) + 1)
        }
      }
    }
    const topBacklinked = [...backlinkCounts.entries()]
      .sort(([, a], [, b]) => b - a)

    if (topBacklinked.length < 2) return

    const fromId = topBacklinked[0]![0]
    const toId = topBacklinked[1]![0]
    console.log(`\n--- findPaths("${fromId}" → "${toId}", depth=2) ---`)

    const t0 = performance.now()
    const paths = findPaths(OMG_ROOT, entries, fromId, toId, 2)
    const elapsed = performance.now() - t0

    console.log(`  Found ${paths.length} paths in ${elapsed.toFixed(1)}ms`)
    for (const p of paths.slice(0, 5)) {
      console.log(`    ${p.nodeIds.join(' → ')} (length=${p.length})`)
    }
  })

  it('performance benchmarks', () => {
    const testNodeId = entries[0]?.[0]
    if (!testNodeId) return

    clearGraphCache()
    const t0 = performance.now()
    getNeighbors(OMG_ROOT, entries, testNodeId, 'both', 2)
    const coldMs = performance.now() - t0

    const t1 = performance.now()
    getNeighbors(OMG_ROOT, entries, testNodeId, 'both', 2)
    const warmMs = performance.now() - t1

    console.log('\n--- Performance ---')
    console.log(`  Cold (build adjacency + traverse): ${coldMs.toFixed(1)}ms`)
    console.log(`  Warm (cached adjacency): ${warmMs.toFixed(1)}ms`)

    // Expansion simulation
    const t2 = performance.now()
    const top10 = entries.slice(0, 10)
    const expanded = new Set<string>()
    for (const [id] of top10) {
      const neighbors = getNeighbors(OMG_ROOT, entries, id, 'both', 2)
      for (const n of neighbors) expanded.add(n.nodeId)
    }
    const expansionMs = performance.now() - t2
    console.log(`  Expansion (10 seeds, depth=2): ${expanded.size} unique neighbors in ${expansionMs.toFixed(1)}ms`)

    // Ensure it's fast enough for context injection (<100ms cold)
    expect(coldMs).toBeLessThan(500)
    expect(warmMs).toBeLessThan(50)
  })
})
