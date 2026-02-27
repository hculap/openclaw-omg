/**
 * retrieval.ts — Hybrid retrieval for merge target discovery.
 *
 * Finds existing nodes that are semantically close to an ExtractCandidate,
 * combining local similarity (always available) with semantic search (optional).
 *
 * Algorithm:
 *   1. Local pass:  filter registry by type/key-prefix, score via combinedSimilarity
 *   2. Semantic:    query memory_search if available, normalize scores
 *   3. Union + weighted score:  finalScore = localWeight * localScore + semanticWeight * semanticScore + boosts
 *   4. Return top K above mergeThreshold
 */

import type { ExtractCandidate, ScoredMergeTarget } from '../types.js'
import type { RegistryNodeEntry } from '../graph/registry.js'
import type { MemoryTools } from '../context/memory-search.js'
import { combinedSimilarity, keyPrefix } from '../dedup/similarity.js'
import { buildSemanticCandidates } from '../context/memory-search.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the merge retrieval pass. */
export interface MergeRetrievalConfig {
  readonly localTopM: number       // Top M from local scoring (default 50)
  readonly semanticTopS: number    // Top S from semantic search (default 20)
  readonly finalTopK: number       // Final top K returned (default 7)
  readonly localWeight: number     // Weight for local score (default 0.6)
  readonly semanticWeight: number  // Weight for semantic score (default 0.4)
  readonly mergeThreshold: number  // Minimum finalScore to be included (default 0.4)
}

/** Default config values. */
export const DEFAULT_MERGE_RETRIEVAL_CONFIG: MergeRetrievalConfig = {
  localTopM: 50,
  semanticTopS: 20,
  finalTopK: 7,
  localWeight: 0.6,
  semanticWeight: 0.4,
  mergeThreshold: 0.4,
}

// ---------------------------------------------------------------------------
// findMergeTargets
// ---------------------------------------------------------------------------

/**
 * Finds existing registry nodes that are close enough to the given candidate
 * to be considered merge targets.
 *
 * Returns up to `config.finalTopK` nodes with `finalScore >= config.mergeThreshold`,
 * sorted by finalScore descending.
 *
 * Falls back to local-only scoring when `memoryTools` is null.
 */
export async function findMergeTargets(
  candidate: ExtractCandidate,
  registryEntries: readonly [string, RegistryNodeEntry][],
  memoryTools: MemoryTools | null,
  config: MergeRetrievalConfig = DEFAULT_MERGE_RETRIEVAL_CONFIG
): Promise<readonly ScoredMergeTarget[]> {
  if (registryEntries.length === 0) {
    return []
  }

  const candidateKeyPrefix = keyPrefix(candidate.canonicalKey)

  // ── Pass 1: Local similarity ─────────────────────────────────────────────
  // Filter to same type and key-prefix, then score by combinedSimilarity.
  const localScores = new Map<string, number>()

  for (const [nodeId, entry] of registryEntries) {
    if (entry.archived) continue
    if (entry.type !== candidate.type) continue

    const entryKeyPrefix = keyPrefix(entry.canonicalKey ?? '')
    if (entryKeyPrefix !== candidateKeyPrefix) continue

    const score = combinedSimilarity(
      candidate.description,
      entry.description,
      candidate.canonicalKey,
      entry.canonicalKey ?? ''
    )
    localScores.set(nodeId, score)
  }

  // Take top M by local score
  const sortedLocal = [...localScores.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, config.localTopM)

  // ── Pass 2: Semantic search (optional) ───────────────────────────────────
  const semanticScores = new Map<string, number>()

  if (memoryTools !== null) {
    const query = `${candidate.title} ${candidate.canonicalKey} ${candidate.description}`
    try {
      const response = await memoryTools.search(query)
      if (response !== null && !response.disabled) {
        const semanticCandidates = buildSemanticCandidates(response, 0)

        // Build a lookup from filePath → nodeId using registry entries
        const filePathToNodeId = new Map<string, string>()
        for (const [nodeId, entry] of registryEntries) {
          filePathToNodeId.set(entry.filePath, nodeId)
        }

        // Take top S semantic results that map to known registry nodes
        let semanticCount = 0
        for (const sc of semanticCandidates) {
          if (semanticCount >= config.semanticTopS) break
          const nodeId = filePathToNodeId.get(sc.filePath)
          if (nodeId !== undefined) {
            semanticScores.set(nodeId, sc.semanticScore)
            semanticCount++
          }
        }
      }
    } catch (err) {
      // Semantic search failure is non-fatal — degrade to local-only
      console.error(
        `[omg] retrieval: semantic search failed for candidate "${candidate.canonicalKey}" — degrading to local-only:`,
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  // ── Pass 3: Union + weighted score + boosts ───────────────────────────────
  const now = Date.now()
  const candidates: ScoredMergeTarget[] = []

  // Build registry map for quick lookup
  const registryMap = new Map(registryEntries)

  // Union of nodeIds from local and semantic passes
  const allNodeIds = new Set([
    ...sortedLocal.map(([id]) => id),
    ...semanticScores.keys(),
  ])

  for (const nodeId of allNodeIds) {
    const entry = registryMap.get(nodeId)
    if (!entry) continue

    const localScore = localScores.get(nodeId) ?? 0
    const semanticScore = semanticScores.get(nodeId) ?? 0

    let finalScore = config.localWeight * localScore + config.semanticWeight * semanticScore

    // Boosts
    if (entry.priority === 'high') finalScore += 0.1
    if (isRecentEntry(entry.updated, now, 7)) finalScore += 0.05
    if (entry.type === candidate.type) finalScore += 0.05

    if (finalScore >= config.mergeThreshold) {
      candidates.push({ nodeId, entry, localScore, semanticScore, finalScore })
    }
  }

  // Sort by finalScore descending, take top K
  return candidates
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, config.finalTopK)
}

// ---------------------------------------------------------------------------
// shouldMerge
// ---------------------------------------------------------------------------

/**
 * Returns true when the highest-scoring target exceeds the merge threshold.
 * Callers use this to gate the (more expensive) Merge LLM call.
 */
export function shouldMerge(targets: readonly ScoredMergeTarget[], threshold: number): boolean {
  return targets.length > 0 && targets[0]!.finalScore >= threshold
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns true if the ISO date string is within `days` days of `now`. */
function isRecentEntry(updated: string, now: number, days: number): boolean {
  try {
    const updatedMs = new Date(updated).getTime()
    return (now - updatedMs) <= days * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}
