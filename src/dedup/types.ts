/**
 * Types and Zod schemas for the OMG semantic dedup subsystem.
 */
import { z } from 'zod'

// ---------------------------------------------------------------------------
// DedupConfig
// ---------------------------------------------------------------------------

/** Resolved dedup configuration with all defaults applied. */
export interface DedupConfig {
  /** Minimum combined similarity score for a pair to be considered a candidate. Range [0, 1]. */
  readonly similarityThreshold: number
  /** Maximum number of clusters processed per dedup run. */
  readonly maxClustersPerRun: number
  /** Maximum nodes in a single cluster. Range [2, 20]. */
  readonly maxClusterSize: number
  /** Maximum pairs evaluated per bucket. */
  readonly maxPairsPerBucket: number
  /** Nodes last updated more than this many days apart are not clustered (volatile types only). */
  readonly staleDaysThreshold: number
  /** Node types considered stable enough for aggressive dedup. */
  readonly stableTypes: readonly string[]
}

// ---------------------------------------------------------------------------
// MergePlan — LLM output for a single cluster
// ---------------------------------------------------------------------------

/** Plan returned by the LLM for merging one cluster of duplicate nodes. */
export interface MergePlan {
  /** Node ID of the keeper (most complete node). */
  readonly keepUid: string
  /** Node ID of the keeper. */
  readonly keepNodeId: string
  /** UIDs of nodes to archive (losers). */
  readonly mergeUids: readonly string[]
  /** Node IDs of nodes to archive. */
  readonly mergeNodeIds: readonly string[]
  /** Canonical keys that should be preserved as aliases on the keeper. */
  readonly aliasKeys: readonly string[]
  /** Any conflicts the LLM detected (e.g. contradictory values). */
  readonly conflicts: readonly string[]
  /** Patch to apply to the keeper. */
  readonly patch: {
    readonly description?: string
    readonly tags?: readonly string[]
    readonly links?: readonly string[]
    readonly bodyAppend?: string
  }
}

export const mergePlanSchema = z.object({
  keepUid: z.string(),
  keepNodeId: z.string(),
  mergeUids: z.array(z.string()),
  mergeNodeIds: z.array(z.string()),
  aliasKeys: z.array(z.string()),
  conflicts: z.array(z.string()),
  patch: z.object({
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    links: z.array(z.string()).optional(),
    bodyAppend: z.string().optional(),
  }),
})

export const dedupLlmResponseSchema = z.object({
  mergePlans: z.array(mergePlanSchema),
})

// ---------------------------------------------------------------------------
// DedupRunResult
// ---------------------------------------------------------------------------

/** Summary of a completed dedup run. */
export interface DedupRunResult {
  readonly clustersProcessed: number
  readonly mergesExecuted: number
  readonly nodesArchived: number
  readonly conflictsDetected: number
  readonly tokensUsed: number
  readonly errors: readonly string[]
}

// ---------------------------------------------------------------------------
// DedupAuditEntry
// ---------------------------------------------------------------------------

/** A single audit record written after each merge. */
export interface DedupAuditEntry {
  readonly timestamp: string
  readonly keepNodeId: string
  readonly mergedNodeIds: readonly string[]
  readonly aliasKeys: readonly string[]
  readonly conflicts: readonly string[]
  readonly patch: MergePlan['patch']
}

// ---------------------------------------------------------------------------
// DedupState
// ---------------------------------------------------------------------------

/** Persisted state for the dedup subsystem (.dedup-state.json). */
export interface DedupState {
  /** ISO 8601 timestamp of the last successful dedup run. null if never run. */
  readonly lastDedupAt: string | null
  /** Total number of completed dedup runs. */
  readonly runsCompleted: number
  /** Total nodes merged across all runs. */
  readonly totalMerges: number
}

export const dedupStateSchema = z.object({
  lastDedupAt: z.string().nullable(),
  runsCompleted: z.number().int().nonnegative(),
  totalMerges: z.number().int().nonnegative(),
})

export function getDefaultDedupState(): DedupState {
  return { lastDedupAt: null, runsCompleted: 0, totalMerges: 0 }
}
