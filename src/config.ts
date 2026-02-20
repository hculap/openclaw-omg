import { z } from 'zod'

// ---------------------------------------------------------------------------
// Model string validation
// ---------------------------------------------------------------------------

/**
 * Validates LLM model identifiers in the format "provider/model-name".
 * null = inherit the active model from OpenClaw's agent configuration.
 *
 * Examples of valid strings:
 *   "openai/gpt-4o-mini"
 *   "anthropic/claude-3-5-haiku"
 *   "openai/gpt-4.1-mini"
 */
const MODEL_FORMAT_RE = /^[a-z0-9-]+\/[a-z0-9._:-]+$/i

const modelField = z
  .string()
  .nullable()
  .refine(
    (v) => v === null || MODEL_FORMAT_RE.test(v),
    {
      message:
        'Model must be null or a string in "provider/model-name" format (e.g. "openai/gpt-4o-mini")',
    }
  )
  .default(null)

// ---------------------------------------------------------------------------
// Cron schedule validation
// ---------------------------------------------------------------------------

/**
 * Validates a standard 5-field cron expression (minute hour dom month dow).
 * Supports numeric values, asterisks, and step notation (e.g. "every 15 min").
 */
const CRON_FIELD = '(\\*|\\*/\\d+|\\d+(-\\d+)?)'
const CRON_RE = new RegExp(`^${CRON_FIELD}\\s+${CRON_FIELD}\\s+${CRON_FIELD}\\s+${CRON_FIELD}\\s+${CRON_FIELD}$`)

const cronField = z
  .string()
  .refine((v) => CRON_RE.test(v), {
    message: 'cronSchedule must be a valid 5-field cron expression (e.g. "0 3 * * *")',
  })

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const observerSchema = z
  .object({
    model: modelField,
  })
  .strip()

const reflectorSchema = z
  .object({
    model: modelField,
  })
  .strip()

const observationSchema = z
  .object({
    messageTokenThreshold: z
      .number()
      .int()
      .positive('messageTokenThreshold must be a positive integer')
      .default(30_000),
    triggerMode: z.enum(['threshold', 'manual']).default('threshold'),
  })
  .strip()

const reflectionSchema = z
  .object({
    observationTokenThreshold: z
      .number()
      .int()
      .positive('observationTokenThreshold must be a positive integer')
      .default(40_000),
    cronSchedule: cronField.default('0 3 * * *'),
  })
  .strip()

const injectionSchema = z
  .object({
    maxContextTokens: z
      .number()
      .int()
      .positive('maxContextTokens must be a positive integer')
      .default(4_000),
    maxMocs: z
      .number()
      .int()
      .min(1, 'maxMocs must be at least 1')
      .default(3),
    maxNodes: z
      .number()
      .int()
      .min(1, 'maxNodes must be at least 1')
      .default(5),
    pinnedNodes: z.array(z.string()).default([]),
  })
  .strip()

const identitySchema = z
  .object({
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
 * Unknown keys are stripped (not rejected) to allow forward-compatibility
 * with config files written for future plugin versions.
 */
export const omgConfigSchema = z
  .object({
    observer: observerSchema.default({}),
    reflector: reflectorSchema.default({}),
    observation: observationSchema.default({}),
    reflection: reflectionSchema.default({}),
    injection: injectionSchema.default({}),
    identity: identitySchema,
    storagePath: z.string().default('memory/omg'),
  })
  .strip()

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/** Fully-resolved OMG plugin configuration with all defaults applied. */
export type OmgConfig = z.infer<typeof omgConfigSchema>

// ---------------------------------------------------------------------------
// Parse function
// ---------------------------------------------------------------------------

/**
 * Parses and validates raw (unknown) config input, applying all defaults.
 *
 * - Unknown keys are stripped silently (forward-compatibility).
 * - Invalid values throw a ZodError with descriptive messages.
 * - null model means "inherit the active model from OpenClaw".
 *
 * @throws {z.ZodError} if the input contains invalid values.
 */
export function parseConfig(raw: unknown): OmgConfig {
  return omgConfigSchema.parse(raw)
}
