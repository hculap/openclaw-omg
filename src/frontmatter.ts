import { z } from 'zod'
import { NODE_TYPES, isNodeType, isCompressionLevel } from './types.js'
import type { NodeFrontmatter } from './types.js'
import { formatZodErrors } from './error-utils.js'

// ---------------------------------------------------------------------------
// Node ID validation
// ---------------------------------------------------------------------------

/**
 * Validates OMG node IDs in "namespace/slug" format (e.g. "omg/identity-core").
 * Mirrors the pattern used in `config.ts` for `pinnedNodes`.
 */
const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const nodeSourceSchema = z
  .object({
    sessionKey: z.string().min(1, 'sessionKey must not be empty'),
    kind: z.string().min(1, 'kind must not be empty'),
    timestamp: z
      .number()
      .int()
      .nonnegative('timestamp must be a non-negative integer (Unix epoch ms)'),
  })
  .strict()

/**
 * At least one of `sessionScope` or `identityKey` must be present.
 * Validated via a union of two shapes, each requiring one of the two fields.
 */
const nodeAppliesToSchema = z.union([
  z.object({ sessionScope: z.string(), identityKey: z.string().optional() }).strict(),
  z.object({ sessionScope: z.string().optional(), identityKey: z.string() }).strict(),
])

/**
 * ISO 8601 date-time string — validates date and time components.
 * Accepted formats: YYYY-MM-DDTHH:MM:SS[.f+](Z|±HH:MM)
 * Month: 01–12, Day: 01–31, Hour: 00–23, Minute/Second: 00–59.
 * Fractional seconds: one or more digits accepted (not limited to milliseconds).
 */
const iso8601Field = z
  .string()
  .regex(
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/,
    'must be an ISO 8601 date-time string (e.g. "2024-01-15T10:30:00Z")'
  )

/**
 * Zod schema for {@link NodeFrontmatter}.
 *
 * - Unknown keys are stripped (forward-compatible with future frontmatter fields).
 * - `updated` must be >= `created` (lexicographic ISO 8601 comparison).
 * - `type` must be a valid {@link NodeType}.
 */
export const nodeFrontmatterSchema = z
  .object({
    id: z
      .string()
      .min(1, 'id must not be empty')
      .refine((v) => NODE_ID_RE.test(v), {
        message: 'id must be in "namespace/slug" format (e.g. "omg/identity-core")',
      }),
    description: z.string(),
    type: z
      .string()
      .refine(isNodeType, { message: `type must be one of: ${NODE_TYPES.join(', ')}` }),
    priority: z.enum(['high', 'medium', 'low']),
    created: iso8601Field,
    updated: iso8601Field,
    appliesTo: nodeAppliesToSchema.optional(),
    sources: z.array(nodeSourceSchema).optional(),
    links: z.array(z.string().min(1, 'link must not be empty')).optional(),
    tags: z.array(z.string().min(1, 'tag must not be empty')).optional(),
    supersedes: z.array(z.string().min(1, 'superseded ID must not be empty')).optional(),
    compressionLevel: z
      .number()
      .refine(isCompressionLevel, { message: 'compressionLevel must be 0, 1, 2, or 3' })
      .optional(),
    archived: z.boolean().optional(),
  })
  .strip()
  .refine((f) => f.updated >= f.created, {
    message: 'updated must be >= created',
    path: ['updated'],
  })

// ---------------------------------------------------------------------------
// FrontmatterValidationError
// ---------------------------------------------------------------------------

/**
 * Thrown by `parseNodeFrontmatter` when the input contains invalid values.
 *
 * Provides a human-readable summary of all validation failures with
 * field paths. The original `ZodError` is preserved as `Error.cause`.
 */
export class FrontmatterValidationError extends Error {
  /** Structured list of validation failures, one per invalid field. */
  readonly issues: readonly z.ZodIssue[]

  /**
   * Guards against the impossible case of a ZodError with no issues.
   * Throws a plain `Error` (not a `FrontmatterValidationError`) so callers
   * can distinguish an internal bug from a user input error.
   */
  static assertNonEmpty(zodError: z.ZodError): void {
    if (zodError.errors.length === 0) {
      throw new Error(
        '[omg] Internal bug: FrontmatterValidationError constructed with a ZodError that has no issues. ' +
        'This is a bug in the calling code, not a user input problem.'
      )
    }
  }

  constructor(zodError: z.ZodError) {
    // Throws a plain Error (not FrontmatterValidationError) if zodError has no issues.
    FrontmatterValidationError.assertNonEmpty(zodError)
    super(`OMG node frontmatter is invalid:\n${formatZodErrors(zodError.errors)}`, { cause: zodError })
    this.name = 'FrontmatterValidationError'
    this.issues = zodError.errors
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

// ---------------------------------------------------------------------------
// Parse function
// ---------------------------------------------------------------------------

/**
 * Parses and validates raw (unknown) frontmatter input from YAML or LLM output.
 *
 * - Unknown keys are stripped.
 * - `type` must be a valid `NodeType`; `priority` must be `high | medium | low`.
 * - `created` and `updated` must be ISO 8601 date-time strings; `updated >= created`.
 * - `appliesTo`, if present, must have at least one of `sessionScope` or `identityKey`.
 *
 * @throws {FrontmatterValidationError} if the input contains invalid values,
 *   with a human-readable field-by-field breakdown in the error message.
 */
export function parseNodeFrontmatter(raw: unknown): NodeFrontmatter {
  const result = nodeFrontmatterSchema.safeParse(raw)
  if (!result.success) {
    throw new FrontmatterValidationError(result.error)
  }
  // Cast required: z.infer does not add readonly modifiers; NodeFrontmatter has
  // readonly fields. The shapes are structurally identical at runtime.
  return result.data as NodeFrontmatter
}
