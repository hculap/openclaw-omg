/**
 * Types for the graph traversal engine.
 *
 * These types describe the results of traversal operations over the
 * OMG knowledge graph's adjacency structure (built from registry `links[]`).
 */

import type { RegistryNodeEntry } from './registry.js'

// ---------------------------------------------------------------------------
// Traversal result types
// ---------------------------------------------------------------------------

/** A neighbor discovered during graph traversal. */
export interface TraversalNeighbor {
  readonly nodeId: string
  readonly entry: RegistryNodeEntry
  readonly distance: 1 | 2
  readonly direction: 'forward' | 'backward'
  readonly score: number
}

/** A directed edge in the graph (fromId links to toId). */
export interface TraversalEdge {
  readonly fromId: string
  readonly toId: string
}

/** A connected subgraph rooted at one or more seed nodes. */
export interface TraversalSubgraph {
  readonly nodeIds: readonly string[]
  readonly edges: readonly TraversalEdge[]
}

/** An ordered path between two nodes. */
export interface TraversalPath {
  /** Node IDs from source to target, inclusive. */
  readonly nodeIds: readonly string[]
  readonly length: number
}

// ---------------------------------------------------------------------------
// Traversal parameters
// ---------------------------------------------------------------------------

/** Direction filter for neighbor traversal. */
export type TraversalDirection = 'forward' | 'backward' | 'both'

/** Cached adjacency structure for a single omgRoot. */
export interface AdjacencyCache {
  readonly forward: ReadonlyMap<string, ReadonlySet<string>>
  readonly backward: ReadonlyMap<string, ReadonlySet<string>>
  readonly entryCount: number
}
