/**
 * Types and Zod schemas for the semantic dedup subsystem (post-literal).
 *
 * Semantic dedup uses LLM-based comparison to detect near-duplicates
 * that heuristic/literal dedup misses. Types are intentionally decoupled
 * from the literal dedup types to allow independent evolution.
 */
import { z } from 'zod'
import type { RegistryNodeEntry } from '../graph/registry.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Resolved semantic dedup configuration with all defaults applied. */
export interface SemanticDedupConfig {
  /** Whether semantic dedup is enabled. */
  readonly enabled: boolean
  /** Lower heuristic threshold for pre-filtering candidate blocks. Range [0, 1]. */
  readonly heuristicPrefilterThreshold: number
  /** Minimum LLM-reported similarity (0–100) to accept a merge suggestion. */
  readonly semanticMergeThreshold: number
  /** Maximum nodes in a single semantic comparison block. */
  readonly maxBlockSize: number
  /** Maximum blocks (LLM calls) per run. */
  readonly maxBlocksPerRun: number
  /** Maximum body characters per node sent to the LLM for comparison. */
  readonly maxBodyCharsPerNode: number
  /** Nodes updated further apart than this many days are not blocked together. */
  readonly timeWindowDays: number
}

// ---------------------------------------------------------------------------
// Semantic block
// ---------------------------------------------------------------------------

/** A group of candidate duplicate nodes for LLM semantic comparison. */
export interface SemanticBlock {
  /** IDs of nodes in this block. */
  readonly nodeIds: readonly string[]
  /** Registry entries keyed by node ID. */
  readonly entries: ReadonlyMap<string, RegistryNodeEntry>
  /** Primary domain of this block's nodes. */
  readonly domain: string
  /** Highest heuristic similarity score in this block. */
  readonly maxHeuristicScore: number
}

// ---------------------------------------------------------------------------
// LLM response
// ---------------------------------------------------------------------------

/** A single merge suggestion returned by the semantic dedup LLM. */
export interface SemanticMergeSuggestion {
  /** Node ID of the keeper (most complete node). */
  readonly keepNodeId: string
  /** Node IDs to merge into the keeper. */
  readonly mergeNodeIds: readonly string[]
  /** LLM-assessed similarity score (0–100). */
  readonly similarityScore: number
  /** Short rationale for the merge decision. */
  readonly rationale: string
}

/** Full LLM response for semantic dedup. */
export interface SemanticDedupLlmResponse {
  readonly suggestions: readonly SemanticMergeSuggestion[]
}

export const semanticMergeSuggestionSchema = z.object({
  keepNodeId: z.string().min(1),
  mergeNodeIds: z.array(z.string().min(1)).min(1),
  similarityScore: z.number().int().min(0).max(100),
  rationale: z.string(),
})

export const semanticDedupLlmResponseSchema = z.object({
  suggestions: z.array(semanticMergeSuggestionSchema),
})

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/** Summary of a completed semantic dedup run. */
export interface SemanticDedupResult {
  readonly blocksProcessed: number
  readonly mergesExecuted: number
  readonly nodesArchived: number
  readonly tokensUsed: number
  readonly errors: readonly string[]
}
