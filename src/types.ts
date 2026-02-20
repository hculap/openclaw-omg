/**
 * Core types for the Observational Memory Graph (OMG) plugin.
 * All types are immutable (readonly where appropriate).
 */

// ---------------------------------------------------------------------------
// Enums / Unions
// ---------------------------------------------------------------------------

/** The kind of knowledge node stored in the graph. */
export type NodeType =
  | 'identity'
  | 'preference'
  | 'project'
  | 'decision'
  | 'fact'
  | 'episode'
  | 'reflection'
  | 'moc'
  | 'index'
  | 'now'

/** Importance level of a node, used for context injection ranking. */
export type Priority = 'high' | 'medium' | 'low'

/**
 * Compression level applied to a node's body during reflection.
 * 0 = no compression, 3 = maximum compression.
 */
export type CompressionLevel = 0 | 1 | 2 | 3

// ---------------------------------------------------------------------------
// Node Frontmatter
// ---------------------------------------------------------------------------

/** A source reference linking a node back to the session message that created it. */
export interface NodeSource {
  readonly sessionKey: string
  readonly kind: string
  readonly timestamp: number
}

/** Scope context for identity-bound nodes. */
export interface NodeAppliesTo {
  readonly sessionScope?: string
  readonly identityKey?: string
}

/**
 * YAML frontmatter parsed from the top of each markdown node file.
 * Represents all structured metadata stored with a node.
 */
export interface NodeFrontmatter {
  readonly id: string
  readonly description: string
  readonly type: NodeType
  readonly priority: Priority
  /** ISO 8601 date string, e.g. "2024-01-15T10:30:00Z" */
  readonly created: string
  /** ISO 8601 date string */
  readonly updated: string
  readonly appliesTo?: NodeAppliesTo
  readonly sources?: readonly NodeSource[]
  /** Wikilinks to related nodes, e.g. ["omg/moc-preferences"] */
  readonly links?: readonly string[]
  readonly tags?: readonly string[]
  /** IDs of nodes this node supersedes */
  readonly supersedes?: readonly string[]
}

// ---------------------------------------------------------------------------
// Graph Node
// ---------------------------------------------------------------------------

/**
 * A complete knowledge node, combining structured frontmatter with
 * the markdown body and the file path on disk.
 */
export interface GraphNode {
  readonly frontmatter: NodeFrontmatter
  readonly body: string
  readonly filePath: string
}

// ---------------------------------------------------------------------------
// Observer types
// ---------------------------------------------------------------------------

/** The type of write operation the Observer wants to apply to the graph. */
export type ObserverActionKind = 'create' | 'update' | 'supersede'

/** A single write operation produced by the Observer after analysing messages. */
export interface ObserverOperation {
  readonly kind: ObserverActionKind
  /** Target node id for update/supersede; undefined for create. */
  readonly targetId?: string
  /** Proposed frontmatter for the node after the operation. */
  readonly frontmatter: NodeFrontmatter
  /** Proposed body content for the node. */
  readonly body: string
}

/** The full output of a single Observer run. */
export interface ObserverOutput {
  readonly operations: readonly ObserverOperation[]
  /** Replacement content for the [[omg/now]] node, or null if no update needed. */
  readonly nowUpdate: string | null
  /** IDs of MOC nodes that need to be regenerated after this run. */
  readonly mocUpdates: readonly string[]
}

// ---------------------------------------------------------------------------
// Reflector types
// ---------------------------------------------------------------------------

/** A single node rewrite produced by the Reflector during a reflection pass. */
export interface ReflectorNodeEdit {
  readonly targetId: string
  readonly frontmatter: NodeFrontmatter
  readonly body: string
  /** Compression level applied during this edit. */
  readonly compressionLevel: CompressionLevel
}

/** The full output of a Reflector reflection pass. */
export interface ReflectorOutput {
  readonly edits: readonly ReflectorNodeEdit[]
  /** IDs of nodes the Reflector recommends deleting (stale/superseded). */
  readonly deletions: readonly string[]
  /** Tokens consumed by this reflection run. */
  readonly tokensUsed: number
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * Mutable session state tracked by the OMG plugin across a conversation.
 * Persisted to disk between turns.
 */
export interface OmgSessionState {
  readonly lastObservedAtMs: number
  readonly pendingMessageTokens: number
  readonly totalObservationTokens: number
  readonly observationBoundaryMessageIndex: number
  readonly nodeCount: number
}

// ---------------------------------------------------------------------------
// Context injection types
// ---------------------------------------------------------------------------

/**
 * A slice of graph context assembled for injection into an agent's system prompt.
 * Contains ranked nodes selected to fit within the token budget.
 */
export interface GraphContextSlice {
  /** Serialised index node content. */
  readonly index: string
  /** MOC nodes included in this slice. */
  readonly mocs: readonly GraphNode[]
  /** Regular knowledge nodes included in this slice. */
  readonly nodes: readonly GraphNode[]
  /** The [[omg/now]] node, if present. */
  readonly nowNode: GraphNode | null
  /** Estimated total tokens for this slice. */
  readonly totalTokens: number
}
