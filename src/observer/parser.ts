/**
 * XML parser for the Observer LLM output.
 *
 * Converts raw LLM text (expected to be XML) into an {@link ObserverOutput}.
 * `parseObserverOutput` never throws. On any parse failure, logs the problem
 * and returns an empty ObserverOutput — operations that cannot be reliably
 * parsed are dropped rather than fabricated from heuristics.
 */

import { XMLParser } from 'fast-xml-parser'
import type {
  ObserverOutput,
  ObserverOperation,
  Priority,
  ExtractOutput,
  ExtractCandidate,
  NowPatch,
} from '../types.js'
import { isNodeType } from '../types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMPTY_OUTPUT: ObserverOutput = Object.freeze({
  operations: Object.freeze([]) as readonly ObserverOperation[],
  nowUpdate: null,
  mocUpdates: Object.freeze([]) as readonly string[],
})

const VALID_PRIORITIES = new Set<string>(['high', 'medium', 'low'])

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

/** Parse a single `<operation>` element into an ObserverOperation (upsert kind). */
function parseOperation(op: Record<string, unknown>): ObserverOperation | null {
  const canonicalKey = typeof op['canonical-key'] === 'string' ? op['canonical-key'].trim() : ''
  const rawType = op['@_type']
  const rawPriority = op['@_priority']

  if (!canonicalKey) {
    console.warn(
      `[omg] Observer parser: dropping operation — missing canonical-key (type="${String(rawType)}")`,
    )
    return null
  }

  if (!isNodeType(rawType)) {
    console.warn(
      `[omg] Observer parser: dropping operation — unknown type "${String(rawType)}" (canonical-key="${canonicalKey}")`,
    )
    return null
  }

  const title = typeof op['title'] === 'string' ? op['title'].trim() : ''
  const description = typeof op['description'] === 'string' ? op['description'].trim() : ''

  if (!description) {
    console.warn(
      `[omg] Observer parser: dropping operation — missing description or title (canonical-key="${canonicalKey}")`,
    )
    return null
  }

  const type = rawType
  const priority = coercePriority(rawPriority, canonicalKey)
  const body = typeof op['content'] === 'string' ? op['content'].trim() : ''
  const mocHints = extractCommaSeparated(op['moc-hints'])
  const tags = extractCommaSeparated(op['tags'])
  const linkKeys = extractCommaSeparated(op['links'])

  return {
    kind: 'upsert',
    canonicalKey,
    type,
    title,
    description,
    body,
    priority,
    ...(mocHints.length > 0 ? { mocHints } : {}),
    ...(linkKeys.length > 0 ? { linkKeys } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  }
}

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

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parses the raw LLM output string into an {@link ObserverOutput}.
 *
 * Never throws. Returns an empty ObserverOutput when:
 *   - The input is empty or not a string.
 *   - XML parsing fails (parse error is logged).
 *   - The `<observations>` root element is absent (logged).
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

  // Extract the XML block — the LLM may wrap it in ``` fences or add preamble text.
  const xmlMatch = raw.match(/<observations[\s\S]*?<\/observations>/)
  const xmlSource = xmlMatch ? xmlMatch[0] : raw.trim()

  let parsed: Record<string, unknown>
  try {
    const result = xmlParser.parse(xmlSource) as Record<string, unknown>
    if (typeof result !== 'object' || result === null) {
      console.error('[omg] Observer parser: XMLParser returned a non-object result — returning empty output')
      return { ...EMPTY_OUTPUT }
    }
    parsed = result
  } catch (err) {
    console.error(
      '[omg] Observer parser: XMLParser.parse() threw — returning empty output.',
      err instanceof Error ? err.message : String(err),
    )
    return { ...EMPTY_OUTPUT }
  }

  const root = parsed['observations'] as Record<string, unknown> | undefined
  if (root === undefined || root === null) {
    console.error('[omg] Observer parser: <observations> root element not found — returning empty output')
    return { ...EMPTY_OUTPUT }
  }

  const operations: ObserverOperation[] = []
  const opsNode = root['operations'] as Record<string, unknown> | undefined

  if (opsNode !== undefined && opsNode !== null && typeof opsNode === 'object') {
    const rawOps = opsNode['operation']
    const opArray = Array.isArray(rawOps) ? rawOps : []

    let skippedCount = 0
    for (const op of opArray) {
      if (op === null || typeof op !== 'object') continue
      const parsedOp = parseOperation(op as Record<string, unknown>)
      if (parsedOp !== null) {
        operations.push(parsedOp)
      } else {
        skippedCount++
      }
    }
    if (skippedCount > 0) {
      console.warn(
        `[omg] Observer parser: skipped ${skippedCount} operation(s) — invalid type or missing required fields`,
      )
    }
  }

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

/**
 * Maps a parsed `<operation>` element to an ExtractCandidate.
 * Same field extraction as parseOperation but returns ExtractCandidate.
 */
function parseCandidate(op: Record<string, unknown>): ExtractCandidate | null {
  const canonicalKey = typeof op['canonical-key'] === 'string' ? op['canonical-key'].trim() : ''
  const rawType = op['@_type']
  const rawPriority = op['@_priority']

  if (!canonicalKey) {
    console.warn(
      `[omg] Extract parser: dropping candidate — missing canonical-key (type="${String(rawType)}")`,
    )
    return null
  }

  if (!isNodeType(rawType)) {
    console.warn(
      `[omg] Extract parser: dropping candidate — unknown type "${String(rawType)}" (canonical-key="${canonicalKey}")`,
    )
    return null
  }

  const title = typeof op['title'] === 'string' ? op['title'].trim() : ''
  const description = typeof op['description'] === 'string' ? op['description'].trim() : ''

  if (!description) {
    console.warn(
      `[omg] Extract parser: dropping candidate — missing description (canonical-key="${canonicalKey}")`,
    )
    return null
  }

  const priority = coercePriority(rawPriority, canonicalKey)
  const body = typeof op['content'] === 'string' ? op['content'].trim() : ''
  const mocHints = extractCommaSeparated(op['moc-hints'])
  const tags = extractCommaSeparated(op['tags'])
  const linkKeys = extractCommaSeparated(op['links'])

  return {
    type: rawType,
    canonicalKey,
    title,
    description,
    body,
    priority,
    ...(mocHints.length > 0 ? { mocHints } : {}),
    ...(linkKeys.length > 0 ? { linkKeys } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  }
}

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

  // Extract the XML block — the LLM may wrap it in ``` fences or add preamble text.
  const xmlMatch = raw.match(/<observations[\s\S]*?<\/observations>/)
  const xmlSource = xmlMatch ? xmlMatch[0] : raw.trim()

  let parsed: Record<string, unknown>
  try {
    const result = xmlParser.parse(xmlSource) as Record<string, unknown>
    if (typeof result !== 'object' || result === null) {
      console.error('[omg] Extract parser: XMLParser returned a non-object result — returning empty output')
      return { ...EMPTY_EXTRACT_OUTPUT }
    }
    parsed = result
  } catch (err) {
    console.error(
      '[omg] Extract parser: XMLParser.parse() threw — returning empty output.',
      err instanceof Error ? err.message : String(err),
    )
    return { ...EMPTY_EXTRACT_OUTPUT }
  }

  const root = parsed['observations'] as Record<string, unknown> | undefined
  if (root === undefined || root === null) {
    console.error('[omg] Extract parser: <observations> root element not found — returning empty output')
    return { ...EMPTY_EXTRACT_OUTPUT }
  }

  const candidates: ExtractCandidate[] = []
  const opsNode = root['operations'] as Record<string, unknown> | undefined

  if (opsNode !== undefined && opsNode !== null && typeof opsNode === 'object') {
    const rawOps = opsNode['operation']
    const opArray = Array.isArray(rawOps) ? rawOps : []

    let skippedCount = 0
    for (const op of opArray) {
      if (op === null || typeof op !== 'object') continue
      const candidate = parseCandidate(op as Record<string, unknown>)
      if (candidate !== null) {
        candidates.push(candidate)
      } else {
        skippedCount++
      }
    }
    if (skippedCount > 0) {
      console.warn(
        `[omg] Extract parser: skipped ${skippedCount} candidate(s) — invalid type or missing required fields`,
      )
    }
  }

  const nowPatch = parseNowPatch(root['now-patch'])
  const mocUpdates = deriveMocUpdatesFromCandidates(candidates)

  return { candidates, nowPatch, mocUpdates }
}
