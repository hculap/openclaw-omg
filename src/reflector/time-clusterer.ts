/**
 * Groups domain-scoped registry entries into time-windowed clusters
 * for bounded reflection passes.
 *
 * Algorithm:
 *   1. Sort entries by `updatedAt` ascending.
 *   2. Walk entries, accumulating into the current window.
 *   3. Split when: updatedAt - windowStart > windowSpanDays,
 *      OR estimatedTokens > maxInputTokensPerCluster,
 *      OR nodeCount >= maxNodesPerCluster.
 */

import type { RegistryNodeEntry } from '../graph/registry.js'
import { estimateTokens } from '../utils/tokens.js'

/** Configuration for the time-based clustering algorithm. */
export interface ClusteringConfig {
  readonly windowSpanDays: number
  readonly maxNodesPerCluster: number
  readonly maxInputTokensPerCluster: number
}

/** A cluster of node IDs scoped to a domain and time range. */
export interface ReflectionCluster {
  readonly domain: string
  readonly timeRange: { readonly start: string; readonly end: string }
  readonly nodeIds: readonly string[]
  readonly estimatedTokens: number
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Estimates the token footprint of a registry entry for budget purposes.
 * Uses description length as a proxy (body is not available at this stage).
 * A multiplier accounts for the fact that body is typically 5-10x longer.
 */
function estimateEntryTokens(entry: RegistryNodeEntry): number {
  const descTokens = estimateTokens(entry.description)
  // Tags and links contribute small amounts
  const tagTokens = (entry.tags ?? []).reduce((sum, t) => sum + estimateTokens(t), 0)
  const linkTokens = (entry.links ?? []).reduce((sum, l) => sum + estimateTokens(l), 0)
  // Heuristic: description-based estimate × 8 to approximate body
  return descTokens * 8 + tagTokens + linkTokens
}

/**
 * Creates time-windowed clusters for a single domain's entries.
 *
 * Entries are sorted by `updated` ascending, then grouped into clusters
 * that respect the time window, node count, and token budget constraints.
 *
 * Returns an empty array if entries is empty.
 */
export function createTimeClusters(
  domain: string,
  entries: readonly [string, RegistryNodeEntry][],
  config: ClusteringConfig,
): readonly ReflectionCluster[] {
  if (entries.length === 0) return []

  // Sort by updated ascending
  const sorted = [...entries].sort(([, a], [, b]) => a.updated.localeCompare(b.updated))

  const clusters: ReflectionCluster[] = []
  let currentIds: string[] = []
  let currentTokens = 0
  let windowStart: number | null = null
  let firstUpdate = ''
  let lastUpdate = ''

  function flushCluster(): void {
    if (currentIds.length === 0) return
    clusters.push({
      domain,
      timeRange: { start: firstUpdate, end: lastUpdate },
      nodeIds: [...currentIds],
      estimatedTokens: currentTokens,
    })
    currentIds = []
    currentTokens = 0
    windowStart = null
    firstUpdate = ''
    lastUpdate = ''
  }

  for (const [id, entry] of sorted) {
    const updatedMs = new Date(entry.updated).getTime()
    const entryTokens = estimateEntryTokens(entry)

    // Check if adding this entry would exceed constraints
    const exceedsTimeWindow = windowStart !== null && (updatedMs - windowStart) > config.windowSpanDays * MS_PER_DAY
    const exceedsTokenBudget = currentTokens + entryTokens > config.maxInputTokensPerCluster && currentIds.length > 0
    const exceedsNodeCount = currentIds.length >= config.maxNodesPerCluster

    if (exceedsTimeWindow || exceedsTokenBudget || exceedsNodeCount) {
      flushCluster()
    }

    if (windowStart === null) {
      windowStart = updatedMs
      firstUpdate = entry.updated
    }

    currentIds.push(id)
    currentTokens += entryTokens
    lastUpdate = entry.updated
  }

  flushCluster()

  return clusters
}
