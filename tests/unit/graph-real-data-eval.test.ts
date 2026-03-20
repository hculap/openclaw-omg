/**
 * Eval test: run graph traversal engine on real registry data.
 * Writes results to /tmp/graph-eval-results.txt for inspection.
 */

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
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
const OUTPUT_PATH = '/tmp/graph-eval-results.txt'

const lines: string[] = []
function log(msg: string): void { lines.push(msg) }

describe.skipIf(!existsSync(REGISTRY_PATH))('graph traversal on real data', () => {
  const raw = existsSync(REGISTRY_PATH)
    ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
    : { nodes: {} }
  const allEntries: [string, RegistryNodeEntry][] = Object.entries(raw.nodes) as [string, RegistryNodeEntry][]
  const activeEntries = allEntries.filter(([, e]) => !e.archived)
  const archivedEntries = allEntries.filter(([, e]) => e.archived)
  const activeIds = new Set(activeEntries.map(([id]) => id))

  afterAll(() => {
    writeFileSync(OUTPUT_PATH, lines.join('\n') + '\n')
  })

  it('analyzes link structure (active nodes only)', () => {
    let withLinks = 0
    let totalLinks = 0
    let resolvedLinks = 0

    for (const [, entry] of activeEntries) {
      const links = entry.links ?? []
      if (links.length > 0) {
        withLinks++
        totalLinks += links.length
        resolvedLinks += links.filter((l: string) => activeIds.has(l)).length
      }
    }

    log('=== REAL GRAPH ANALYSIS ===')
    log(`Total nodes: ${allEntries.length} (${activeEntries.length} active, ${archivedEntries.length} archived)`)
    log(`Active nodes with links: ${withLinks} / ${activeEntries.length} (${((withLinks / activeEntries.length) * 100).toFixed(1)}%)`)
    log(`Total link count (from active): ${totalLinks}`)
    log(`Resolved to active nodes: ${resolvedLinks} / ${totalLinks} (${((resolvedLinks / totalLinks) * 100).toFixed(1)}%)`)
    log(`Avg links per linked node: ${(totalLinks / Math.max(withLinks, 1)).toFixed(1)}`)

    expect(activeEntries.length).toBeGreaterThan(0)
    expect(withLinks).toBeGreaterThan(0)
  })

  it('shows top linked + most back-linked active nodes', () => {
    const byLinkCount = activeEntries
      .filter(([, e]) => (e.links ?? []).length > 0)
      .sort(([, a], [, b]) => (b.links ?? []).length - (a.links ?? []).length)
      .slice(0, 5)

    log('\n--- Top 5 most-linked active nodes ---')
    for (const [id, entry] of byLinkCount) {
      const links = (entry.links ?? []) as string[]
      const resolved = links.filter((l) => activeIds.has(l))
      log(`  ${id} (${entry.type}): ${links.length} links, ${resolved.length} resolved to active`)
      log(`    → ${resolved.slice(0, 5).join(', ')}${resolved.length > 5 ? ` ... +${resolved.length - 5} more` : ''}`)
    }

    // Backlinks: count only from active → active
    const backlinkCounts = new Map<string, number>()
    for (const [, entry] of activeEntries) {
      for (const link of (entry.links ?? []) as string[]) {
        if (activeIds.has(link)) {
          backlinkCounts.set(link, (backlinkCounts.get(link) ?? 0) + 1)
        }
      }
    }
    const topBacklinked = [...backlinkCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)

    log('\n--- Top 10 most back-linked active nodes ---')
    for (const [id, count] of topBacklinked) {
      const entry = raw.nodes[id]
      log(`  ${id} (${entry?.type}): ${count} backlinks — "${(entry?.description as string)?.slice(0, 80)}"`)
    }

    expect(byLinkCount.length).toBeGreaterThan(0)
  })

  it('traversal functions work on real graph', () => {
    clearGraphCache()

    // Use active-only backlink counts to pick a test node
    const backlinkCounts = new Map<string, number>()
    for (const [, entry] of activeEntries) {
      for (const link of (entry.links ?? []) as string[]) {
        if (activeIds.has(link)) {
          backlinkCounts.set(link, (backlinkCounts.get(link) ?? 0) + 1)
        }
      }
    }
    const topBacklinked = [...backlinkCounts.entries()]
      .sort(([, a], [, b]) => b - a)

    const testNodeId = topBacklinked[0]?.[0]
    expect(testNodeId).toBeDefined()
    if (!testNodeId) return

    log(`\n--- Traversal tests for "${testNodeId}" ---`)

    // Pass allEntries — the engine should filter archived internally
    const backlinks = getBacklinks(OMG_ROOT, allEntries, testNodeId)
    log(`  getBacklinks: ${backlinks.length} backlinks`)
    log(`    ${backlinks.slice(0, 5).join(', ')}${backlinks.length > 5 ? ` ... +${backlinks.length - 5} more` : ''}`)
    expect(backlinks.length).toBeGreaterThan(0)

    const fwd1 = getNeighbors(OMG_ROOT, allEntries, testNodeId, 'forward', 1)
    log(`  getNeighbors(forward, 1): ${fwd1.length} neighbors`)
    for (const n of fwd1.slice(0, 5)) {
      log(`    ${n.nodeId} (d=${n.distance}, dir=${n.direction}, score=${n.score.toFixed(3)}, type=${n.entry.type})`)
    }

    const bwd1 = getNeighbors(OMG_ROOT, allEntries, testNodeId, 'backward', 1)
    log(`  getNeighbors(backward, 1): ${bwd1.length} neighbors`)
    for (const n of bwd1.slice(0, 5)) {
      log(`    ${n.nodeId} (d=${n.distance}, dir=${n.direction}, score=${n.score.toFixed(3)}, type=${n.entry.type})`)
    }

    const both2 = getNeighbors(OMG_ROOT, allEntries, testNodeId, 'both', 2)
    log(`  getNeighbors(both, 2): ${both2.length} neighbors`)
    log(`    depth-1: ${both2.filter((n) => n.distance === 1).length}, depth-2: ${both2.filter((n) => n.distance === 2).length}`)
    log(`    forward: ${both2.filter((n) => n.direction === 'forward').length}, backward: ${both2.filter((n) => n.direction === 'backward').length}`)
    expect(both2.length).toBeGreaterThanOrEqual(fwd1.length)

    const subgraph = getSubgraph(OMG_ROOT, allEntries, [testNodeId], 2, 20)
    log(`  getSubgraph(depth=2, max=20): ${subgraph.nodeIds.length} nodes, ${subgraph.edges.length} edges`)
    log(`    nodes: ${subgraph.nodeIds.join(', ')}`)
    expect(subgraph.nodeIds).toContain(testNodeId)
    expect(subgraph.nodeIds.length).toBeLessThanOrEqual(20)
  })

  it('finds paths between top active nodes', () => {
    clearGraphCache()

    const backlinkCounts = new Map<string, number>()
    for (const [, entry] of activeEntries) {
      for (const link of (entry.links ?? []) as string[]) {
        if (activeIds.has(link)) {
          backlinkCounts.set(link, (backlinkCounts.get(link) ?? 0) + 1)
        }
      }
    }
    const topBacklinked = [...backlinkCounts.entries()]
      .sort(([, a], [, b]) => b - a)

    if (topBacklinked.length < 2) return

    const fromId = topBacklinked[0]![0]
    const toId = topBacklinked[1]![0]
    log(`\n--- findPaths("${fromId}" → "${toId}", depth=2) ---`)

    const t0 = performance.now()
    const paths = findPaths(OMG_ROOT, allEntries, fromId, toId, 2)
    const elapsed = performance.now() - t0

    log(`  Found ${paths.length} paths in ${elapsed.toFixed(1)}ms`)
    for (const p of paths.slice(0, 10)) {
      log(`    ${p.nodeIds.join(' → ')} (length=${p.length})`)
    }

    if (topBacklinked.length >= 5) {
      const from2 = topBacklinked[0]![0]
      const to2 = topBacklinked[4]![0]
      log(`\n--- findPaths("${from2}" → "${to2}", depth=2) ---`)
      const paths2 = findPaths(OMG_ROOT, allEntries, from2, to2, 2)
      log(`  Found ${paths2.length} paths`)
      for (const p of paths2.slice(0, 5)) {
        log(`    ${p.nodeIds.join(' → ')} (length=${p.length})`)
      }
    }
  })

  it('performance benchmarks', () => {
    const testNodeId = activeEntries[0]?.[0]
    if (!testNodeId) return

    clearGraphCache()
    const t0 = performance.now()
    getNeighbors(OMG_ROOT, allEntries, testNodeId, 'both', 2)
    const coldMs = performance.now() - t0

    const t1 = performance.now()
    getNeighbors(OMG_ROOT, allEntries, testNodeId, 'both', 2)
    const warmMs = performance.now() - t1

    log('\n--- Performance ---')
    log(`  Cold (build adjacency + traverse): ${coldMs.toFixed(1)}ms`)
    log(`  Warm (cached adjacency): ${warmMs.toFixed(1)}ms`)

    const t2 = performance.now()
    const top10 = activeEntries.slice(0, 10)
    const expanded = new Set<string>()
    for (const [id] of top10) {
      const neighbors = getNeighbors(OMG_ROOT, allEntries, id, 'both', 2)
      for (const n of neighbors) expanded.add(n.nodeId)
    }
    const expansionMs = performance.now() - t2
    log(`  Expansion (10 seeds, depth=2): ${expanded.size} unique neighbors in ${expansionMs.toFixed(1)}ms`)

    expect(coldMs).toBeLessThan(500)
    expect(warmMs).toBeLessThan(50)
  })
})
