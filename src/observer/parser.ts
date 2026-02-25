/**
 * XML parser for the Observer LLM output.
 *
 * Converts raw LLM text (expected to be XML) into an {@link ObserverOutput}.
 * `parseObserverOutput` never throws. On any parse failure, logs the problem
 * and returns an empty ObserverOutput — operations that cannot be reliably
 * parsed are dropped rather than fabricated from heuristics.
 *
 * Recovery features:
 *   - Case-insensitive type matching (e.g. "Identity" → "identity")
 *   - Type inference from canonical-key prefix (e.g. "preferences.theme" → "preference")
 *   - Canonical-key generation from type + title when key is missing
 *   - Alternative root element recovery (<operations>, <output>, <response>)
 *   - Structured diagnostics for rejected operations
 */

import { XMLParser } from 'fast-xml-parser'
import type {
  ObserverOutput,
  ObserverOperation,
  NodeType,
  Priority,
  ExtractOutput,
  ExtractCandidate,
  NowPatch,
} from '../types.js'
import { isNodeType, coerceNodeType, inferNodeTypeFromKey } from '../types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMPTY_OUTPUT: ObserverOutput = Object.freeze({
  operations: Object.freeze([]) as readonly ObserverOperation[],
  nowUpdate: null,
  mocUpdates: Object.freeze([]) as readonly string[],
})

const VALID_PRIORITIES = new Set<string>(['high', 'medium', 'low'])

/**
 * Alternative root element names the LLM may produce instead of `<observations>`.
 * Ordered from outermost (container) to innermost — `<output>` and `<response>`
 * are checked before `<operations>` because `<operations>` commonly appears as a
 * child inside those wrappers and would match their inner content via regex.
 */
const ALTERNATIVE_ROOTS = ['output', 'response', 'operations'] as const

// ---------------------------------------------------------------------------
// Diagnostics types
// ---------------------------------------------------------------------------

export interface ParserRejection {
  readonly reason: string
  readonly rawSnippet: string
}

export interface ParserDiagnostics {
  readonly totalCandidates: number
  readonly accepted: number
  readonly rejected: readonly ParserRejection[]
}

// ---------------------------------------------------------------------------
// XML parser configuration
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Ensure these elements are always parsed as arrays even when there is only one.
  isArray: (name: string) => name === 'operation',
  // Prevent numeric-looking content from being coerced to numbers.
  parseAttributeValue: false,
  parseTagValue: false,
  // Trim whitespace from tag values so multi-line content blocks are clean.
  trimValues: true,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coercePriority(raw: unknown, canonicalKey?: string): Priority {
  if (typeof raw === 'string' && VALID_PRIORITIES.has(raw)) {
    return raw as Priority
  }
  console.warn(
    `[omg] Observer parser: unknown priority "${String(raw)}" — defaulting to "medium"${canonicalKey ? ` (canonical-key="${canonicalKey}")` : ''}`,
  )
  return 'medium'
}

function extractCommaSeparated(raw: unknown): readonly string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/**
 * Converts a title string into a slug suitable for canonical keys.
 * E.g. "Editor Theme Preference" → "editor_theme_preference"
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80)
}

/**
 * Summarizes the key fields of a raw operation for diagnostic output.
 * Returns the first 200 characters.
 */
function summarizeRawOp(op: Record<string, unknown>): string {
  const parts: string[] = []
  const type = op['@_type']
  const key = op['canonical-key']
  const title = op['title']
  const desc = op['description']
  if (type !== undefined) parts.push(`type="${String(type)}"`)
  if (key !== undefined) parts.push(`key="${String(key)}"`)
  if (title !== undefined) parts.push(`title="${String(title)}"`)
  if (desc !== undefined) parts.push(`desc="${String(desc)}"`)
  const summary = parts.join(', ')
  return summary.slice(0, 200)
}

// ---------------------------------------------------------------------------
// Shared field coercion (Phase 1)
// ---------------------------------------------------------------------------

interface CoercedFields {
  readonly type: NodeType
  readonly canonicalKey: string
  readonly title: string
  readonly description: string
  readonly body: string
  readonly priority: Priority
  readonly mocHints: readonly string[]
  readonly tags: readonly string[]
  readonly linkKeys: readonly string[]
}

/**
 * Coerces operation fields with tolerance for common LLM variations.
 * Returns the coerced fields or null with a rejection reason.
 */
function coerceOperationFields(
  op: Record<string, unknown>,
  logPrefix: string,
): { fields: CoercedFields; rejection: null } | { fields: null; rejection: ParserRejection } {
  const rawKey = typeof op['canonical-key'] === 'string' ? op['canonical-key'].trim() : ''
  const rawType = op['@_type']
  const rawPriority = op['@_priority']
  const title = typeof op['title'] === 'string' ? op['title'].trim() : ''
  const description = typeof op['description'] === 'string' ? op['description'].trim() : ''
  const snippet = summarizeRawOp(op)

  // Step 1: Resolve type — coerce case-insensitively first
  let resolvedType = coerceNodeType(rawType)

  // Step 2: If type coercion failed but key has recognizable prefix, infer type
  if (resolvedType === null && rawKey) {
    resolvedType = inferNodeTypeFromKey(rawKey)
    if (resolvedType !== null) {
      console.warn(
        `${logPrefix} recovered type "${resolvedType}" from key prefix (raw type="${String(rawType)}", key="${rawKey}")`,
      )
    }
  }

  // Step 3: If still no type, reject
  if (resolvedType === null) {
    const reason = rawKey
      ? `unknown type "${String(rawType)}" (key="${rawKey}")`
      : `unknown type "${String(rawType)}" and no key to infer from`
    console.warn(`${logPrefix} dropping — ${reason}`)
    return { fields: null, rejection: { reason, rawSnippet: snippet } }
  }

  // Step 4: Resolve canonical-key — generate from type + title if missing
  let resolvedKey = rawKey
  if (!resolvedKey && title) {
    resolvedKey = `${resolvedType}.${slugify(title)}`
    console.warn(
      `${logPrefix} generated canonical-key "${resolvedKey}" from type + title (raw key was empty)`,
    )
  }

  if (!resolvedKey) {
    const reason = `missing canonical-key and no title to generate one (type="${resolvedType}")`
    console.warn(`${logPrefix} dropping — ${reason}`)
    return { fields: null, rejection: { reason, rawSnippet: snippet } }
  }

  // Step 5: Validate description
  if (!description) {
    const reason = `missing description (key="${resolvedKey}")`
    console.warn(`${logPrefix} dropping — ${reason}`)
    return { fields: null, rejection: { reason, rawSnippet: snippet } }
  }

  const priority = coercePriority(rawPriority, resolvedKey)
  const body = typeof op['content'] === 'string' ? op['content'].trim() : ''
  const mocHints = extractCommaSeparated(op['moc-hints'])
  const tags = extractCommaSeparated(op['tags'])
  const linkKeys = extractCommaSeparated(op['links'])

  return {
    fields: {
      type: resolvedType,
      canonicalKey: resolvedKey,
      title,
      description,
      body,
      priority,
      mocHints,
      tags,
      linkKeys,
    },
    rejection: null,
  }
}

// ---------------------------------------------------------------------------
// Operation / Candidate parsers
// ---------------------------------------------------------------------------

/** Parse a single `<operation>` element into an ObserverOperation (upsert kind). */
function parseOperation(
  op: Record<string, unknown>,
  rejections: ParserRejection[],
): ObserverOperation | null {
  const result = coerceOperationFields(op, '[omg] Observer parser:')
  if (result.fields === null) {
    rejections.push(result.rejection)
    return null
  }
  const f = result.fields
  return {
    kind: 'upsert',
    canonicalKey: f.canonicalKey,
    type: f.type,
    title: f.title,
    description: f.description,
    body: f.body,
    priority: f.priority,
    ...(f.mocHints.length > 0 ? { mocHints: f.mocHints } : {}),
    ...(f.linkKeys.length > 0 ? { linkKeys: f.linkKeys } : {}),
    ...(f.tags.length > 0 ? { tags: f.tags } : {}),
  }
}

/**
 * Maps a parsed `<operation>` element to an ExtractCandidate.
 * Same field extraction as parseOperation but returns ExtractCandidate.
 */
function parseCandidate(
  op: Record<string, unknown>,
  rejections: ParserRejection[],
): ExtractCandidate | null {
  const result = coerceOperationFields(op, '[omg] Extract parser:')
  if (result.fields === null) {
    rejections.push(result.rejection)
    return null
  }
  const f = result.fields
  return {
    type: f.type,
    canonicalKey: f.canonicalKey,
    title: f.title,
    description: f.description,
    body: f.body,
    priority: f.priority,
    ...(f.mocHints.length > 0 ? { mocHints: f.mocHints } : {}),
    ...(f.linkKeys.length > 0 ? { linkKeys: f.linkKeys } : {}),
    ...(f.tags.length > 0 ? { tags: f.tags } : {}),
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Derives the list of MOC domains to update from all operations' mocHints.
 * Deduplicates across all operations.
 */
function deriveMocUpdates(operations: readonly ObserverOperation[]): readonly string[] {
  const seen = new Set<string>()
  const results: string[] = []
  for (const op of operations) {
    if (op.kind !== 'upsert') continue
    for (const hint of op.mocHints ?? []) {
      if (!seen.has(hint)) {
        seen.add(hint)
        results.push(hint)
      }
    }
  }
  return results
}

/**
 * Derives mocUpdates from candidates' mocHints (deduplicated).
 */
function deriveMocUpdatesFromCandidates(candidates: readonly ExtractCandidate[]): readonly string[] {
  const seen = new Set<string>()
  const results: string[] = []
  for (const c of candidates) {
    for (const hint of c.mocHints ?? []) {
      if (!seen.has(hint)) {
        seen.add(hint)
        results.push(hint)
      }
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Root element recovery (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Extracts the XML root element with fallback to alternative root names.
 * Tries `<observations>` first, then `<operations>`, `<output>`, `<response>`.
 *
 * When an alternative root is found:
 *   - If `<operations>` is found directly, wraps it as `{ operations: ... }` so
 *     downstream lookup works the same.
 *   - Other alternative roots are used as-is (they may contain `<operations>` inside).
 *
 * Returns { root, recovered } where `recovered` is the alternative root name
 * or null if the primary root was found.
 */
function extractXmlRoot(
  raw: string,
  logPrefix: string,
): { xmlSource: string; parsed: Record<string, unknown>; root: Record<string, unknown>; recovered: string | null } | null {
  // Try primary root <observations>
  const primaryMatch = raw.match(/<observations[\s\S]*?<\/observations>/)
  if (primaryMatch) {
    const xmlSource = primaryMatch[0]
    const parseResult = safeParse(xmlSource, logPrefix)
    if (parseResult === null) return null
    const root = parseResult['observations'] as Record<string, unknown> | undefined
    if (root !== undefined && root !== null) {
      return { xmlSource, parsed: parseResult, root, recovered: null }
    }
  }

  // Try alternative roots
  for (const altName of ALTERNATIVE_ROOTS) {
    const altMatch = raw.match(new RegExp(`<${altName}[\\s\\S]*?<\\/${altName}>`))
    if (!altMatch) continue

    const xmlSource = altMatch[0]
    const parseResult = safeParse(xmlSource, logPrefix)
    if (parseResult === null) continue

    const altRoot = parseResult[altName] as Record<string, unknown> | unknown[] | undefined
    if (altRoot === undefined || altRoot === null) continue

    console.warn(
      `${logPrefix} recovered via alternative root <${altName}> — expected <observations>`,
    )

    // If the alternative root is <operations>, wrap so downstream finds root.operations
    if (altName === 'operations') {
      return {
        xmlSource,
        parsed: parseResult,
        root: { operations: altRoot } as Record<string, unknown>,
        recovered: altName,
      }
    }

    // Other roots: use as-is (they may contain <operations> inside)
    if (typeof altRoot === 'object' && !Array.isArray(altRoot)) {
      return { xmlSource, parsed: parseResult, root: altRoot, recovered: altName }
    }
  }

  // Last resort: try parsing the entire raw input
  const parseResult = safeParse(raw.trim(), logPrefix)
  if (parseResult !== null) {
    const root = parseResult['observations'] as Record<string, unknown> | undefined
    if (root !== undefined && root !== null) {
      return { xmlSource: raw.trim(), parsed: parseResult, root, recovered: null }
    }
  }

  return null
}

function safeParse(xmlSource: string, logPrefix: string): Record<string, unknown> | null {
  try {
    const result = xmlParser.parse(xmlSource) as Record<string, unknown>
    if (typeof result !== 'object' || result === null) {
      return null
    }
    return result
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Diagnostics logging
// ---------------------------------------------------------------------------

function logDiagnostics(logPrefix: string, diagnostics: ParserDiagnostics): void {
  const { totalCandidates, accepted, rejected } = diagnostics
  if (rejected.length === 0) {
    if (totalCandidates > 0) {
      console.log(`${logPrefix} ${accepted}/${totalCandidates} candidates accepted`)
    }
    return
  }
  const reasons = rejected.map((r) => r.reason).join('; ')
  console.warn(
    `${logPrefix} ${accepted}/${totalCandidates} candidates accepted, ${rejected.length} rejected: [${reasons}]`,
  )
}

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

/**
 * Parses the raw LLM output string into an {@link ObserverOutput}.
 *
 * Never throws. Returns an empty ObserverOutput when:
 *   - The input is empty or not a string.
 *   - XML parsing fails (parse error is logged).
 *   - No recognizable root element is found (logged).
 *
 * Recovery:
 *   - Case-insensitive type matching.
 *   - Type inference from canonical-key prefix.
 *   - Canonical-key generation from type + title.
 *   - Alternative root elements (<operations>, <output>, <response>).
 *
 * Individual operations that fail field validation are dropped; each rejection
 * is logged at warn level with the specific field and value so callers can detect schema drift.
 */
export function parseObserverOutput(raw: string): ObserverOutput {
  if (typeof raw !== 'string') {
    console.error('[omg] Observer parser: received non-string input — this is a bug in the LLM client layer')
    return { ...EMPTY_OUTPUT }
  }
  if (raw.trim() === '') {
    console.warn('[omg] Observer parser: LLM returned an empty response — no operations will be extracted')
    return { ...EMPTY_OUTPUT }
  }

  const extracted = extractXmlRoot(raw, '[omg] Observer parser:')
  if (extracted === null) {
    console.error('[omg] Observer parser: no recognizable root element found — returning empty output')
    return { ...EMPTY_OUTPUT }
  }

  const { root } = extracted

  const operations: ObserverOperation[] = []
  const rejections: ParserRejection[] = []
  const opsNode = root['operations'] as Record<string, unknown> | undefined
  let totalCandidates = 0

  if (opsNode !== undefined && opsNode !== null && typeof opsNode === 'object') {
    const rawOps = opsNode['operation']
    const opArray = Array.isArray(rawOps) ? rawOps : []

    for (const op of opArray) {
      if (op === null || typeof op !== 'object') continue
      totalCandidates++
      const parsedOp = parseOperation(op as Record<string, unknown>, rejections)
      if (parsedOp !== null) {
        operations.push(parsedOp)
      }
    }
  }

  const diagnostics: ParserDiagnostics = {
    totalCandidates,
    accepted: operations.length,
    rejected: rejections,
  }
  logDiagnostics('[omg] Observer parser:', diagnostics)

  const rawNow = root['now-update']
  const nowUpdate = typeof rawNow === 'string' && rawNow.trim().length > 0
    ? rawNow.trim()
    : null

  // MOC updates are derived from operations' mocHints — not from a separate XML element.
  const mocUpdates = deriveMocUpdates(operations)

  return { operations, nowUpdate, mocUpdates }
}

// ---------------------------------------------------------------------------
// Extract output parser (Phase 5 — split observer)
// ---------------------------------------------------------------------------

/** Empty ExtractOutput returned on any parse failure. */
export const EMPTY_EXTRACT_OUTPUT: ExtractOutput = Object.freeze({
  candidates: Object.freeze([]) as readonly ExtractCandidate[],
  nowPatch: null,
  mocUpdates: Object.freeze([]) as readonly string[],
})

/**
 * Parses a `<now-patch>` element into a NowPatch.
 * Returns null if the element is missing or malformed.
 */
function parseNowPatch(raw: unknown): NowPatch | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null

  const patch = raw as Record<string, unknown>
  const focus = typeof patch['focus'] === 'string' ? patch['focus'].trim() : ''
  if (!focus) return null

  const openLoops = extractCommaSeparated(patch['open-loops'])
  const suggestedLinks = extractCommaSeparated(patch['suggested-links'])

  return {
    focus: focus.slice(0, 200),
    openLoops,
    suggestedLinks,
  }
}

/**
 * Parses the raw LLM output from the Extract phase into an {@link ExtractOutput}.
 *
 * Never throws. Returns an empty ExtractOutput on any parse failure.
 * Parses `<operations>` the same way as `parseObserverOutput`, but maps
 * them to `ExtractCandidate[]` instead of `ObserverOperation[]`.
 * Parses `<now-patch>` into a structured `NowPatch` (not free-form markdown).
 */
export function parseExtractOutput(raw: string): ExtractOutput {
  if (typeof raw !== 'string') {
    console.error('[omg] Extract parser: received non-string input — this is a bug in the LLM client layer')
    return { ...EMPTY_EXTRACT_OUTPUT }
  }
  if (raw.trim() === '') {
    console.warn('[omg] Extract parser: LLM returned an empty response — no candidates will be extracted')
    return { ...EMPTY_EXTRACT_OUTPUT }
  }

  const extracted = extractXmlRoot(raw, '[omg] Extract parser:')
  if (extracted === null) {
    console.error('[omg] Extract parser: no recognizable root element found — returning empty output')
    return { ...EMPTY_EXTRACT_OUTPUT }
  }

  const { root } = extracted

  const candidates: ExtractCandidate[] = []
  const rejections: ParserRejection[] = []
  const opsNode = root['operations'] as Record<string, unknown> | undefined
  let totalCandidates = 0

  if (opsNode !== undefined && opsNode !== null && typeof opsNode === 'object') {
    const rawOps = opsNode['operation']
    const opArray = Array.isArray(rawOps) ? rawOps : []

    for (const op of opArray) {
      if (op === null || typeof op !== 'object') continue
      totalCandidates++
      const candidate = parseCandidate(op as Record<string, unknown>, rejections)
      if (candidate !== null) {
        candidates.push(candidate)
      }
    }
  }

  const diagnostics: ParserDiagnostics = {
    totalCandidates,
    accepted: candidates.length,
    rejected: rejections,
  }
  logDiagnostics('[omg] Extract parser:', diagnostics)

  const nowPatch = parseNowPatch(root['now-patch'])
  const mocUpdates = deriveMocUpdatesFromCandidates(candidates)

  return { candidates, nowPatch, mocUpdates }
}

/**
 * Parses extract output and returns diagnostics alongside the output.
 * For callers that need programmatic access to rejection details.
 */
export function parseExtractOutputWithDiagnostics(
  raw: string,
): { output: ExtractOutput; diagnostics: ParserDiagnostics } {
  if (typeof raw !== 'string') {
    console.error('[omg] Extract parser: received non-string input — this is a bug in the LLM client layer')
    return {
      output: { ...EMPTY_EXTRACT_OUTPUT },
      diagnostics: { totalCandidates: 0, accepted: 0, rejected: [] },
    }
  }
  if (raw.trim() === '') {
    console.warn('[omg] Extract parser: LLM returned an empty response — no candidates will be extracted')
    return {
      output: { ...EMPTY_EXTRACT_OUTPUT },
      diagnostics: { totalCandidates: 0, accepted: 0, rejected: [] },
    }
  }

  const extracted = extractXmlRoot(raw, '[omg] Extract parser:')
  if (extracted === null) {
    console.error('[omg] Extract parser: no recognizable root element found — returning empty output')
    return {
      output: { ...EMPTY_EXTRACT_OUTPUT },
      diagnostics: { totalCandidates: 0, accepted: 0, rejected: [] },
    }
  }

  const { root } = extracted

  const candidates: ExtractCandidate[] = []
  const rejections: ParserRejection[] = []
  const opsNode = root['operations'] as Record<string, unknown> | undefined
  let totalCandidates = 0

  if (opsNode !== undefined && opsNode !== null && typeof opsNode === 'object') {
    const rawOps = opsNode['operation']
    const opArray = Array.isArray(rawOps) ? rawOps : []

    for (const op of opArray) {
      if (op === null || typeof op !== 'object') continue
      totalCandidates++
      const candidate = parseCandidate(op as Record<string, unknown>, rejections)
      if (candidate !== null) {
        candidates.push(candidate)
      }
    }
  }

  const diagnostics: ParserDiagnostics = {
    totalCandidates,
    accepted: candidates.length,
    rejected: rejections,
  }
  logDiagnostics('[omg] Extract parser:', diagnostics)

  const nowPatch = parseNowPatch(root['now-patch'])
  const mocUpdates = deriveMocUpdatesFromCandidates(candidates)

  return {
    output: { candidates, nowPatch, mocUpdates },
    diagnostics,
  }
}
