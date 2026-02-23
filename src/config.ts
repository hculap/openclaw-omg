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
      .default(80_000),
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
  })
  .strip()

/**
 * Controls which data sources are used during the cold-start bootstrap pass.
 * Bootstrap ingests historical data once (sentinel guards re-runs) to populate
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
    graphMaintenance: graphMaintenanceSchema.default({}),
    identity: identitySchema,
    bootstrap: bootstrapSchema.default({}),
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
  graphMaintenance: new Set(Object.keys(graphMaintenanceSchema.shape)),
  bootstrap: new Set(Object.keys(bootstrapSchema.shape)), // includes: sources
  identity: new Set(['mode']),
}

/**
 * Known keys for two-levels-deep sub-schemas (e.g. injection.semantic.*)
 * keyed as "parentKey.childKey".
 */
const SUB_SUB_SCHEMA_SHAPES: Record<string, ReadonlySet<string>> = {
  'injection.semantic': new Set(Object.keys(semanticSchema.shape)),
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

  // Cast required: z.infer does not add readonly modifiers; OmgConfig wraps the
  // inferred type in DeepReadonly<...>. The satisfies check ensures the inferred
  // schema type and OmgConfig remain aligned at compile time.
  const validated = result.data satisfies z.infer<typeof omgConfigSchema>
  return validated as OmgConfig
}
