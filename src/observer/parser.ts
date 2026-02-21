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
  NodeFrontmatter,
  Priority,
} from '../types.js'
import { isNodeType } from '../types.js'
import { extractWikilinks } from '../utils/markdown.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMPTY_OUTPUT: ObserverOutput = Object.freeze({
  operations: Object.freeze([]) as readonly ObserverOperation[],
  nowUpdate: null,
  mocUpdates: Object.freeze([]) as readonly string[],
})

const VALID_ACTIONS = new Set(['create', 'update', 'supersede'])
const VALID_PRIORITIES = new Set<string>(['high', 'medium', 'low'])

// ---------------------------------------------------------------------------
// XML parser configuration
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Ensure these elements are always parsed as arrays even when there is only one.
  isArray: (name: string) => name === 'operation' || name === 'moc',
  // Prevent numeric-looking content from being coerced to numbers.
  parseAttributeValue: false,
  parseTagValue: false,
  // Trim whitespace from tag values so multi-line content blocks are clean.
  trimValues: true,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coercePriority(raw: unknown, opId?: string): Priority {
  if (typeof raw === 'string' && VALID_PRIORITIES.has(raw)) {
    return raw as Priority
  }
  console.warn(
    `[omg] Observer parser: unknown priority "${String(raw)}" — defaulting to "medium"${opId ? ` (id="${opId}")` : ''}`,
  )
  return 'medium'
}

function extractTagsFromRaw(raw: unknown): readonly string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

function extractLinksFromRaw(raw: unknown): readonly string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return extractWikilinks(raw)
}

/** Build a minimal NodeFrontmatter from parsed XML operation fields. */
function buildFrontmatter(op: Record<string, unknown>, now: string): NodeFrontmatter | null {
  const id = typeof op['id'] === 'string' ? op['id'].trim() : ''
  const description = typeof op['description'] === 'string' ? op['description'].trim() : ''
  const rawType = op['@_type']
  const rawPriority = op['@_priority']

  if (!id || !description) {
    console.warn(
      `[omg] Observer parser: dropping operation — missing id or description (id="${String(op['id'])}", description="${String(op['description'])}")`,
    )
    return null
  }
  if (!isNodeType(rawType)) {
    console.warn(
      `[omg] Observer parser: dropping operation — unknown type "${String(rawType)}" (id="${id}")`,
    )
    return null
  }

  const type = rawType
  const priority = coercePriority(rawPriority, id)
  const links = extractLinksFromRaw(op['links'])
  const tags = extractTagsFromRaw(op['tags'])

  const frontmatter: NodeFrontmatter = {
    id,
    description,
    type,
    priority,
    created: now,
    updated: now,
    ...(links.length > 0 ? { links } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  }

  return frontmatter
}

/** Parse a single `<operation>` element into an ObserverOperation. */
function parseOperation(op: Record<string, unknown>, now: string): ObserverOperation | null {
  const action = typeof op['@_action'] === 'string' ? op['@_action'] : ''

  if (!VALID_ACTIONS.has(action)) {
    console.warn(
      `[omg] Observer parser: dropping operation — unknown action "${action}"`,
    )
    return null
  }

  const frontmatter = buildFrontmatter(op, now)
  if (frontmatter === null) return null

  const body = typeof op['content'] === 'string' ? op['content'].trim() : ''

  if (action === 'create') {
    return { kind: 'create', frontmatter, body }
  }

  // update / supersede both need a target-id
  const targetId = typeof op['target-id'] === 'string' ? op['target-id'].trim() : ''
  if (!targetId) {
    console.warn(
      `[omg] Observer parser: dropping "${action}" operation — missing target-id (id="${frontmatter.id}")`,
    )
    return null
  }

  if (action === 'update') {
    return { kind: 'update', targetId, frontmatter, body }
  }

  // action === 'supersede'
  return { kind: 'supersede', targetId, frontmatter, body }
}

/**
 * Parse `<moc-updates>` into a list of MOC domain IDs that need regenerating.
 * Only the domain names are surfaced here; the add/remove action attribute
 * from the XML is intentionally dropped (the hook layer determines membership
 * changes from the full operation set, not from this list).
 */
function parseMocUpdates(mocUpdatesNode: unknown): readonly string[] {
  if (mocUpdatesNode === null || typeof mocUpdatesNode !== 'object') return []

  const node = mocUpdatesNode as Record<string, unknown>
  const rawMocs = node['moc']
  if (!Array.isArray(rawMocs)) return []

  const results: string[] = []
  const seen = new Set<string>()
  for (const moc of rawMocs) {
    if (moc === null || typeof moc !== 'object') continue
    const domain = typeof (moc as Record<string, unknown>)['@_domain'] === 'string'
      ? ((moc as Record<string, unknown>)['@_domain'] as string).trim()
      : ''
    if (!domain) {
      console.warn(
        `[omg] Observer parser: dropping <moc> entry — missing or empty domain attribute (raw: ${JSON.stringify(moc)})`,
      )
      continue
    }
    if (seen.has(domain)) continue
    seen.add(domain)
    results.push(domain)
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

  // Capture a single timestamp for all operations in this parse call so every
  // node from one observation cycle shares the same created/updated value.
  const now = new Date().toISOString()

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
      const parsedOp = parseOperation(op as Record<string, unknown>, now)
      if (parsedOp !== null) {
        operations.push(parsedOp)
      } else {
        skippedCount++
      }
    }
    if (skippedCount > 0) {
      console.warn(
        `[omg] Observer parser: skipped ${skippedCount} operation(s) — invalid action, type, or missing required fields`,
      )
    }
  }

  const rawNow = root['now-update']
  const nowUpdate = typeof rawNow === 'string' && rawNow.trim().length > 0
    ? rawNow.trim()
    : null

  const mocUpdates = parseMocUpdates(root['moc-updates'])

  return { operations, nowUpdate, mocUpdates }
}
