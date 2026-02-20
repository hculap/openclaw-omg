import { z } from 'zod'

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
const MODEL_FORMAT_RE = /^[a-z0-9-]+\/[a-z0-9._:-]+$/

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
 * Both namespace and slug are lowercase alphanumeric with hyphens, dots, and underscores.
 */
const NODE_ID_RE = /^[a-z0-9-]+\/[a-z0-9._-]+$/

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
 *   N-N       — inclusive range
 *   * /N      — step (N ≥ 1); e.g. "* /15" means every 15 units
 *
 * Field ranges: minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-7.
 * Comma-separated lists are not supported.
 * Note: structural ranges are validated; semantically nonsensical combinations
 * (e.g. "Feb 31") are not rejected.
 */
// Each field: * | */N (step, N≥1) | value-in-range | range N-N
const CRON_MINUTE = '(?:\\*(?:/[1-9]\\d*)?|[0-5]?[0-9](?:-[0-5]?[0-9])?)'
const CRON_HOUR   = '(?:\\*(?:/[1-9]\\d*)?|[01]?[0-9](?:-[01]?[0-9])?|2[0-3](?:-2[0-3])?)'
const CRON_DOM    = '(?:\\*(?:/[1-9]\\d*)?|[1-9](?:-[1-9])?|[12][0-9](?:-[12][0-9])?|3[01](?:-3[01])?)'
const CRON_MONTH  = '(?:\\*(?:/[1-9]\\d*)?|[1-9](?:-[1-9])?|1[0-2](?:-1[0-2])?)'
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
 * The Observer is triggered when `pendingMessageTokens` exceeds
 * `messageTokenThreshold`, or manually via `triggerMode: 'manual'`.
 */
const observationSchema = z
  .object({
    /**
     * Accumulated token count of unprocessed messages that triggers an observation run.
     * Lower values = more frequent observation (higher LLM cost).
     */
    messageTokenThreshold: z
      .number()
      .int()
      .positive('messageTokenThreshold must be a positive integer')
      .default(30_000),
    /**
     * How observation runs are triggered:
     * - "threshold" — automatically when messageTokenThreshold is reached (default)
     * - "manual" — only when explicitly invoked via the observational-memory-graph skill
     */
    triggerMode: z.enum(['threshold', 'manual']).default('threshold'),
  })
  .strip()

/**
 * Controls when the Reflector agent runs to compress and synthesise the graph.
 * Reflection is triggered when `totalObservationTokens` exceeds
 * `observationTokenThreshold`, and/or on the `cronSchedule`.
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
    mode: z.enum(['session-key']),
  })
  .strip()
  .default({ mode: 'session-key' })

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
    identity: identitySchema,
    /**
     * Relative path from the workspace root where OMG stores its graph files.
     * Must be a non-empty relative path with no traversal components (no "..").
     */
    storagePath: z
      .string()
      .min(1, 'storagePath must not be empty')
      .refine(
        (v) => !v.includes('..'),
        { message: 'storagePath must not contain path traversal sequences (..)' }
      )
      .default('memory/omg'),
  })
  .strip()

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

  constructor(zodError: z.ZodError) {
    const formatted = zodError.errors
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
        return `  ${path}: ${issue.message}`
      })
      .join('\n')
    super(`OMG plugin configuration is invalid:\n${formatted}`, { cause: zodError })
    this.name = 'ConfigValidationError'
    this.issues = zodError.errors
  }
}

// ---------------------------------------------------------------------------
// Parse function
// ---------------------------------------------------------------------------

/**
 * Parses and validates raw (unknown) config input, applying all defaults.
 *
 * - Unknown keys are stripped silently (forward-compatibility).
 * - null model means "inherit the active model from OpenClaw".
 * - Missing config block or empty object `{}` produces all defaults.
 *
 * @throws {ConfigValidationError} if the input contains invalid values,
 *   with a human-readable field-by-field breakdown in the error message.
 */
export function parseConfig(raw: unknown): OmgConfig {
  const result = omgConfigSchema.safeParse(raw)
  if (!result.success) {
    throw new ConfigValidationError(result.error)
  }
  return result.data as OmgConfig
}
