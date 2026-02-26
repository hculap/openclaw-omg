/**
 * Optional post-processing step that splits oversized clusters by anchor link.
 *
 * When a cluster still exceeds the token budget after time-based splitting,
 * this function partitions it by the most-common link target, producing
 * two or more sub-clusters.
 */

import type { RegistryNodeEntry } from '../graph/registry.js'
import type { ReflectionCluster } from './time-clusterer.js'
import { estimateTokens } from '../utils/tokens.js'

/**
 * Splits a cluster into sub-clusters based on the most-common link target.
 *
 * Strategy:
 *   1. Count link targets across all nodes in the cluster.
 *   2. Pick the most-common link as the "anchor".
 *   3. Partition into "has anchor link" and "no anchor link".
 *   4. Recurse on sub-clusters that still exceed maxTokens.
 *
 * Returns the original cluster unchanged if it already fits or has ≤2 nodes.
 */
export function splitByAnchor(
  cluster: ReflectionCluster,
  entries: ReadonlyMap<string, RegistryNodeEntry>,
  maxTokens: number,
): readonly ReflectionCluster[] {
  if (cluster.estimatedTokens <= maxTokens || cluster.nodeIds.length <= 2) {
    return [cluster]
  }

  // Count link targets
  const linkCounts = new Map<string, number>()
  for (const nodeId of cluster.nodeIds) {
    const entry = entries.get(nodeId)
    if (!entry) continue
    for (const link of entry.links ?? []) {
      linkCounts.set(link, (linkCounts.get(link) ?? 0) + 1)
    }
  }

  if (linkCounts.size === 0) {
    return [cluster]
  }

  // Find the anchor (most common link)
  let anchor = ''
  let maxCount = 0
  for (const [link, count] of linkCounts) {
    if (count > maxCount) {
      anchor = link
      maxCount = count
    }
  }

  // Only split if the anchor appears in at least 2 nodes and doesn't cover all of them
  if (maxCount < 2 || maxCount >= cluster.nodeIds.length) {
    return [cluster]
  }

  // Partition by anchor
  const withAnchor: string[] = []
  const withoutAnchor: string[] = []
  let withAnchorTokens = 0
  let withoutAnchorTokens = 0

  for (const nodeId of cluster.nodeIds) {
    const entry = entries.get(nodeId)
    const entryTokens = entry ? estimateEntryTokens(entry) : 0
    const hasAnchor = entry?.links?.includes(anchor) ?? false

    if (hasAnchor) {
      withAnchor.push(nodeId)
      withAnchorTokens += entryTokens
    } else {
      withoutAnchor.push(nodeId)
      withoutAnchorTokens += entryTokens
    }
  }

  const subClusters: ReflectionCluster[] = []

  if (withAnchor.length > 0) {
    const sub: ReflectionCluster = {
      domain: cluster.domain,
      timeRange: cluster.timeRange,
      nodeIds: withAnchor,
      estimatedTokens: withAnchorTokens,
    }
    // Recurse if still too large
    subClusters.push(...splitByAnchor(sub, entries, maxTokens))
  }

  if (withoutAnchor.length > 0) {
    const sub: ReflectionCluster = {
      domain: cluster.domain,
      timeRange: cluster.timeRange,
      nodeIds: withoutAnchor,
      estimatedTokens: withoutAnchorTokens,
    }
    subClusters.push(...splitByAnchor(sub, entries, maxTokens))
  }

  return subClusters
}

function estimateEntryTokens(entry: RegistryNodeEntry): number {
  const descTokens = estimateTokens(entry.description)
  const tagTokens = (entry.tags ?? []).reduce((sum, t) => sum + estimateTokens(t), 0)
  const linkTokens = (entry.links ?? []).reduce((sum, l) => sum + estimateTokens(l), 0)
  return descTokens * 8 + tagTokens + linkTokens
}
