import { z } from 'zod'
import { formatZodErrors } from './error-utils.js'

// ---------------------------------------------------------------------------
// Model string validation
// ---------------------------------------------------------------------------

/**
 * Validates LLM model identifiers in lowercase "provider/model-name" format.
 * Only lowercase identifiers are accepted — this matches the convention used
 * by all major LLM providers and prevents case-mismatch errors when the
 * identifier is passed verbatim to an API.
 *
 * Valid examples:
 *   "openai/gpt-4o-mini"
 *   "anthropic/claude-3-5-haiku"
 *   "openai/gpt-4.1-mini"
 */
const MODEL_FORMAT_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._:-]*$/

/**
 * Zod field for a model identifier.
 * null = inherit the active model from OpenClaw's agent configuration.
 * string = explicit "provider/model-name" identifier (lowercase).
 */
const modelField = z
  .string()
  .nullable()
  .refine(
    (v) => v === null || MODEL_FORMAT_RE.test(v),
    {
      message:
        'Model must be null or a lowercase "provider/model-name" string (e.g. "openai/gpt-4o-mini")',
    }
  )
  .default(null)

// ---------------------------------------------------------------------------
// Node ID validation (used for pinnedNodes)
// ---------------------------------------------------------------------------

/**
 * Validates OMG node IDs in "namespace/slug" format (e.g. "omg/identity-core").
 * Namespace (before the slash): starts with lowercase alphanumeric, then
 * lowercase alphanumeric or hyphens (leading hyphens are not permitted).
 * Slug (after the slash): starts with lowercase alphanumeric, then
 * lowercase alphanumeric, hyphens, dots, and underscores.
 */
const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/

const nodeIdField = z.string().refine(
  (v) => NODE_ID_RE.test(v),
  { message: 'Node ID must be in "namespace/slug" format (e.g. "omg/identity-core")' }
)

// ---------------------------------------------------------------------------
// Cron schedule validation
// ---------------------------------------------------------------------------

/**
 * Validates a standard 5-field cron expression: minute hour dom month dow.
 *
 * Supported syntax per field:
 *   *         — every value
 *   N         — specific value within range
 *   N-N       — inclusive range (both N values may span digit-width groups,
 *               e.g. "8-20" is valid for hours)
 *   * /N      — step every N values (N ≥ 1, no space in actual syntax);
 *               only wildcard-based steps are supported (value-based steps
 *               like "5/15" are rejected)
 *
 * Field ranges: minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-7.
 * Comma-separated lists are not supported.
 * Note: structural ranges are validated; semantically nonsensical combinations
 * (e.g. "Feb 31") are not rejected. Inverted ranges (e.g. "50-10") are accepted
 * by the pattern but may produce unexpected runtime behavior.
 */
const CRON_MINUTE = '(?:\\*(?:/[1-9]\\d*)?|[0-5]?[0-9](?:-[0-5]?[0-9])?)'
const CRON_HOUR   = '(?:\\*(?:/[1-9]\\d*)?|(?:[01]?[0-9]|2[0-3])(?:-(?:[01]?[0-9]|2[0-3]))?)'
const CRON_DOM    = '(?:\\*(?:/[1-9]\\d*)?|(?:[1-9]|[12][0-9]|3[01])(?:-(?:[1-9]|[12][0-9]|3[01]))?)'
const CRON_MONTH  = '(?:\\*(?:/[1-9]\\d*)?|(?:[1-9]|1[0-2])(?:-(?:[1-9]|1[0-2]))?)'
const CRON_DOW    = '(?:\\*(?:/[1-9]\\d*)?|[0-7](?:-[0-7])?)'
const CRON_RE = new RegExp(
  `^${CRON_MINUTE}\\s+${CRON_HOUR}\\s+${CRON_DOM}\\s+${CRON_MONTH}\\s+${CRON_DOW}$`
)

const cronField = z
  .string()
  .refine((v) => CRON_RE.test(v), {
    message:
      'cronSchedule must be a valid 5-field cron expression (e.g. "0 3 * * *"). ' +
      'Supports *, */N (step), N, and N-N (range). Comma-separated lists are not supported.',
  })

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

/**
 * Config for the Observer agent that analyses conversation messages and
 * produces graph write operations.
 */
const observerSchema = z
  .object({
    /** LLM model to use. null = inherit from OpenClaw's active agent config. */
    model: modelField,
    /**
     * Anthropic API key for direct API access (bypass gateway routing).
     * Use this when the gateway routes to a model that is rate-limited or
     * when you want to ensure bootstrap uses Anthropic directly.
     * Accepts `sk-ant-...` format keys only (not OAuth tokens).
     *
     * Example: "sk-ant-api03-..."
     */
    apiKey: z.string().min(1).optional(),
    /**
     * Per-request timeout in milliseconds for LLM calls via the gateway.
     * Increase this when the gateway model is slow or under heavy load.
     * @default 120000 (2 minutes)
     */
    timeoutMs: z
      .number()
      .int()
      .min(5_000, 'timeoutMs must be at least 5000 (5 seconds)')
      .max(600_000, 'timeoutMs must be at most 600000 (10 minutes)')
      .default(120_000),
  })
  .strip()

/**
 * Config for the Reflector agent that periodically compresses and synthesises
 * the graph during scheduled reflection passes.
 */
const reflectorSchema = z
  .object({
    /** LLM model to use. null = inherit from OpenClaw's active agent config. */
    model: modelField,
  })
  .strip()

/**
 * Controls when the Observer agent runs during a conversation.
 * The Observer is triggered automatically based on `triggerMode`.
 */
const observationSchema = z
  .object({
    /**
     * Accumulated token count of unprocessed messages that triggers an observation run.
     * Lower values = more frequent observation (higher LLM cost).
     * Only used when `triggerMode` is `"threshold"`.
     */
    messageTokenThreshold: z
      .number()
      .int()
      .positive('messageTokenThreshold must be a positive integer')
      .default(8_000),
    /**
     * How observation runs are triggered:
     * - "threshold" — automatically when messageTokenThreshold is reached (default)
     * - "every-turn" — after every agent turn regardless of token count (dev/test mode)
     * - "manual" — only when explicitly invoked via the observational-memory-graph skill
     */
    triggerMode: z.enum(['threshold', 'every-turn', 'manual']).default('threshold'),
  })
  .strip()

/**
 * Controls cluster-first reflection: groups eligible nodes by domain and time
 * window before sending each cluster to the LLM for domain-scoped reflection.
 */
const clusteringSchema = z
  .object({
    /** Enable cluster-first reflection. When false, uses monolithic reflection. */
    enabled: z.boolean().default(true),
    /** Time window in days for grouping nodes into clusters. */
    windowSpanDays: z
      .number()
      .int()
      .min(1, 'clustering.windowSpanDays must be at least 1')
      .max(30, 'clustering.windowSpanDays must be at most 30')
      .default(7),
    /** Maximum number of nodes per cluster. */
    maxNodesPerCluster: z
      .number()
      .int()
      .min(5, 'clustering.maxNodesPerCluster must be at least 5')
      .max(100, 'clustering.maxNodesPerCluster must be at most 100')
      .default(25),
    /** Maximum estimated input tokens per cluster. */
    maxInputTokensPerCluster: z
      .number()
      .int()
      .min(1000, 'clustering.maxInputTokensPerCluster must be at least 1000')
      .max(20000, 'clustering.maxInputTokensPerCluster must be at most 20000')
      .default(8000),
    /** Enable anchor-based splitting for oversized clusters. */
    enableAnchorSplit: z.boolean().default(false),
  })
  .strip()

/**
 * Controls scheduling parameters for the Reflector agent's reflection passes.
 * A reflection pass is triggered when either condition is met:
 *   - OmgSessionState.totalObservationTokens exceeds observationTokenThreshold, or
 *   - the cronSchedule fires.
 */
const reflectionSchema = z
  .object({
    /**
     * Cumulative observation tokens that triggers a reflection pass.
     * Lower values = more frequent reflection (higher LLM cost).
     */
    observationTokenThreshold: z
      .number()
      .int()
      .positive('observationTokenThreshold must be a positive integer')
      .default(40_000),
    /**
     * 5-field cron schedule for time-based reflection passes.
     * Example: "0 3 * * *" runs at 3 AM daily.
     */
    cronSchedule: cronField.default('0 3 * * *'),
    /**
     * Minimum age in days a node must have (by its `updated` timestamp) before
     * it becomes eligible for reflection. Prevents reflecting on nodes that are
     * still being actively updated by the observer.
     * @default 3
     */
    ageCutoffDays: z
      .number()
      .int()
      .min(0, 'reflection.ageCutoffDays must be >= 0')
      .max(30, 'reflection.ageCutoffDays must be <= 30')
      .default(3),
    /** Cluster-first reflection configuration. */
    clustering: clusteringSchema.default({}),
  })
  .strip()

/**
 * Controls the semantic boosting layer within the context selector.
 * When enabled, OpenClaw's memory_search tool is used as an acceleration signal
 * that boosts registry scores. Degrades gracefully when the tool is unavailable.
 */
const semanticSchema = z
  .object({
    /**
     * Whether semantic boosting is enabled.
     * When false, memory_search is never called and scoring is registry-only.
     * @default true
     */
    enabled: z.boolean().default(true),
    /**
     * Additive weight applied to the normalised semantic score.
     * finalScore = registryScore + weight * semanticScore
     * Range [0, 2]. 0 = semantic contributes nothing (registry-only effective).
     * @default 0.4
     */
    weight: z
      .number()
      .min(0, 'injection.semantic.weight must be >= 0')
      .max(2, 'injection.semantic.weight must be <= 2')
      .default(0.4),
    /**
     * Maximum number of results to request from memory_search per turn.
     * Range [1, 100].
     * @default 20
     */
    maxResults: z
      .number()
      .int()
      .min(1, 'injection.semantic.maxResults must be at least 1')
      .max(100, 'injection.semantic.maxResults must be at most 100')
      .default(20),
    /**
     * Minimum normalised score a memory_search result must have to participate
     * in boosting. Results below this threshold are discarded after normalisation.
     * Range [0, 1].
     * @default 0.3
     */
    minScore: z
      .number()
      .min(0, 'injection.semantic.minScore must be >= 0')
      .max(1, 'injection.semantic.minScore must be <= 1')
      .default(0.3),
  })
  .strip()

/**
 * Controls how graph context is assembled and injected into the agent's
 * system prompt at the start of each conversation turn.
 */
const injectionSchema = z
  .object({
    /**
     * Maximum token budget for the injected graph context slice.
     * Nodes are ranked and trimmed to fit within this budget.
     */
    maxContextTokens: z
      .number()
      .int()
      .positive('maxContextTokens must be a positive integer')
      .default(4_000),
    /** Maximum number of MOC (Map of Content) nodes to include. */
    maxMocs: z
      .number()
      .int()
      .min(1, 'maxMocs must be at least 1')
      .default(3),
    /** Maximum number of regular knowledge nodes to include. */
    maxNodes: z
      .number()
      .int()
      .min(1, 'maxNodes must be at least 1')
      .default(5),
    /**
     * Node IDs in "namespace/slug" format that are always included in context
     * injection regardless of their ranking score.
     * Example: ["omg/identity-core", "omg/project-main"]
     */
    pinnedNodes: z.array(nodeIdField).default([]),
    /** Semantic boosting layer — integrates OpenClaw's memory_search tool. */
    semantic: semanticSchema.default({}),
  })
  .strip()

/**
 * Controls how the plugin identifies "who" is being observed across sessions.
 * Additional modes (e.g. user-account scoping) are planned for future releases.
 */
const identitySchema = z
  .object({
    /**
     * Strategy for scoping identity nodes.
     * "session-key" — nodes are scoped to the current session's key (default).
     */
    mode: z.enum(['session-key']).default('session-key'),
  })
  .strip()
  .default({ mode: 'session-key' })

// ---------------------------------------------------------------------------
// Semantic dedup schema
// ---------------------------------------------------------------------------

/**
 * Controls the LLM-based semantic dedup pass that runs after literal dedup.
 * Uses batched LLM comparison on candidate blocks to detect near-duplicates
 * that heuristic similarity misses.
 */
const semanticDedupSchema = z
  .object({
    /** Enable semantic dedup. When false, the pass is skipped entirely. */
    enabled: z.boolean().default(true),
    /**
     * Heuristic pre-filter threshold for candidate blocks. Lower than literal
     * dedup's threshold to catch near-misses. Range [0, 1].
     */
    heuristicPrefilterThreshold: z
      .number()
      .min(0, 'semanticDedup.heuristicPrefilterThreshold must be >= 0')
      .max(1, 'semanticDedup.heuristicPrefilterThreshold must be <= 1')
      .default(0.25),
    /** Minimum LLM similarity score (0–100) to accept a merge suggestion. */
    semanticMergeThreshold: z
      .number()
      .int()
      .min(50, 'semanticDedup.semanticMergeThreshold must be >= 50')
      .max(100, 'semanticDedup.semanticMergeThreshold must be <= 100')
      .default(85),
    /** Maximum nodes in a single semantic comparison block. */
    maxBlockSize: z
      .number()
      .int()
      .min(2, 'semanticDedup.maxBlockSize must be >= 2')
      .max(10, 'semanticDedup.maxBlockSize must be <= 10')
      .default(6),
    /** Maximum blocks (LLM calls) per run. Controls cost. */
    maxBlocksPerRun: z
      .number()
      .int()
      .min(1, 'semanticDedup.maxBlocksPerRun must be >= 1')
      .max(50, 'semanticDedup.maxBlocksPerRun must be <= 50')
      .default(15),
    /** Maximum body characters per node sent to the LLM for comparison. */
    maxBodyCharsPerNode: z
      .number()
      .int()
      .min(100, 'semanticDedup.maxBodyCharsPerNode must be >= 100')
      .max(2000, 'semanticDedup.maxBodyCharsPerNode must be <= 2000')
      .default(500),
    /** Nodes updated further apart than this many days are not blocked together. */
    timeWindowDays: z
      .number()
      .int()
      .min(1, 'semanticDedup.timeWindowDays must be >= 1')
      .max(90, 'semanticDedup.timeWindowDays must be <= 90')
      .default(30),
  })
  .strip()

// ---------------------------------------------------------------------------
// Extraction guardrails schema
// ---------------------------------------------------------------------------

/**
 * Controls upstream extraction guardrails at the observer stage.
 * Detects repeated source content and suppresses near-identical extractions.
 */
const extractionGuardrailsSchema = z
  .object({
    /** Enable extraction guardrails. When false, all messages pass through. */
    enabled: z.boolean().default(true),
    /** Overlap score (0–1) above which extraction is skipped entirely. */
    skipOverlapThreshold: z
      .number()
      .min(0, 'extractionGuardrails.skipOverlapThreshold must be >= 0')
      .max(1, 'extractionGuardrails.skipOverlapThreshold must be <= 1')
      .default(0.90),
    /** Overlap score (0–1) above which messages are truncated to non-overlapping portion. */
    truncateOverlapThreshold: z
      .number()
      .min(0, 'extractionGuardrails.truncateOverlapThreshold must be >= 0')
      .max(1, 'extractionGuardrails.truncateOverlapThreshold must be <= 1')
      .default(0.50),
    /** Combined similarity score (0–1) above which a candidate is suppressed post-extraction. */
    candidateSuppressionThreshold: z
      .number()
      .min(0, 'extractionGuardrails.candidateSuppressionThreshold must be >= 0')
      .max(1, 'extractionGuardrails.candidateSuppressionThreshold must be <= 1')
      .default(0.70),
    /** Number of recent source fingerprints to keep for overlap detection. */
    recentWindowSize: z
      .number()
      .int()
      .min(1, 'extractionGuardrails.recentWindowSize must be >= 1')
      .max(20, 'extractionGuardrails.recentWindowSize must be <= 20')
      .default(5),
  })
  .strip()

// ---------------------------------------------------------------------------
// Metrics schema
// ---------------------------------------------------------------------------

/**
 * Controls structured metric output from OMG pipeline stages.
 * Metrics are always emitted to stderr via console.warn with `[omg:metrics]`.
 * File output appends JSONL to `{omgRoot}/.metrics.jsonl`.
 */
const metricsSchema = z
  .object({
    /** Enable appending metrics to `{omgRoot}/.metrics.jsonl`. */
    fileOutput: z.boolean().default(false),
  })
  .strip()

// ---------------------------------------------------------------------------
// Bootstrap schema
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dedup schema
// ---------------------------------------------------------------------------

/**
 * Controls how the semantic deduplication cron job clusters and merges nodes.
 */
const dedupSchema = z
  .object({
    /**
     * Minimum combined similarity score (heuristic) for a candidate pair to
     * pass to LLM confirmation. Range [0, 1].
     */
    similarityThreshold: z
      .number()
      .min(0, 'similarityThreshold must be >= 0')
      .max(1, 'similarityThreshold must be <= 1')
      .default(0.45),
    /** Maximum clusters processed per dedup run. */
    maxClustersPerRun: z
      .number()
      .int()
      .positive('maxClustersPerRun must be a positive integer')
      .default(30),
    /** Maximum nodes in a single cluster. Range [2, 20]. */
    maxClusterSize: z
      .number()
      .int()
      .min(2, 'maxClusterSize must be at least 2')
      .max(20, 'maxClusterSize must be at most 20')
      .default(8),
    /** Maximum pairs evaluated per (type, keyPrefix) bucket. */
    maxPairsPerBucket: z
      .number()
      .int()
      .positive('maxPairsPerBucket must be a positive integer')
      .default(20),
    /**
     * For volatile node types (episode, fact), pairs whose nodes are further
     * apart than this many days are skipped.
     */
    staleDaysThreshold: z
      .number()
      .int()
      .positive('staleDaysThreshold must be a positive integer')
      .default(90),
    /**
     * Node types considered stable enough for aggressive dedup.
     * Volatile types (episode, fact) are subject to staleDaysThreshold.
     */
    stableTypes: z
      .array(z.string().min(1))
      .default(['identity', 'preference', 'decision', 'project']),
  })
  .strip()

// ---------------------------------------------------------------------------
// Merge schema
// ---------------------------------------------------------------------------

/**
 * Controls the inline merge-dedup pass that runs during each observation cycle.
 * For each extracted candidate, a retrieval pass finds close registry neighbors;
 * if a close neighbor is found, a Merge LLM call decides whether to merge, alias,
 * or keep the candidate separate.
 */
const mergeSchema = z
  .object({
    /**
     * Maximum number of local (similarity-scored) registry candidates to consider
     * per extracted node. Higher = more coverage, slower.
     */
    localTopM: z
      .number()
      .int()
      .positive('merge.localTopM must be a positive integer')
      .default(50),
    /**
     * Maximum number of semantic search results to incorporate per extracted node.
     * Only used when memory_search is available.
     */
    semanticTopS: z
      .number()
      .int()
      .positive('merge.semanticTopS must be a positive integer')
      .default(20),
    /**
     * Number of top-scored neighbors passed to the Merge LLM call.
     */
    finalTopK: z
      .number()
      .int()
      .positive('merge.finalTopK must be a positive integer')
      .default(7),
    /**
     * Weight applied to the local similarity score in the combined scoring formula.
     * finalScore = localWeight * localScore + semanticWeight * semanticScore + boosts
     */
    localWeight: z
      .number()
      .min(0, 'merge.localWeight must be >= 0')
      .max(1, 'merge.localWeight must be <= 1')
      .default(0.6),
    /**
     * Weight applied to the semantic score in the combined scoring formula.
     */
    semanticWeight: z
      .number()
      .min(0, 'merge.semanticWeight must be >= 0')
      .max(1, 'merge.semanticWeight must be <= 1')
      .default(0.4),
    /**
     * Minimum combined score for a neighbor to trigger the Merge LLM call.
     * Candidates below this threshold are written as new nodes without an LLM merge call.
     * Range [0, 1].
     */
    mergeThreshold: z
      .number()
      .min(0, 'merge.mergeThreshold must be >= 0')
      .max(1, 'merge.mergeThreshold must be <= 1')
      .default(0.4),
  })
  .strip()

// ---------------------------------------------------------------------------
// Graph maintenance schema
// ---------------------------------------------------------------------------

/**
 * Controls the combined graph-maintenance cron that runs semantic dedup
 * followed by a reflection pass on the cleaned graph.
 */
const graphMaintenanceSchema = z
  .object({
    /**
     * 5-field cron schedule for the combined graph-maintenance job.
     * Replaces the deprecated `reflection.cronSchedule` for scheduling.
     * Falls back to `reflection.cronSchedule` when not set.
     */
    cronSchedule: cronField.default('0 3 * * *'),
    /**
     * Retention window in days for archived nodes cleaned by weekly maintenance.
     * Archived nodes older than this are removed from disk and then from the
     * registry index.
     * @default 7
     */
    archivedNodeRetentionDays: z
      .number()
      .int()
      .positive('graphMaintenance.archivedNodeRetentionDays must be a positive integer')
      .default(7),
  })
  .strip()

/**
 * Controls which data sources are used during the cold-start bootstrap pass.
 * Bootstrap ingests historical data once (state machine guards re-runs) to populate
 * the graph before the agent has accumulated real observations.
 */
const bootstrapSourcesSchema = z
  .object({
    /**
     * Read markdown files from `{workspaceDir}/memory/` (excluding the OMG
     * storage path). Good for agent workspaces that maintain curated memory files.
     * Silently skipped if the directory does not exist.
     * @default true
     */
    workspaceMemory: z.boolean().default(true),
    /**
     * Read session-memory chunks from `~/.openclaw/memory/{agentId}.sqlite`.
     * These are the curated session summaries OpenClaw agents write between turns.
     * Requires `better-sqlite3` to be installed (optional dependency).
     * Silently skipped if the package is unavailable or no matching databases exist.
     * @default true
     */
    openclawSessions: z.boolean().default(true),
    /**
     * Read raw application log files from `~/.openclaw/logs/`.
     * Almost always noise (stack traces, heartbeat lines, debug output) — disabled
     * by default. Enable only for specialised diagnostic bootstraps.
     * @default false
     */
    openclawLogs: z.boolean().default(false),
  })
  .strip()

const bootstrapSchema = z
  .object({
    /** Which data sources to ingest during the cold-start bootstrap pass. */
    sources: bootstrapSourcesSchema.default({}),
    /**
     * Character budget per LLM batch during bootstrap.
     * Multiple source chunks are packed into a single LLM call until adding the
     * next chunk would exceed this budget (~4 chars per token, so 24 000 chars ≈ 6 000 tokens).
     * Set to 0 to disable batching (one chunk per call, legacy behavior).
     * @default 24000
     */
    batchCharBudget: z
      .number()
      .int()
      .min(0, 'batchCharBudget must be >= 0')
      .default(24_000),
    /**
     * Maximum number of batches processed per cron tick.
     * Controls the token budget per bootstrap tick — the cron handler processes
     * at most this many batches, then pauses until the next tick.
     * Only used by `runBootstrapTick`; `runBootstrap` (CLI `--force`) ignores this.
     * @default 20
     */
    batchBudgetPerRun: z
      .number()
      .int()
      .positive('batchBudgetPerRun must be a positive integer')
      .default(20),
    /**
     * 5-field cron schedule for the bootstrap cron job.
     * Example: `*​/5 * * * *` runs every 5 minutes.
     * @default '*​/5 * * * *'
     */
    cronSchedule: cronField.default('*/5 * * * *'),
  })
  .strip()

// ---------------------------------------------------------------------------
// Root config schema
// ---------------------------------------------------------------------------

/**
 * Zod schema for the full OMG plugin configuration.
 *
 * - Unknown keys are stripped, not rejected, to allow forward-compatibility
 *   with config files written for future plugin versions.
 * - All fields have defaults; an empty object `{}` produces a fully-valid config.
 */
export const omgConfigSchema = z
  .object({
    observer: observerSchema.default({}),
    reflector: reflectorSchema.default({}),
    observation: observationSchema.default({}),
    reflection: reflectionSchema.default({}),
    injection: injectionSchema.default({}),
    dedup: dedupSchema.default({}),
    merge: mergeSchema.default({}),
    graphMaintenance: graphMaintenanceSchema.default({}),
    identity: identitySchema,
    bootstrap: bootstrapSchema.default({}),
    metrics: metricsSchema.default({}),
    semanticDedup: semanticDedupSchema.default({}),
    extractionGuardrails: extractionGuardrailsSchema.default({}),
    /**
     * Absolute path to the workspace root directory.
     * When provided, overrides the value supplied by the OpenClaw host API.
     * Use this when OpenClaw does not pass workspaceDir through the plugin API
     * (e.g. when the plugin is registered as a global gateway-level plugin).
     *
     * Example: "/Users/alice/Projects/MyProject"
     */
    workspaceDir: z
      .string()
      .min(1, 'workspaceDir must not be empty')
      .optional(),

    /**
     * Scope string used when computing deterministic node UIDs.
     * Enables per-workspace identity isolation when multiple workspaces share a single gateway.
     * Defaults to the resolved workspace directory path at runtime when not provided.
     *
     * Example: "/Users/alice/Projects/MyProject"
     */
    scope: z
      .string()
      .min(1, 'scope must not be empty')
      .optional(),

    /**
     * Relative path from the workspace root where OMG stores its graph files.
     * Must be a non-empty relative path with no traversal components (no "." or "..").
     */
    storagePath: z
      .string()
      .min(1, 'storagePath must not be empty')
      .refine(
        (v) => !v.includes('\\'),
        { message: 'storagePath must use forward slashes only (no backslashes)' }
      )
      .refine(
        (v) => !v.startsWith('/') && !/^[a-zA-Z]:/.test(v),
        { message: 'storagePath must be a relative path (must not start with / or a drive letter)' }
      )
      .refine(
        (v) => !v.split('/').some((seg) => seg === '..' || seg === '.'),
        {
          message:
            'storagePath must not contain path traversal segments (. or ..) as standalone ' +
            'directory names — e.g. "memory/./sub" and "memory/../escape" are rejected; ' +
            '"memory/.hidden" is allowed',
        }
      )
      .refine(
        (v) => !v.endsWith('/'),
        { message: 'storagePath must not end with a trailing slash' }
      )
      .default('memory/omg'),
  })
  .strip()

// ---------------------------------------------------------------------------
// Unknown-key helpers for parseConfig
// ---------------------------------------------------------------------------

/**
 * Per-sub-schema sets of known keys, used by `collectUnknownConfigKeys` to
 * detect typos in nested config objects.
 */
const SUB_SCHEMA_SHAPES: Record<string, ReadonlySet<string>> = {
  observer: new Set(Object.keys(observerSchema.shape)), // includes: model, apiKey
  reflector: new Set(Object.keys(reflectorSchema.shape)),
  observation: new Set(Object.keys(observationSchema.shape)),
  reflection: new Set(Object.keys(reflectionSchema.shape)),
  injection: new Set(Object.keys(injectionSchema.shape)), // includes: semantic
  dedup: new Set(Object.keys(dedupSchema.shape)),
  merge: new Set(Object.keys(mergeSchema.shape)),
  graphMaintenance: new Set(Object.keys(graphMaintenanceSchema.shape)),
  bootstrap: new Set(Object.keys(bootstrapSchema.shape)), // includes: sources
  identity: new Set(['mode']),
  metrics: new Set(Object.keys(metricsSchema.shape)),
  semanticDedup: new Set(Object.keys(semanticDedupSchema.shape)),
  extractionGuardrails: new Set(Object.keys(extractionGuardrailsSchema.shape)),
}

/**
 * Known keys for two-levels-deep sub-schemas (e.g. injection.semantic.*)
 * keyed as "parentKey.childKey".
 */
const SUB_SUB_SCHEMA_SHAPES: Record<string, ReadonlySet<string>> = {
  'injection.semantic': new Set(Object.keys(semanticSchema.shape)),
  'reflection.clustering': new Set(Object.keys(clusteringSchema.shape)),
}

/**
 * Returns unknown key paths in `raw` at the top level, one level deep inside
 * recognised sub-objects (e.g. `"observer.typo"`), and two levels deep inside
 * recognised sub-sub-objects (e.g. `"injection.semantic.typo"`).
 */
function collectUnknownConfigKeys(raw: Record<string, unknown>): readonly string[] {
  const topLevelKnown = new Set(Object.keys(omgConfigSchema.shape))
  const result: string[] = []
  for (const key of Object.keys(raw)) {
    if (!topLevelKnown.has(key)) {
      result.push(key)
      continue
    }
    const subShape = SUB_SCHEMA_SHAPES[key]
    if (subShape !== undefined) {
      const nested = raw[key]
      if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
        for (const subKey of Object.keys(nested as Record<string, unknown>)) {
          if (!subShape.has(subKey)) {
            result.push(`${key}.${subKey}`)
            continue
          }
          // Check one more level deeper for recognised sub-sub-schemas
          const subSubShapeKey = `${key}.${subKey}`
          const subSubShape = SUB_SUB_SCHEMA_SHAPES[subSubShapeKey]
          if (subSubShape !== undefined) {
            const subNested = (nested as Record<string, unknown>)[subKey]
            if (subNested !== null && typeof subNested === 'object' && !Array.isArray(subNested)) {
              for (const subSubKey of Object.keys(subNested as Record<string, unknown>)) {
                if (!subSubShape.has(subSubKey)) {
                  result.push(`${subSubShapeKey}.${subSubKey}`)
                }
              }
            }
          }
        }
      }
    }
  }
  return result
}

/** Options accepted by {@link parseConfig}. */
export interface ParseConfigOptions {
  /**
   * Called with all unknown key paths (e.g. `["unknownTop", "observer.typo"]`)
   * when the raw input contains keys not recognised by the schema.
   * By default no action is taken; pass a logging function to surface warnings.
   * @example
   *   parseConfig(raw, {
   *     onUnknownKeys: (keys) => console.warn(`Unknown keys: ${keys.join(', ')}`)
   *   })
   */
  onUnknownKeys?: (keys: readonly string[]) => void
}

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Utility: recursively marks all fields and nested arrays readonly. */
type DeepReadonly<T> =
  T extends (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T

/** Fully-resolved OMG plugin configuration with all defaults applied. Immutable. */
export type OmgConfig = DeepReadonly<z.infer<typeof omgConfigSchema>>

// ---------------------------------------------------------------------------
// ConfigValidationError
// ---------------------------------------------------------------------------

/**
 * Thrown by `parseConfig` when the input contains invalid values.
 *
 * Provides a human-readable summary of all validation failures with
 * field paths, so the error message is useful without inspecting `issues`.
 * The original `ZodError` is preserved as `Error.cause` for programmatic access.
 */
export class ConfigValidationError extends Error {
  /** Structured list of validation failures, one per invalid field. */
  readonly issues: readonly z.ZodIssue[]

  /**
   * Guards against the impossible case of a ZodError with no issues.
   * Called before `super()` in the constructor — throws a plain `Error`
   * (not a `ConfigValidationError`) so callers can distinguish an internal
   * bug from a user configuration error.
   */
  static assertNonEmpty(zodError: z.ZodError): void {
    if (zodError.errors.length === 0) {
      throw new Error(
        '[omg] Internal bug: ConfigValidationError constructed with a ZodError that has no issues. ' +
        'This is a bug in the calling code, not a user configuration problem.'
      )
    }
  }

  constructor(zodError: z.ZodError) {
    // Throws a plain Error (not ConfigValidationError) if zodError has no issues.
    ConfigValidationError.assertNonEmpty(zodError)
    super(`OMG plugin configuration is invalid:\n${formatZodErrors(zodError.errors)}`, { cause: zodError })
    this.name = 'ConfigValidationError'
    this.issues = zodError.errors
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ---------------------------------------------------------------------------
// Parse function
// ---------------------------------------------------------------------------

/**
 * Parses and validates raw (unknown) config input, applying all defaults.
 *
 * - Unknown keys (top-level and one level deep inside sub-objects) are stripped.
 *   If `options.onUnknownKeys` is provided it is called with the full list of
 *   unknown paths so the caller can log or surface a warning.
 * - null model means "inherit the active model from OpenClaw".
 * - Missing config block or empty object `{}` produces all defaults.
 *
 * @throws {ConfigValidationError} if the input contains invalid values,
 *   with a human-readable field-by-field breakdown in the error message.
 */
export function parseConfig(raw: unknown, options: ParseConfigOptions = {}): OmgConfig {
  const result = omgConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigValidationError(result.error)
  }

  // Diagnostic-only: detect unknown keys to help callers catch typos.
  // Each step is wrapped independently so that neither can block the valid config
  // from being returned. Note: if collectUnknownConfigKeys throws, onUnknownKeys
  // will not be called (unknownKeys stays empty and the notification is skipped).
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    let unknownKeys: readonly string[] = []
    try {
      unknownKeys = collectUnknownConfigKeys(raw as Record<string, unknown>)
    } catch (err) {
      // Defensive: an unexpected throw from collectUnknownConfigKeys must not
      // prevent the valid config from being returned.
      console.error('[omg] Internal bug in collectUnknownConfigKeys — unknown-key detection skipped.', err)
    }
    if (unknownKeys.length > 0 && options.onUnknownKeys !== undefined) {
      try {
        options.onUnknownKeys(unknownKeys)
      } catch (err) {
        // Defensive: a throwing onUnknownKeys callback must not prevent the valid
        // config from being returned.
        console.error('[omg] parseConfig: onUnknownKeys callback threw — unknown-key notification failed.', err)
      }
    }
  }

  // Floor clamp: messageTokenThreshold below 1000 is almost certainly a
  // misconfiguration (e.g. gateway using JSON Schema "minimum" as default).
  // Would fire observation on every short turn, burning tokens. Clamp to 8000.
  const MIN_SAFE_MESSAGE_THRESHOLD = 1000
  const DEFAULT_MESSAGE_THRESHOLD = 8_000
  let validated = result.data satisfies z.infer<typeof omgConfigSchema>
  if (validated.observation.messageTokenThreshold < MIN_SAFE_MESSAGE_THRESHOLD) {
    console.warn(
      `[omg] parseConfig: messageTokenThreshold (${validated.observation.messageTokenThreshold}) ` +
      `is below minimum safe threshold (${MIN_SAFE_MESSAGE_THRESHOLD}) — clamping to ${DEFAULT_MESSAGE_THRESHOLD}`,
    )
    validated = {
      ...validated,
      observation: {
        ...validated.observation,
        messageTokenThreshold: DEFAULT_MESSAGE_THRESHOLD,
      },
    }
  }

  // Cast required: z.infer does not add readonly modifiers; OmgConfig wraps the
  // inferred type in DeepReadonly<...>. The satisfies check ensures the inferred
  // schema type and OmgConfig remain aligned at compile time.
  return validated as OmgConfig
}
