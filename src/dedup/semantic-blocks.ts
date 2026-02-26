/**
 * Candidate blocking for semantic dedup.
 *
 * Groups post-literal-dedup survivors into blocks of potentially duplicate
 * nodes for batched LLM comparison. Uses heuristic pre-filtering to
 * minimize the number of LLM calls.
 *
 * Blocking criteria: same node type + same/adjacent domain + within time window.
 */
import type { RegistryNodeEntry } from '../graph/registry.js'
import type { SemanticBlock, SemanticDedupConfig } from './semantic-types.js'
import { combinedSimilarity } from './similarity.js'
import { resolvePrimaryDomain } from '../reflector/domain-resolver.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Node types excluded from semantic dedup (same as literal dedup). */
const EXCLUDED_TYPES = new Set(['moc', 'index', 'now', 'reflection'])

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates candidate blocks for semantic comparison.
 *
 * Algorithm:
 *   1. Filter: exclude archived, excluded types
 *   2. Group by (type, domain) — each group can produce blocks
 *   3. Within each group, build pairwise similarity scores
 *   4. Cluster high-scoring pairs into blocks respecting maxBlockSize
 *   5. Apply time window filter
 *   6. Cap total blocks at maxBlocksPerRun
 */
export function generateSemanticBlocks(
  entries: readonly [string, RegistryNodeEntry][],
  config: SemanticDedupConfig,
): readonly SemanticBlock[] {
  const { heuristicPrefilterThreshold, maxBlockSize, maxBlocksPerRun, timeWindowDays } = config

  // Step 1: Filter eligible entries
  const eligible = entries.filter(([, e]) => {
    if (e.archived) return false
    if (EXCLUDED_TYPES.has(e.type)) return false
    return true
  })

  if (eligible.length < 2) return []

  // Step 2: Group by (type, domain)
  const groups = new Map<string, [string, RegistryNodeEntry][]>()
  for (const entry of eligible) {
    const [, e] = entry
    const domain = resolvePrimaryDomain(e)
    const groupKey = `${e.type}:${domain}`
    const group = groups.get(groupKey) ?? []
    group.push(entry)
    groups.set(groupKey, group)
  }

  const timeWindowMs = timeWindowDays * 24 * 60 * 60 * 1000
  const blocks: SemanticBlock[] = []

  // Step 3-4: Within each group, find similar pairs and cluster
  for (const [groupKey, group] of groups) {
    if (group.length < 2) continue

    const domain = groupKey.split(':')[1] ?? 'misc'

    // Build adjacency list of high-scoring pairs
    const adjacency = new Map<string, Set<string>>()
    const pairScores = new Map<string, number>()

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [idA, entryA] = group[i]!
        const [idB, entryB] = group[j]!

        // Time window check
        const msA = new Date(entryA.updated).getTime()
        const msB = new Date(entryB.updated).getTime()
        if (Math.abs(msA - msB) > timeWindowMs) continue

        const score = combinedSimilarity(
          entryA.description,
          entryB.description,
          entryA.canonicalKey ?? '',
          entryB.canonicalKey ?? '',
        )

        if (score >= heuristicPrefilterThreshold) {
          const adjA = adjacency.get(idA) ?? new Set()
          adjA.add(idB)
          adjacency.set(idA, adjA)

          const adjB = adjacency.get(idB) ?? new Set()
          adjB.add(idA)
          adjacency.set(idB, adjB)

          pairScores.set(`${idA}:${idB}`, score)
        }
      }
    }

    // Greedy clustering: pick node with most connections, expand to maxBlockSize
    const assigned = new Set<string>()

    while (adjacency.size > 0 && blocks.length < maxBlocksPerRun) {
      // Find node with most unassigned neighbors
      let bestNode = ''
      let bestDegree = 0
      for (const [nodeId, neighbors] of adjacency) {
        if (assigned.has(nodeId)) continue
        const unassignedCount = [...neighbors].filter((n) => !assigned.has(n)).length
        if (unassignedCount > bestDegree) {
          bestDegree = unassignedCount
          bestNode = nodeId
        }
      }

      if (bestNode === '' || bestDegree === 0) break

      // Build block starting from bestNode
      const blockIds = [bestNode]
      assigned.add(bestNode)
      const neighbors = adjacency.get(bestNode) ?? new Set()

      for (const neighborId of neighbors) {
        if (assigned.has(neighborId)) continue
        if (blockIds.length >= maxBlockSize) break
        blockIds.push(neighborId)
        assigned.add(neighborId)
      }

      if (blockIds.length < 2) continue

      // Build entry map and compute max score
      const entryMap = new Map<string, RegistryNodeEntry>()
      let maxScore = 0
      for (const id of blockIds) {
        const entry = group.find(([gid]) => gid === id)
        if (entry) entryMap.set(id, entry[1])
      }
      for (let i = 0; i < blockIds.length; i++) {
        for (let j = i + 1; j < blockIds.length; j++) {
          const key1 = `${blockIds[i]}:${blockIds[j]}`
          const key2 = `${blockIds[j]}:${blockIds[i]}`
          const score = pairScores.get(key1) ?? pairScores.get(key2) ?? 0
          if (score > maxScore) maxScore = score
        }
      }

      blocks.push({
        nodeIds: blockIds,
        entries: entryMap,
        domain,
        maxHeuristicScore: maxScore,
      })

      // Remove assigned nodes from adjacency
      for (const id of blockIds) {
        adjacency.delete(id)
        for (const neighbors of adjacency.values()) {
          neighbors.delete(id)
        }
      }
    }
  }

  // Sort by maxHeuristicScore descending and cap
  return [...blocks]
    .sort((a, b) => b.maxHeuristicScore - a.maxHeuristicScore)
    .slice(0, maxBlocksPerRun)
}
