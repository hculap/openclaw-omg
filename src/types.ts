/**
 * Core types for the Observational Memory Graph (OMG) plugin.
 * All types are immutable (readonly where appropriate).
 */

// ---------------------------------------------------------------------------
// Enums / Unions
// ---------------------------------------------------------------------------

/**
 * All valid node type values as a const array — the single source of truth
 * for both the `NodeType` union and the `isNodeType` runtime guard.
 */
export const NODE_TYPES = [
  'identity',   // User identity and persistent self-description
  'preference', // User preferences and stated choices
  'project',    // Project context and goals
  'decision',   // Recorded decisions and their rationale
  'fact',       // Standalone facts learned during conversation
  'episode',    // Episodic memory of a specific session event
  'reflection', // Synthesised insight produced by the Reflector
  'moc',        // Map of Content — auto-generated index of related nodes
  'index',      // Top-level index node linking to all MOCs in the graph
  'now',        // Current-state snapshot node ([[omg/now]]), rebuilt each turn
] as const

/** The kind of knowledge node stored in the graph. */
export type NodeType = typeof NODE_TYPES[number]

/**
 * Returns true if `v` is a valid `NodeType` string.
 * Use this when parsing YAML frontmatter from disk to avoid re-enumerating
 * the node type set at every call site.
 */
export function isNodeType(v: unknown): v is NodeType {
  return typeof v === 'string' && (NODE_TYPES as readonly string[]).includes(v)
}

/** Importance level of a node, used for context injection ranking. */
export type Priority = 'high' | 'medium' | 'low'

/**
 * Canonical ordering for `Priority` values (higher = more important).
 * Use this for sorting and comparison rather than repeating the mapping
 * at every call site.
 */
export const PRIORITY_ORDER: Record<Priority, number> = {
  high: 3,
  medium: 2,
  low: 1,
} as const

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
  /** Identifier of the conversation session that produced this observation. */
  readonly sessionKey: string
  /** Category of message that produced this observation (e.g. "user", "assistant"). */
  readonly kind: string
  /** Unix epoch timestamp (ms) of the source message. */
  readonly timestamp: number
}

/**
 * Scope context for identity-bound nodes.
 * Applies only to nodes with `type === 'identity'`.
 */
export interface NodeAppliesTo {
  /** Identifier of the session scope (e.g. workspace or project key). */
  readonly sessionScope?: string
  /**
   * Identifier of the user identity this node is scoped to.
   * Distinct from `NodeSource.sessionKey` which identifies the originating session.
   */
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
  /** ISO 8601 date string; must be >= created */
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
 * the markdown body and the absolute file path on disk.
 */
export interface GraphNode {
  readonly frontmatter: NodeFrontmatter
  readonly body: string
  /** Absolute path to the node's markdown file on disk. */
  readonly filePath: string
}

// ---------------------------------------------------------------------------
// Observer types
// ---------------------------------------------------------------------------

/**
 * A single write operation produced by the Observer after analysing messages.
 *
 * Uses a discriminated union so that `targetId` is required (and typed as
 * `string`) on the branches that need it, and absent on `create`.
 */
export type ObserverOperation =
  | {
      readonly kind: 'create'
      /** Proposed frontmatter for the new node. */
      readonly frontmatter: NodeFrontmatter
      /** Proposed body content for the new node. */
      readonly body: string
    }
  | {
      readonly kind: 'update'
      /** ID of the existing node to update. */
      readonly targetId: string
      /** Proposed frontmatter after the update. */
      readonly frontmatter: NodeFrontmatter
      /** Proposed body after the update. */
      readonly body: string
    }
  | {
      readonly kind: 'supersede'
      /** ID of the existing node being superseded. */
      readonly targetId: string
      /** Proposed frontmatter for the replacement node. */
      readonly frontmatter: NodeFrontmatter
      /** Proposed body for the replacement node. */
      readonly body: string
    }

/** Convenience union of all valid Observer action kinds. */
export type ObserverActionKind = ObserverOperation['kind']

/** The full output of a single Observer run. */
export interface ObserverOutput {
  readonly operations: readonly ObserverOperation[]
  /** Replacement markdown content for the [[omg/now]] node, or null if no update needed. */
  readonly nowUpdate: string | null
  /** IDs of MOC nodes that need to be regenerated after this run. */
  readonly mocUpdates: readonly string[]
}

// ---------------------------------------------------------------------------
// Reflector types
// ---------------------------------------------------------------------------

/** A single node rewrite produced by the Reflector during a reflection pass. */
export interface ReflectorNodeEdit {
  /** ID of the node being rewritten. */
  readonly targetId: string
  readonly frontmatter: NodeFrontmatter
  readonly body: string
  /** Compression level applied during this edit. */
  readonly compressionLevel: CompressionLevel
}

/** The full output of a Reflector reflection pass. */
export interface ReflectorOutput {
  /** Node rewrites produced during this pass. A node must not appear in both edits and deletions. */
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
 * Snapshot of OMG plugin state for a single conversation turn.
 * A new instance is produced after each observation cycle and persisted to disk.
 * Immutable — state transitions create a new object rather than mutating in place.
 */
export interface OmgSessionState {
  /** Unix timestamp (ms) of the most recent successful Observer run. */
  readonly lastObservedAtMs: number
  /** Accumulated token count of messages not yet processed by the Observer. Resets after each observation run. */
  readonly pendingMessageTokens: number
  /** Cumulative tokens processed across all Observer runs in this session. Monotonically increasing. */
  readonly totalObservationTokens: number
  /** 0-based index of the last message included in the previous Observer run. */
  readonly observationBoundaryMessageIndex: number
  /** Current total count of nodes in the graph. */
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
  /** Markdown-formatted content of the index node, ready for injection into a system prompt. */
  readonly index: string
  /** MOC (Map of Content) nodes included in this slice. All items have `frontmatter.type === 'moc'`. */
  readonly mocs: readonly GraphNode[]
  /** Regular knowledge nodes included in this slice (non-moc, non-index, non-now). */
  readonly nodes: readonly GraphNode[]
  /** The [[omg/now]] node, if present. */
  readonly nowNode: GraphNode | null
  /** Estimated total tokens for this slice. An approximation — not a hard guarantee. */
  readonly totalTokens: number
}
