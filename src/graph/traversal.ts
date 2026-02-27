/**
 * traversal.ts — In-memory graph traversal engine for the OMG knowledge graph.
 *
 * Builds forward + backward adjacency maps from registry entries' `links[]`
 * fields, then exposes traversal primitives: neighbors, backlinks, subgraph,
 * and path discovery.
 *
 * Design:
 * - Pure functions that take `registryEntries` as parameter (available at all
 *   call sites — no coupling to the registry loading mechanism).
 * - Adjacency maps are cached per `omgRoot` and invalidated when the entry
 *   count changes or via explicit `clearGraphCache()`.
 * - Scoring mirrors `selector.ts:computeRegistryScore` exactly so that
 *   graph-expanded candidates are comparable with keyword-scored candidates.
 */

import type { RegistryNodeEntry } from './registry.js'
import type {
  TraversalNeighbor,
  TraversalEdge,
  TraversalSubgraph,
  TraversalPath,
  TraversalDirection,
  AdjacencyCache,
} from './traversal-types.js'

// ---------------------------------------------------------------------------
// Scoring constants (mirrored from selector.ts)
// ---------------------------------------------------------------------------

const PRIORITY_WEIGHT: Readonly<Record<string, number>> = {
  high: 1.5,
  medium: 1.0,
  low: 0.7,
}

const DISTANCE_DECAY: Readonly<Record<1 | 2, number>> = {
  1: 1.0,
  2: 0.6,
}

// ---------------------------------------------------------------------------
// Module-level adjacency cache
// ---------------------------------------------------------------------------

const adjacencyCache = new Map<string, AdjacencyCache>()

// ---------------------------------------------------------------------------
// Adjacency construction
// ---------------------------------------------------------------------------

/**
 * Builds forward and backward adjacency maps from registry entries.
 *
 * Forward: nodeId → set of nodeIds it links to (outgoing edges).
 * Backward: nodeId → set of nodeIds that link to it (incoming edges).
 *
 * Only links that reference existing, non-archived nodes are included.
 * Archived entries are excluded from the graph entirely.
 */
function buildAdjacency(
  entries: readonly [string, RegistryNodeEntry][]
): AdjacencyCache {
  const activeEntries = entries.filter(([, e]) => !e.archived)
  const nodeIds = new Set(activeEntries.map(([id]) => id))
  const forward = new Map<string, Set<string>>()
  const backward = new Map<string, Set<string>>()

  // Initialize empty sets for all nodes
  for (const id of nodeIds) {
    forward.set(id, new Set())
    backward.set(id, new Set())
  }

  for (const [id, entry] of activeEntries) {
    const links = entry.links ?? []
    for (const targetId of links) {
      if (!nodeIds.has(targetId)) continue
      if (targetId === id) continue // skip self-links

      forward.get(id)!.add(targetId)
      backward.get(targetId)!.add(id)
    }
  }

  return {
    forward,
    backward,
    entryCount: entries.length,
  }
}

/**
 * Returns the cached adjacency for an omgRoot, rebuilding if stale.
 * Staleness: entry count changed → full rebuild.
 */
function getAdjacency(
  omgRoot: string,
  entries: readonly [string, RegistryNodeEntry][]
): AdjacencyCache {
  const cached = adjacencyCache.get(omgRoot)
  if (cached && cached.entryCount === entries.length) return cached

  const fresh = buildAdjacency(entries)
  adjacencyCache.set(omgRoot, fresh)
  return fresh
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function computeRecencyFactor(updatedIso: string): number {
  const ts = new Date(updatedIso).getTime()
  if (isNaN(ts)) return 0.5
  const ageDays = (Date.now() - ts) / 86_400_000
  return Math.max(0.5, 1.0 - ageDays * 0.02)
}

function computeNeighborScore(
  entry: RegistryNodeEntry,
  distance: 1 | 2,
  keywords: ReadonlySet<string>
): number {
  const priorityWeight = PRIORITY_WEIGHT[entry.priority] ?? 1.0
  const recencyFactor = computeRecencyFactor(entry.updated)
  const keywordMatch = computeKeywordMatch(entry, keywords)
  return keywordMatch * priorityWeight * recencyFactor * DISTANCE_DECAY[distance]
}

function computeKeywordMatch(
  entry: RegistryNodeEntry,
  keywords: ReadonlySet<string>
): number {
  if (keywords.size === 0) return 1.0
  const tags = (entry.tags ?? []).map((t) => t.toLowerCase())
  const text = `${entry.description} ${entry.canonicalKey ?? ''} ${tags.join(' ')}`.toLowerCase()
  let matches = 0
  for (const kw of keywords) {
    if (text.includes(kw)) matches++
  }
  return 1.0 + matches * 0.5
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns neighbors of a node up to the given depth.
 *
 * - `direction: 'forward'` — follows outgoing links only
 * - `direction: 'backward'` — follows incoming links only
 * - `direction: 'both'` — follows both
 *
 * Results are sorted by score (descending). Unknown nodeId → empty array.
 */
export function getNeighbors(
  omgRoot: string,
  entries: readonly [string, RegistryNodeEntry][],
  nodeId: string,
  direction: TraversalDirection,
  depth: 1 | 2,
  keywords: ReadonlySet<string> = new Set()
): readonly TraversalNeighbor[] {
  const adjacency = getAdjacency(omgRoot, entries)
  const entryMap = new Map(entries)
  const results: TraversalNeighbor[] = []
  const visited = new Set<string>([nodeId])

  // Depth-1 neighbors
  const depth1Ids = collectDirectNeighbors(adjacency, nodeId, direction)

  for (const neighborId of depth1Ids) {
    if (visited.has(neighborId)) continue
    visited.add(neighborId)

    const entry = entryMap.get(neighborId)
    if (!entry) continue

    const neighborDirection = inferDirection(adjacency, nodeId, neighborId)
    results.push({
      nodeId: neighborId,
      entry,
      distance: 1,
      direction: neighborDirection,
      score: computeNeighborScore(entry, 1, keywords),
    })
  }

  // Depth-2 neighbors (if requested)
  if (depth === 2) {
    for (const depth1Id of depth1Ids) {
      const depth2Ids = collectDirectNeighbors(adjacency, depth1Id, direction)
      for (const neighborId of depth2Ids) {
        if (visited.has(neighborId)) continue
        visited.add(neighborId)

        const entry = entryMap.get(neighborId)
        if (!entry) continue

        const neighborDirection = inferDirection(adjacency, depth1Id, neighborId)
        results.push({
          nodeId: neighborId,
          entry,
          distance: 2,
          direction: neighborDirection,
          score: computeNeighborScore(entry, 2, keywords),
        })
      }
    }
  }

  return results.sort((a, b) => b.score - a.score)
}

/**
 * Returns IDs of all nodes that link to the given node (incoming edges).
 * Unknown nodeId → empty array.
 */
export function getBacklinks(
  omgRoot: string,
  entries: readonly [string, RegistryNodeEntry][],
  nodeId: string
): readonly string[] {
  const adjacency = getAdjacency(omgRoot, entries)
  const backlinks = adjacency.backward.get(nodeId)
  return backlinks ? [...backlinks] : []
}

/**
 * Extracts a connected subgraph starting from seed nodes, expanding via
 * BFS up to `maxDepth` hops and capped at `maxNodes` total.
 */
export function getSubgraph(
  omgRoot: string,
  entries: readonly [string, RegistryNodeEntry][],
  seedNodeIds: readonly string[],
  maxDepth: 1 | 2,
  maxNodes: number
): TraversalSubgraph {
  const adjacency = getAdjacency(omgRoot, entries)
  const nodeIds = new Set<string>()
  const edges: TraversalEdge[] = []
  const visited = new Set<string>()

  // BFS queue: [nodeId, currentDepth]
  const queue: Array<[string, number]> = []

  // Seed the BFS — only include seeds that exist in the registry
  const allNodeIds = new Set(entries.map(([id]) => id))
  for (const seedId of seedNodeIds) {
    if (!allNodeIds.has(seedId)) continue
    if (visited.has(seedId)) continue
    visited.add(seedId)
    nodeIds.add(seedId)
    queue.push([seedId, 0])
    if (nodeIds.size >= maxNodes) break
  }

  // BFS expansion
  while (queue.length > 0 && nodeIds.size < maxNodes) {
    const [currentId, currentDepth] = queue.shift()!
    if (currentDepth >= maxDepth) continue

    const forwardNeighbors = adjacency.forward.get(currentId) ?? new Set()
    const backwardNeighbors = adjacency.backward.get(currentId) ?? new Set()

    for (const neighborId of forwardNeighbors) {
      edges.push({ fromId: currentId, toId: neighborId })
      if (visited.has(neighborId)) continue
      visited.add(neighborId)
      nodeIds.add(neighborId)
      if (nodeIds.size >= maxNodes) break
      queue.push([neighborId, currentDepth + 1])
    }

    if (nodeIds.size >= maxNodes) break

    for (const neighborId of backwardNeighbors) {
      edges.push({ fromId: neighborId, toId: currentId })
      if (visited.has(neighborId)) continue
      visited.add(neighborId)
      nodeIds.add(neighborId)
      if (nodeIds.size >= maxNodes) break
      queue.push([neighborId, currentDepth + 1])
    }
  }

  // Deduplicate edges
  const edgeSet = new Set(edges.map((e) => `${e.fromId}→${e.toId}`))
  const uniqueEdges: TraversalEdge[] = [...edgeSet].map((key) => {
    const sepIdx = key.indexOf('→')
    return { fromId: key.slice(0, sepIdx), toId: key.slice(sepIdx + 1) }
  })

  return {
    nodeIds: [...nodeIds],
    edges: uniqueEdges,
  }
}

/**
 * Finds all paths from `fromId` to `toId` up to `maxDepth` hops.
 * Uses DFS with cycle detection. Returns empty array if no path exists.
 */
export function findPaths(
  omgRoot: string,
  entries: readonly [string, RegistryNodeEntry][],
  fromId: string,
  toId: string,
  maxDepth: 1 | 2
): readonly TraversalPath[] {
  const adjacency = getAdjacency(omgRoot, entries)
  const allNodeIds = new Set(entries.map(([id]) => id))

  if (!allNodeIds.has(fromId) || !allNodeIds.has(toId)) return []
  if (fromId === toId) return [{ nodeIds: [fromId], length: 0 }]

  const results: TraversalPath[] = []
  const visited = new Set<string>([fromId])

  function dfs(currentId: string, path: string[], depth: number): void {
    if (depth > maxDepth) return

    const neighbors = adjacency.forward.get(currentId) ?? new Set()
    for (const neighborId of neighbors) {
      if (neighborId === toId) {
        const fullPath = [...path, neighborId]
        results.push({ nodeIds: fullPath, length: fullPath.length - 1 })
        continue
      }
      if (visited.has(neighborId)) continue
      if (depth + 1 >= maxDepth) continue // can't reach target in remaining hops

      visited.add(neighborId)
      dfs(neighborId, [...path, neighborId], depth + 1)
      visited.delete(neighborId)
    }
  }

  dfs(fromId, [fromId], 0)
  return results
}

/**
 * Clears the adjacency cache. Called when registry data changes.
 * If `omgRoot` is provided, clears only that entry; otherwise clears all.
 */
export function clearGraphCache(omgRoot?: string): void {
  if (omgRoot) {
    adjacencyCache.delete(omgRoot)
  } else {
    adjacencyCache.clear()
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function collectDirectNeighbors(
  adjacency: AdjacencyCache,
  nodeId: string,
  direction: TraversalDirection
): Set<string> {
  const result = new Set<string>()

  if (direction === 'forward' || direction === 'both') {
    const forward = adjacency.forward.get(nodeId)
    if (forward) {
      for (const id of forward) result.add(id)
    }
  }

  if (direction === 'backward' || direction === 'both') {
    const backward = adjacency.backward.get(nodeId)
    if (backward) {
      for (const id of backward) result.add(id)
    }
  }

  return result
}

/**
 * Infers the primary direction of a neighbor relative to the source node.
 * If `sourceId` links to `neighborId` → 'forward'.
 * If `neighborId` links to `sourceId` → 'backward'.
 * If both (bidirectional), prefers 'forward'.
 */
function inferDirection(
  adjacency: AdjacencyCache,
  sourceId: string,
  neighborId: string
): 'forward' | 'backward' {
  const isForward = adjacency.forward.get(sourceId)?.has(neighborId) ?? false
  return isForward ? 'forward' : 'backward'
}
