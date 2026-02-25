/**
 * Core types for the Observational Memory Graph (OMG) plugin.
 * All types are immutable (readonly where appropriate).
 */
import type { LlmClient } from './llm/client.js'
import type { OmgConfig } from './config.js'

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

/**
 * Node types that can be inferred from a canonical-key prefix.
 * Only user-facing types — system types (moc, index, now, reflection) are
 * excluded to prevent accidental system-node creation.
 */
export const INFERABLE_NODE_TYPES = [
  'identity',
  'preference',
  'project',
  'decision',
  'fact',
  'episode',
] as const satisfies readonly NodeType[]

/** Lookup table mapping lowercased type strings (including plurals) to canonical NodeType. */
const NODE_TYPE_LOOKUP: ReadonlyMap<string, NodeType> = (() => {
  const map = new Map<string, NodeType>()
  for (const t of NODE_TYPES) {
    map.set(t, t)
  }
  // Plural forms for inferable types
  map.set('identities', 'identity')
  map.set('preferences', 'preference')
  map.set('projects', 'project')
  map.set('decisions', 'decision')
  map.set('facts', 'fact')
  map.set('episodes', 'episode')
  map.set('reflections', 'reflection')
  map.set('mocs', 'moc')
  return map
})()

/**
 * Attempts to coerce an unknown value into a valid `NodeType`.
 * Handles case-insensitive matching, trimming, and plural forms.
 * Returns `null` if the value cannot be coerced.
 */
export function coerceNodeType(raw: unknown): NodeType | null {
  if (typeof raw !== 'string') return null
  const normalized = raw.trim().toLowerCase()
  return NODE_TYPE_LOOKUP.get(normalized) ?? null
}

/** Lookup table mapping inferable key prefixes (including plurals) to NodeType. */
const KEY_PREFIX_LOOKUP: ReadonlyMap<string, NodeType> = (() => {
  const map = new Map<string, NodeType>()
  for (const t of INFERABLE_NODE_TYPES) {
    map.set(t, t)
  }
  // Plural prefixes
  map.set('identities', 'identity')
  map.set('preferences', 'preference')
  map.set('projects', 'project')
  map.set('decisions', 'decision')
  map.set('facts', 'fact')
  map.set('episodes', 'episode')
  return map
})()

/**
 * Infers a `NodeType` from a canonical-key prefix.
 * For example, `"identity.name"` → `"identity"`, `"preferences.theme"` → `"preference"`.
 * Only infers user-facing types (identity, preference, project, decision, fact, episode).
 * Returns `null` if the prefix is not recognizable.
 */
export function inferNodeTypeFromKey(canonicalKey: string): NodeType | null {
  const dotIndex = canonicalKey.indexOf('.')
  if (dotIndex <= 0) return null
  const prefix = canonicalKey.slice(0, dotIndex).toLowerCase()
  return KEY_PREFIX_LOOKUP.get(prefix) ?? null
}

/** Importance level of a node, used for context injection ranking. */
export type Priority = 'high' | 'medium' | 'low'

/**
 * Canonical ordering for `Priority` values (higher = more important).
 * Use this for sorting and comparison rather than repeating the mapping
 * at every call site.
 */
export const PRIORITY_ORDER = {
  high: 3,
  medium: 2,
  low: 1,
} as const satisfies Record<Priority, number>

/**
 * Compression level applied to a node's body during reflection.
 * 0 = no compression, 3 = maximum compression.
 */
export type CompressionLevel = 0 | 1 | 2 | 3

/** The set of valid `CompressionLevel` values as a const array — single source of truth. */
const COMPRESSION_LEVELS = [0, 1, 2, 3] as const

/** Returns true if `v` is a valid `CompressionLevel` value (0, 1, 2, or 3). */
export function isCompressionLevel(v: unknown): v is CompressionLevel {
  return typeof v === 'number' && (COMPRESSION_LEVELS as readonly number[]).includes(v)
}

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
 * Scope context for identity-bound nodes. At least one field must be present.
 * By convention, only used on nodes with `type === 'identity'`.
 * The type system does not enforce the identity-only restriction — it will be maintained by write logic
 * (not yet implemented).
 */
export type NodeAppliesTo =
  | { readonly sessionScope: string; readonly identityKey?: string }
  | { readonly sessionScope?: string; readonly identityKey: string }

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
  /** ISO 8601 date string; must be >= created (enforced by write logic, not this type) */
  readonly updated: string
  readonly appliesTo?: NodeAppliesTo
  readonly sources?: readonly NodeSource[]
  /** Wikilinks to related nodes, e.g. ["omg/moc-preferences"] */
  readonly links?: readonly string[]
  readonly tags?: readonly string[]
  /** IDs of nodes this node supersedes */
  readonly supersedes?: readonly string[]
  /** Compression level recorded when this node was last rewritten by the Reflector. */
  readonly compressionLevel?: CompressionLevel
  /** When true, the Reflector has soft-deleted this node. Archived nodes are excluded from context injection. */
  readonly archived?: boolean
  /** Deterministic 12-character hex hash of scope:type:canonicalKey. Enables O(1) dedup via file-exists checks. */
  readonly uid?: string
  /** Stable dotted-path key used to compute id and file path (e.g. "preferences.editor_theme"). */
  readonly canonicalKey?: string
  /** Alternative identifiers or slugs this node was previously known by. */
  readonly aliases?: readonly string[]
  /** Node ID this node was merged into during semantic dedup. Set when the node is archived by the dedup process. */
  readonly mergedInto?: string
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
  | {
      readonly kind: 'upsert'
      /** Stable dotted-path key (e.g. "preferences.editor_theme"). Used to compute uid, id, and file path. */
      readonly canonicalKey: string
      readonly type: NodeType
      readonly title: string
      readonly description: string
      readonly body: string
      readonly priority: Priority
      /** Domain hints for MOC membership (e.g. ["preferences", "tools"]). */
      readonly mocHints?: readonly string[]
      /** canonicalKeys of related nodes to link to. */
      readonly linkKeys?: readonly string[]
      readonly tags?: readonly string[]
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
  /**
   * ID of the node being rewritten.
   * Must equal `frontmatter.id` — enforced by `createReflectorOutput`.
   */
  readonly targetId: string
  readonly frontmatter: NodeFrontmatter
  readonly body: string
  /** Compression level applied during this edit. */
  readonly compressionLevel: CompressionLevel
}

/** Discriminant for the three invariants checked by `createReflectorOutput`. */
export type ReflectorInvariantKind = 'overlap' | 'id-mismatch' | 'negative-tokens'

/**
 * Thrown by `createReflectorOutput` when any of its three invariants are violated:
 *   - `'overlap'`: a node ID appears in both `edits` and `deletions`.
 *   - `'id-mismatch'`: an edit's `targetId` does not equal its `frontmatter.id`.
 *   - `'negative-tokens'`: `tokensUsed` is less than 0.
 *
 * Inspect `kind` to programmatically distinguish violations.
 * `overlappingIds` is populated only when `kind === 'overlap'`.
 */
export class ReflectorInvariantError extends Error {
  readonly kind: ReflectorInvariantKind
  /**
   * IDs appearing in both `edits` and `deletions`.
   * Populated when `kind === 'overlap'`; empty array otherwise.
   */
  readonly overlappingIds: readonly string[]

  constructor(kind: ReflectorInvariantKind, message: string, overlappingIds: readonly string[] = []) {
    super(message)
    this.name = 'ReflectorInvariantError'
    this.kind = kind
    this.overlappingIds = overlappingIds
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// Brand that forces construction through createReflectorOutput.
// Zero runtime cost — the field exists only in the type system.
declare const __reflectorOutputBrand: unique symbol

/**
 * The full output of a Reflector reflection pass.
 *
 * Invariants enforced by `createReflectorOutput`:
 *   - A node ID must not appear in both `edits` and `deletions`.
 *   - Each `edit.targetId` must equal `edit.frontmatter.id`.
 *   - `tokensUsed` must be >= 0.
 *
 * Construct exclusively via `createReflectorOutput` — direct object literals
 * are rejected by the TypeScript compiler due to the opaque brand field.
 */
export interface ReflectorOutput {
  readonly [__reflectorOutputBrand]: true
  /** Node rewrites produced during this pass. */
  readonly edits: readonly ReflectorNodeEdit[]
  /** IDs of nodes the Reflector recommends deleting (stale/superseded). */
  readonly deletions: readonly string[]
  /** Tokens consumed by this reflection run. Must be >= 0. */
  readonly tokensUsed: number
}

/**
 * Creates a validated `ReflectorOutput`, enforcing three invariants:
 *   1. No node ID appears in both `edits` and `deletions`.
 *   2. Each `edit.targetId` equals `edit.frontmatter.id`.
 *   3. `tokensUsed` is >= 0.
 *
 * @throws {ReflectorInvariantError} if any invariant is violated.
 *   Inspect `err.kind` to distinguish between `'overlap'`, `'id-mismatch'`, and `'negative-tokens'`.
 */
export function createReflectorOutput(
  edits: readonly ReflectorNodeEdit[],
  deletions: readonly string[],
  tokensUsed: number
): ReflectorOutput {
  if (tokensUsed < 0) {
    throw new ReflectorInvariantError(
      'negative-tokens',
      `ReflectorOutput invariant violation: tokensUsed must be >= 0, got ${tokensUsed}`
    )
  }
  const idMismatches = edits.filter((e) => e.frontmatter.id !== e.targetId)
  if (idMismatches.length > 0) {
    const details = idMismatches.map((e) => `${e.targetId}≠${e.frontmatter.id}`).join(', ')
    throw new ReflectorInvariantError(
      'id-mismatch',
      `ReflectorOutput invariant violation: edit targetId/frontmatter.id mismatch: [${details}]`
    )
  }
  const editIds = new Set(edits.map((e) => e.targetId))
  const overlap = deletions.filter((id) => editIds.has(id))
  if (overlap.length > 0) {
    throw new ReflectorInvariantError(
      'overlap',
      `ReflectorOutput invariant violation: node(s) [${overlap.join(', ')}] appear in both edits and deletions`,
      overlap
    )
  }
  return { edits, deletions, tokensUsed } as ReflectorOutput
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
  /**
   * Cumulative tokens processed across all Observer runs in this session.
   * Monotonically increasing — never decreases when producing a new state
   * object. The non-decrease invariant is enforced by the session state
   * update logic, not by this type.
   */
  readonly totalObservationTokens: number
  /**
   * Value of `totalObservationTokens` at the time of the most recent
   * reflection pass. Used to compute the delta since the last reflection,
   * preventing the reflection trigger from firing on every subsequent turn
   * once the cumulative threshold is exceeded.
   */
  readonly lastReflectionTotalTokens: number
  /** 0-based index of the last message included in the previous Observer run. */
  readonly observationBoundaryMessageIndex: number
  /** Cumulative count of nodes written by the Observer across all turns in this session. May diverge from the live graph size after deletions or state resets. */
  readonly nodeCount: number
  /** IDs of nodes written during the most recent Observer run. Empty if no observation has run. */
  readonly lastObservationNodeIds: readonly string[]
}

/**
 * Thrown by `createOmgSessionState` when any field violates its invariant.
 */
export class OmgSessionStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OmgSessionStateError'
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/**
 * Creates a validated `OmgSessionState`, enforcing:
 *   - All five numeric fields are >= 0.
 *   - `totalObservationTokens` has not decreased relative to `previousTotalObservationTokens`
 *     (if provided), guarding the monotonicity invariant.
 *
 * @throws {OmgSessionStateError} if any invariant is violated.
 */
export function createOmgSessionState(
  fields: {
    readonly lastObservedAtMs: number
    readonly pendingMessageTokens: number
    readonly totalObservationTokens: number
    readonly lastReflectionTotalTokens: number
    readonly observationBoundaryMessageIndex: number
    readonly nodeCount: number
    readonly lastObservationNodeIds: readonly string[]
  },
  previousTotalObservationTokens?: number
): OmgSessionState {
  if (fields.lastObservedAtMs < 0) {
    throw new OmgSessionStateError(`lastObservedAtMs must be >= 0, got ${fields.lastObservedAtMs}`)
  }
  if (fields.pendingMessageTokens < 0) {
    throw new OmgSessionStateError(`pendingMessageTokens must be >= 0, got ${fields.pendingMessageTokens}`)
  }
  if (fields.totalObservationTokens < 0) {
    throw new OmgSessionStateError(`totalObservationTokens must be >= 0, got ${fields.totalObservationTokens}`)
  }
  if (fields.lastReflectionTotalTokens < 0) {
    throw new OmgSessionStateError(`lastReflectionTotalTokens must be >= 0, got ${fields.lastReflectionTotalTokens}`)
  }
  if (fields.observationBoundaryMessageIndex < 0) {
    throw new OmgSessionStateError(`observationBoundaryMessageIndex must be >= 0, got ${fields.observationBoundaryMessageIndex}`)
  }
  if (fields.nodeCount < 0) {
    throw new OmgSessionStateError(`nodeCount must be >= 0, got ${fields.nodeCount}`)
  }
  if (
    previousTotalObservationTokens !== undefined &&
    fields.totalObservationTokens < previousTotalObservationTokens
  ) {
    throw new OmgSessionStateError(
      `totalObservationTokens must not decrease: ` +
      `got ${fields.totalObservationTokens}, previous was ${previousTotalObservationTokens}`
    )
  }
  return { ...fields }
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
  /** MOC (Map of Content) nodes included in this slice. All items have `frontmatter.type === 'moc'` (maintained by the context assembler, not enforced by this type). */
  readonly mocs: readonly GraphNode[]
  /** Regular knowledge nodes included in this slice (non-moc, non-index, non-now). */
  readonly nodes: readonly GraphNode[]
  /** The [[omg/now]] node, if present. */
  readonly nowNode: GraphNode | null
  /** Estimated token count for this slice. An approximation — not a hard guarantee. */
  readonly estimatedTokens: number
}

// ---------------------------------------------------------------------------
// Graph write types (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Context shared by all graph write operations.
 * Provides the resolved storage root and the current session key.
 */
export interface WriteContext {
  /** Absolute path to the OMG graph root (e.g. "/workspace/memory/omg"). */
  readonly omgRoot: string
  /** Identifier of the current conversation session. */
  readonly sessionKey: string
  /**
   * Scope string used when computing deterministic node UIDs.
   * Typically the resolved workspace directory path.
   * Defaults to omgRoot when not provided.
   */
  readonly scope?: string
}

/**
 * Data required to write a new reflection node to disk.
 * Produced by the Reflector after a reflection pass.
 */
export interface ReflectionNodeData {
  readonly frontmatter: NodeFrontmatter
  readonly body: string
  /** IDs of the observation nodes that contributed to this reflection. */
  readonly sourceNodeIds: readonly string[]
}

/**
 * Markdown body content for the [[omg/now]] singleton node.
 * The now node is always overwritten in full on each Observer run.
 */
export type NowUpdate = string

/**
 * A single add or remove operation on a MOC (Map of Content) file.
 */
export interface MocUpdateEntry {
  readonly action: 'add' | 'remove'
  /** Wikilink target to add or remove (e.g. "omg/identity/preferred-name-2026-02-20"). */
  readonly nodeId: string
}

/**
 * A field-level update the Reflector can apply to an existing graph node
 * without replacing the entire node.
 */
export interface NodeUpdateEntry {
  /** ID of the node to update. */
  readonly targetId: string
  /** The frontmatter field or body section to modify. */
  readonly field: 'description' | 'priority' | 'body' | 'tags' | 'links'
  /** How to apply the value: overwrite, append, or remove a member. */
  readonly action: 'set' | 'add' | 'remove'
  /** The value to set/add/remove. */
  readonly value: string
}

// ---------------------------------------------------------------------------
// Extract / Merge types (Phase 5 — split observer)
// ---------------------------------------------------------------------------

/**
 * A single knowledge candidate extracted by the Extract phase.
 * Structurally mirrors the upsert variant of ObserverOperation but is
 * decoupled from the legacy discriminated union.
 */
export interface ExtractCandidate {
  readonly type: NodeType
  readonly canonicalKey: string
  readonly title: string
  readonly description: string
  readonly body: string
  readonly priority: Priority
  readonly mocHints?: readonly string[]
  readonly linkKeys?: readonly string[]
  readonly tags?: readonly string[]
}

/**
 * Structured patch for the [[omg/now]] node.
 * Rendered deterministically in code — not free-form LLM markdown.
 */
export interface NowPatch {
  readonly focus: string
  readonly openLoops: readonly string[]
  readonly suggestedLinks: readonly string[]
}

/** Full output of a single Extract phase run. */
export interface ExtractOutput {
  readonly candidates: readonly ExtractCandidate[]
  readonly nowPatch: NowPatch | null
  readonly mocUpdates: readonly string[]
}

/** Input parameters for {@link runExtract}. */
export interface ExtractParams {
  readonly unobservedMessages: readonly Message[]
  readonly nowNode: string | null
  readonly config: OmgConfig
  readonly llmClient: LlmClient
  readonly sessionContext?: Record<string, unknown>
  /** Override the default max output tokens for the LLM response. Used by batched bootstrap to scale with chunk count. */
  readonly maxOutputTokens?: number
}

/**
 * Decision returned by the Merge phase for a single candidate.
 *
 * - `keep_separate` — write the candidate as a new node (default / no merge)
 * - `merge`         — append content to an existing node
 * - `alias`         — add an alias key to an existing node (no body change)
 */
export type MergeAction =
  | { readonly action: 'keep_separate' }
  | { readonly action: 'merge'; readonly targetNodeId: string; readonly bodyAppend?: string }
  | { readonly action: 'alias'; readonly targetNodeId: string; readonly aliasKey: string }

/** A scored existing node considered as a merge target for an ExtractCandidate. */
export interface ScoredMergeTarget {
  readonly nodeId: string
  readonly entry: import('./graph/registry.js').RegistryNodeEntry
  readonly localScore: number
  readonly semanticScore: number
  readonly finalScore: number
}

/**
 * Bridges an ExtractCandidate to an ObserverOperation (upsert kind).
 * Used by the compat wrapper and by the agent-end hook when merge decides
 * to keep a candidate separate.
 */
export function candidateToUpsertOperation(candidate: ExtractCandidate): ObserverOperation {
  return {
    kind: 'upsert',
    canonicalKey: candidate.canonicalKey,
    type: candidate.type,
    title: candidate.title,
    description: candidate.description,
    body: candidate.body,
    priority: candidate.priority,
    ...(candidate.mocHints && candidate.mocHints.length > 0 ? { mocHints: candidate.mocHints } : {}),
    ...(candidate.linkKeys && candidate.linkKeys.length > 0 ? { linkKeys: candidate.linkKeys } : {}),
    ...(candidate.tags && candidate.tags.length > 0 ? { tags: candidate.tags } : {}),
  }
}

// ---------------------------------------------------------------------------
// Observer input types (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Lightweight index entry for a single node in the graph.
 * Sent to the Observer LLM so it can reference existing nodes by ID
 * without transmitting full node bodies.
 */
export interface NodeIndexEntry {
  readonly id: string
  readonly description: string
}

/**
 * A single conversation message to be observed.
 */
export interface Message {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/**
 * Full set of inputs for a single Observer run.
 * Passed to {@link runObservation} by the hook layer.
 */
export interface ObservationParams {
  /** Messages not yet analysed by a previous Observer run. */
  readonly unobservedMessages: readonly Message[]
  /**
   * Compact index of nodes already in the graph.
   * @deprecated No longer required — the new Observer uses deterministic IDs and does not
   * need the full node index for dedup. Kept for backward compatibility.
   */
  readonly existingNodeIndex?: readonly NodeIndexEntry[]
  /** Current body of the [[omg/now]] node, or null if it doesn't exist yet. */
  readonly nowNode: string | null
  /**
   * Resolved plugin configuration.
   * Not used by the Observer in Phase 3 — reserved for Phase 4 model selection
   * (config.observer.model will determine which model the LLM client uses).
   */
  readonly config: OmgConfig
  /** LLM client to call for generation. */
  readonly llmClient: LlmClient
  /** Optional session-level metadata forwarded to the LLM user prompt. */
  readonly sessionContext?: Record<string, unknown>
  /** Override the default max output tokens for the LLM response. Used by batched bootstrap to scale with chunk count. */
  readonly maxOutputTokens?: number
}
