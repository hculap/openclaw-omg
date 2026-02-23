/**
 * Pass 1 candidate generation for semantic dedup.
 * Registry-only — zero disk reads.
 */
import type { RegistryNodeEntry } from '../graph/registry.js'
import type { DedupConfig } from './types.js'
import { combinedSimilarity, keyPrefix } from './similarity.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A candidate pair of potentially duplicate nodes. */
export interface CandidatePair {
  readonly nodeIdA: string
  readonly nodeIdB: string
  readonly entryA: RegistryNodeEntry
  readonly entryB: RegistryNodeEntry
  readonly heuristicScore: number
}

/** A cluster of candidate duplicate nodes. */
export interface CandidateCluster {
  readonly nodeIds: readonly string[]
  readonly entries: Map<string, RegistryNodeEntry>
  readonly maxScore: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Node types excluded from dedup candidates. */
const EXCLUDED_TYPES = new Set(['moc', 'index', 'now', 'reflection'])

/** Volatile node types subject to the stale-days filter. */
const VOLATILE_TYPES = new Set(['episode', 'fact'])

// ---------------------------------------------------------------------------
// generateCandidatePairs
// ---------------------------------------------------------------------------

/**
 * Generates candidate pairs of potentially duplicate nodes using heuristic
 * similarity scoring. Registry-only — zero disk reads.
 *
 * Filtering stages:
 *   1. Skip archived, moc, index, now, reflection nodes
 *   2. Group by (type, keyPrefix)
 *   3. Pairwise combinedSimilarity within each bucket
 *   4. Incremental scope: at least one node updated >= lastDedupAt
 *   5. Stale filter: volatile types skip if > staleDaysThreshold apart
 *   6. Score threshold, cap per bucket
 */
export function generateCandidatePairs(
  entries: readonly [string, RegistryNodeEntry][],
  lastDedupAt: string | null,
  config: DedupConfig
): CandidatePair[] {
  const { similarityThreshold, maxPairsPerBucket, staleDaysThreshold, stableTypes } = config
  const stableTypeSet = new Set(stableTypes)

  // Step 1: Filter out ineligible nodes
  const eligible = entries.filter(([, e]) => {
    if (e.archived) return false
    if (EXCLUDED_TYPES.has(e.type)) return false
    return true
  })

  // Step 2: Group by (type, keyPrefix(canonicalKey))
  const buckets = new Map<string, [string, RegistryNodeEntry][]>()
  for (const [id, entry] of eligible) {
    const key = entry.canonicalKey ?? ''
    const prefix = keyPrefix(key)
    const bucketKey = `${entry.type}:${prefix}`
    const bucket = buckets.get(bucketKey) ?? []
    bucket.push([id, entry])
    buckets.set(bucketKey, bucket)
  }

  const result: CandidatePair[] = []

  // Step 3: Pairwise similarity within each bucket
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue

    let pairsInBucket = 0
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        if (pairsInBucket >= maxPairsPerBucket) break

        const [idA, entryA] = bucket[i]!
        const [idB, entryB] = bucket[j]!

        // Step 4: Incremental scope — at least one updated after lastDedupAt
        if (lastDedupAt !== null) {
          const bothOld = entryA.updated < lastDedupAt && entryB.updated < lastDedupAt
          if (bothOld) continue
        }

        // Step 5: Stale filter for volatile types
        if (VOLATILE_TYPES.has(entryA.type) && !stableTypeSet.has(entryA.type)) {
          const msA = new Date(entryA.updated).getTime()
          const msB = new Date(entryB.updated).getTime()
          const daysDiff = Math.abs(msA - msB) / (24 * 60 * 60 * 1000)
          if (daysDiff > staleDaysThreshold) continue
        }

        // Step 6: Compute heuristic score
        const score = combinedSimilarity(
          entryA.description,
          entryB.description,
          entryA.canonicalKey ?? '',
          entryB.canonicalKey ?? ''
        )

        if (score >= similarityThreshold) {
          result.push({ nodeIdA: idA, nodeIdB: idB, entryA, entryB, heuristicScore: score })
          pairsInBucket++
        }
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// clusterCandidates
// ---------------------------------------------------------------------------

/**
 * Clusters candidate pairs using single-linkage clustering.
 * Processes pairs in descending score order.
 * Caps cluster size at maxClusterSize and total clusters at maxClusters.
 */
export function clusterCandidates(
  pairs: readonly CandidatePair[],
  maxClusterSize: number,
  maxClusters: number
): CandidateCluster[] {
  if (pairs.length === 0) return []

  // Sort by score descending
  const sorted = [...pairs].sort((a, b) => b.heuristicScore - a.heuristicScore)

  // Union-Find for cluster membership
  const parent = new Map<string, string>()
  const clusterScores = new Map<string, number>()

  function find(id: string): string {
    if (!parent.has(id)) {
      parent.set(id, id)
    }
    const p = parent.get(id)!
    if (p !== id) {
      const root = find(p)
      parent.set(id, root)
      return root
    }
    return id
  }

  function union(a: string, b: string, score: number): void {
    const ra = find(a)
    const rb = find(b)
    if (ra === rb) return
    parent.set(rb, ra)
    // Propagate max score to root
    const existing = clusterScores.get(ra) ?? 0
    clusterScores.set(ra, Math.max(existing, score))
  }

  // Track cluster sizes to enforce maxClusterSize
  const clusterSizes = new Map<string, Set<string>>()

  function getClusterMembers(root: string): Set<string> {
    let set = clusterSizes.get(root)
    if (!set) {
      set = new Set([root])
      clusterSizes.set(root, set)
    }
    return set
  }

  for (const pair of sorted) {
    const { nodeIdA, nodeIdB, heuristicScore } = pair
    const ra = find(nodeIdA)
    const rb = find(nodeIdB)

    if (ra === rb) {
      // Already in same cluster — just track score
      const existing = clusterScores.get(ra) ?? 0
      clusterScores.set(ra, Math.max(existing, heuristicScore))
      continue
    }

    // Check combined size
    const membersA = getClusterMembers(ra)
    const membersB = getClusterMembers(rb)

    if (membersA.size + membersB.size > maxClusterSize) continue

    // Merge B into A
    union(nodeIdA, nodeIdB, heuristicScore)

    // Update cluster size tracking: merge membersB into membersA at new root
    const newRoot = find(nodeIdA)
    const merged = new Set([...getClusterMembers(newRoot === ra ? ra : rb), ...membersA, ...membersB])
    clusterSizes.set(newRoot, merged)

    const existing = clusterScores.get(newRoot) ?? 0
    clusterScores.set(newRoot, Math.max(existing, heuristicScore))
  }

  // Collect clusters from union-find
  const clusterMap = new Map<string, { nodeIds: string[]; entries: Map<string, RegistryNodeEntry>; maxScore: number }>()
  const allNodeIds = new Set<string>()
  for (const pair of sorted) {
    allNodeIds.add(pair.nodeIdA)
    allNodeIds.add(pair.nodeIdB)
  }

  for (const nodeId of allNodeIds) {
    const root = find(nodeId)
    if (!clusterMap.has(root)) {
      clusterMap.set(root, { nodeIds: [], entries: new Map(), maxScore: clusterScores.get(root) ?? 0 })
    }
    const cluster = clusterMap.get(root)!
    if (!cluster.nodeIds.includes(nodeId)) {
      cluster.nodeIds.push(nodeId)
    }
  }

  // Build entry maps
  const pairEntries = new Map<string, RegistryNodeEntry>()
  for (const pair of sorted) {
    pairEntries.set(pair.nodeIdA, pair.entryA)
    pairEntries.set(pair.nodeIdB, pair.entryB)
  }

  for (const cluster of clusterMap.values()) {
    for (const id of cluster.nodeIds) {
      const entry = pairEntries.get(id)
      if (entry) cluster.entries.set(id, entry)
    }
  }

  // Filter single-node clusters (shouldn't happen but guard)
  const validClusters = [...clusterMap.values()].filter((c) => c.nodeIds.length >= 2)

  // Sort by maxScore desc and cap at maxClusters
  validClusters.sort((a, b) => b.maxScore - a.maxScore)
  return validClusters.slice(0, maxClusters)
}
