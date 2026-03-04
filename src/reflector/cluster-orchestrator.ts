/**
 * Cluster orchestrator — wires domain resolution, time clustering,
 * optional anchor splitting, node hydration, and compact packet building
 * into a single pipeline producing hydrated clusters ready for reflection.
 */

import type { RegistryNodeEntry } from '../graph/registry.js'
import { getRegistryEntries } from '../graph/registry.js'
import type { OmgConfig } from '../config.js'
import type { GraphNode } from '../types.js'
import { assignDomains } from './domain-resolver.js'
import { createTimeClusters, type ClusteringConfig, type ReflectionCluster } from './time-clusterer.js'
import { splitByAnchor } from './anchor-split.js'
import { buildCompactPacket, type CompactNodePacket } from './compact-packet.js'
import { combinedSimilarity } from '../dedup/similarity.js'

/** A fully hydrated cluster with nodes and compact packets, ready for reflection. */
export interface HydratedCluster {
  readonly domain: string
  readonly timeRange: { readonly start: string; readonly end: string }
  readonly nodes: readonly GraphNode[]
  readonly compactPackets: readonly CompactNodePacket[]
  readonly estimatedTokens: number
}

/**
 * Builds hydrated reflection clusters from registry entries.
 *
 * Flow:
 *   1. assignDomains → group entries by domain
 *   2. createTimeClusters per domain → time-windowed clusters
 *   3. Optional splitByAnchor → split oversized clusters
 *   4. Hydrate nodes from disk
 *   5. buildCompactPacket per node
 *
 * Returns empty array if no entries or all hydrations fail.
 */
export async function buildReflectionClusters(
  entries: readonly [string, RegistryNodeEntry][],
  config: OmgConfig,
  hydrateNode: (filePath: string) => Promise<GraphNode | null>,
  omgRoot?: string,
): Promise<readonly HydratedCluster[]> {
  if (entries.length === 0) return []

  const clustering = config.reflection.clustering
  const clusterConfig: ClusteringConfig = {
    windowSpanDays: clustering.windowSpanDays,
    maxNodesPerCluster: clustering.maxNodesPerCluster,
    maxInputTokensPerCluster: clustering.maxInputTokensPerCluster,
  }

  // Step 1: Group entries by domain
  const domainGroups = assignDomains(entries)

  // Step 2: Create time clusters per domain
  let allClusters: ReflectionCluster[] = []
  for (const [domain, domainEntries] of domainGroups) {
    const clusters = createTimeClusters(domain, domainEntries, clusterConfig)
    allClusters.push(...clusters)
  }

  // Step 3: Optional anchor split
  if (clustering.enableAnchorSplit) {
    const entryMap = new Map(entries)
    const split: ReflectionCluster[] = []
    for (const cluster of allClusters) {
      split.push(...splitByAnchor(cluster, entryMap, clusterConfig.maxInputTokensPerCluster))
    }
    allClusters = split
  }

  // Step 3.5: Consolidation guard — skip clusters that duplicate existing reflections
  const consolidation = clustering.consolidation
  if (consolidation.enabled && omgRoot) {
    const consolidated = await filterConsolidatedClusters(
      allClusters,
      entries,
      omgRoot,
      consolidation.similarityThreshold,
      clustering.windowSpanDays,
    )
    allClusters = consolidated
  }

  // Step 4+5: Hydrate nodes and build compact packets
  const hydratedClusters: HydratedCluster[] = []

  // Build a lookup from nodeId → entry for file path resolution
  const entryById = new Map(entries)

  for (const cluster of allClusters) {
    const nodes: GraphNode[] = []
    let hydrationFailures = 0
    for (const nodeId of cluster.nodeIds) {
      const entry = entryById.get(nodeId)
      if (!entry) continue
      try {
        const node = await hydrateNode(entry.filePath)
        if (node) {
          nodes.push(node)
        } else {
          hydrationFailures++
        }
      } catch (err) {
        hydrationFailures++
        console.warn(
          `[omg] cluster-orchestrator: failed to hydrate node "${nodeId}" at ${entry.filePath}:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    if (hydrationFailures > 0) {
      console.warn(
        `[omg] cluster-orchestrator: ${hydrationFailures}/${cluster.nodeIds.length} node(s) ` +
        `failed hydration in cluster ${cluster.domain}`,
      )
    }

    if (nodes.length === 0) continue

    const compactPackets = nodes.map(buildCompactPacket)

    hydratedClusters.push({
      domain: cluster.domain,
      timeRange: cluster.timeRange,
      nodes,
      compactPackets,
      estimatedTokens: cluster.estimatedTokens,
    })
  }

  return hydratedClusters
}

// ---------------------------------------------------------------------------
// Consolidation guard
// ---------------------------------------------------------------------------

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Filters out clusters whose content is highly similar to an existing
 * reflection in the same domain within the time window.
 */
async function filterConsolidatedClusters(
  clusters: readonly ReflectionCluster[],
  inputEntries: readonly [string, RegistryNodeEntry][],
  omgRoot: string,
  similarityThreshold: number,
  windowSpanDays: number,
): Promise<ReflectionCluster[]> {
  let existingReflections: readonly [string, RegistryNodeEntry][]
  try {
    existingReflections = await getRegistryEntries(omgRoot, { type: 'reflection' })
  } catch {
    return [...clusters]
  }

  if (existingReflections.length === 0) return [...clusters]

  const entryById = new Map(inputEntries)
  const windowMs = windowSpanDays * MILLISECONDS_PER_DAY
  const survivors: ReflectionCluster[] = []

  for (const cluster of clusters) {
    // Build a combined description from the cluster's input nodes
    const clusterDescriptions = cluster.nodeIds
      .map((id) => entryById.get(id)?.description ?? '')
      .filter((d) => d.length > 0)
    const clusterSummary = clusterDescriptions.join(' | ')

    // Check against existing reflections in the same domain within the time window
    let isDuplicate = false
    for (const [, refEntry] of existingReflections) {
      // Domain match: check if the reflection's tags/links suggest the same domain
      const refDomain = refEntry.links
        ?.find((l) => l.startsWith('omg/moc-'))
        ?.replace('omg/moc-', '') ?? ''
      if (refDomain !== cluster.domain && refDomain !== '') continue

      // Time window check
      const refUpdatedMs = new Date(refEntry.updated).getTime()
      const clusterStartMs = new Date(cluster.timeRange.start).getTime()
      if (Math.abs(refUpdatedMs - clusterStartMs) > windowMs) continue

      // Similarity check
      const sim = combinedSimilarity(
        clusterSummary,
        refEntry.description,
        cluster.domain,
        refDomain,
      )
      if (sim >= similarityThreshold) {
        isDuplicate = true
        console.warn(
          `[omg] cluster-orchestrator: consolidation guard skipped cluster ` +
          `${cluster.domain} (${cluster.timeRange.start}..${cluster.timeRange.end}) — ` +
          `similar to existing reflection (similarity: ${(sim * 100).toFixed(1)}%)`,
        )
        break
      }
    }

    if (!isDuplicate) {
      survivors.push(cluster)
    }
  }

  return survivors
}
