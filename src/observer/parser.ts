/**
 * XML parser for the Observer LLM output.
 *
 * Converts raw LLM text (expected to be XML) into an {@link ObserverOutput}.
 * Never throws — any parse failure returns an empty or partially-populated
 * ObserverOutput, with a console.warn for degraded-mode fallback.
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

const EMPTY_OUTPUT: ObserverOutput = {
  operations: [],
  nowUpdate: null,
  mocUpdates: [],
}

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

function coercePriority(raw: unknown): Priority {
  if (typeof raw === 'string' && VALID_PRIORITIES.has(raw)) {
    return raw as Priority
  }
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
function buildFrontmatter(op: Record<string, unknown>): NodeFrontmatter | null {
  const id = typeof op['id'] === 'string' ? op['id'].trim() : ''
  const description = typeof op['description'] === 'string' ? op['description'].trim() : ''
  const rawType = op['@_type']
  const rawPriority = op['@_priority']

  if (!id || !description) return null
  if (!isNodeType(rawType)) return null

  const type = rawType
  const priority = coercePriority(rawPriority)
  const now = new Date().toISOString()

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
function parseOperation(op: Record<string, unknown>): ObserverOperation | null {
  const action = typeof op['@_action'] === 'string' ? op['@_action'] : ''

  if (!VALID_ACTIONS.has(action)) return null

  const frontmatter = buildFrontmatter(op)
  if (frontmatter === null) return null

  const body = typeof op['content'] === 'string' ? op['content'].trim() : ''

  if (action === 'create') {
    return { kind: 'create', frontmatter, body }
  }

  // update / supersede both need a target-id
  const targetId = typeof op['target-id'] === 'string' ? op['target-id'].trim() : ''
  if (!targetId) return null

  if (action === 'update') {
    return { kind: 'update', targetId, frontmatter, body }
  }

  // action === 'supersede'
  return { kind: 'supersede', targetId, frontmatter, body }
}

/**
 * Parse `<moc-updates>` into a list of MOC domain IDs that need regenerating.
 * The action attribute (add/remove) from the XML guides the hook layer; here
 * we surface just the domain names so the caller knows which MOCs are affected.
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
    if (!domain || seen.has(domain)) continue
    seen.add(domain)
    results.push(domain)
  }
  return results
}

// ---------------------------------------------------------------------------
// Fallback: plain-text line parser
// ---------------------------------------------------------------------------

/**
 * Last-resort fallback when XML parsing fails entirely.
 * Scans lines for bullet points or emoji-prefixed lines and treats each as
 * an episode node at medium priority.
 */
function fallbackParse(raw: string): ObserverOutput {
  console.warn('[omg] Observer parser: XML parsing failed, attempting plain-text fallback')

  const lines = raw.split('\n')
  const operations: ObserverOperation[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    // Match lines starting with "- " or an emoji (basic heuristic)
    if (!trimmed.startsWith('- ') && !/^\p{Emoji}/u.test(trimmed)) continue
    const text = trimmed.startsWith('- ') ? trimmed.slice(2).trim() : trimmed
    if (!text) continue

    const slug = text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60)

    if (!slug) continue

    const now = new Date().toISOString()
    operations.push({
      kind: 'create',
      frontmatter: {
        id: `omg/episode/${slug}`,
        description: text,
        type: 'episode',
        priority: 'medium',
        created: now,
        updated: now,
      },
      body: text,
    })
  }

  return { ...EMPTY_OUTPUT, operations }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parses the raw LLM output string into an {@link ObserverOutput}.
 *
 * Never throws. On complete parse failure, returns an empty ObserverOutput.
 * On partial XML failure, attempts the plain-text fallback.
 */
export function parseObserverOutput(raw: string): ObserverOutput {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ...EMPTY_OUTPUT }
  }

  // Extract the XML block — the LLM may wrap it in ``` fences or add preamble text.
  const xmlMatch = raw.match(/<observations[\s\S]*?<\/observations>/)
  const xmlSource = xmlMatch ? xmlMatch[0] : raw.trim()

  let parsed: Record<string, unknown>
  try {
    const result = xmlParser.parse(xmlSource) as Record<string, unknown>
    if (typeof result !== 'object' || result === null) {
      return fallbackParse(raw)
    }
    parsed = result
  } catch {
    return fallbackParse(raw)
  }

  const root = parsed['observations'] as Record<string, unknown> | undefined
  if (root === undefined || root === null) {
    return fallbackParse(raw)
  }

  // --- Operations ---
  const operations: ObserverOperation[] = []
  const opsNode = root['operations'] as Record<string, unknown> | undefined

  if (opsNode !== undefined && opsNode !== null && typeof opsNode === 'object') {
    const rawOps = opsNode['operation']
    const opArray = Array.isArray(rawOps) ? rawOps : []

    for (const op of opArray) {
      if (op === null || typeof op !== 'object') continue
      const parsed = parseOperation(op as Record<string, unknown>)
      if (parsed !== null) {
        operations.push(parsed)
      }
    }
  }

  // --- Now update ---
  const rawNow = root['now-update']
  const nowUpdate = typeof rawNow === 'string' && rawNow.trim().length > 0
    ? rawNow.trim()
    : null

  // --- MOC updates ---
  const mocUpdates = parseMocUpdates(root['moc-updates'])

  return { operations, nowUpdate, mocUpdates }
}
