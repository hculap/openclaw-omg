/**
 * XML parser for the Reflector LLM output.
 *
 * Converts raw LLM text (expected to be XML) into a `ReflectorXmlOutput`.
 * `parseReflectorOutput` never throws. On any parse failure, logs the problem
 * and returns an empty output — records that cannot be reliably parsed are
 * dropped rather than fabricated from heuristics.
 *
 * Follows the same defensive approach as `src/observer/parser.ts`.
 */

import { XMLParser } from 'fast-xml-parser'
import type { MocUpdateEntry, NodeUpdateEntry, CompressionLevel } from '../types.js'
import { isCompressionLevel } from '../types.js'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A single new reflection node produced by the LLM during a reflection pass. */
interface ReflectionNodeSpec {
  readonly id: string
  readonly description: string
  readonly body: string
  /** IDs of source observation nodes that contributed to this reflection. */
  readonly sources: readonly string[]
  readonly compressionLevel: CompressionLevel
}

/**
 * A MOC update entry with domain information, extracted from the XML output.
 * Extends the base MocUpdateEntry with the target MOC domain.
 */
interface ReflectorMocUpdate {
  readonly domain: string
  readonly action: 'add' | 'remove'
  readonly nodeId: string
}

/** Structured output produced by `parseReflectorOutput`. */
export interface ReflectorXmlOutput {
  readonly reflectionNodes: readonly ReflectionNodeSpec[]
  readonly archiveNodeIds: readonly string[]
  readonly mocUpdates: readonly ReflectorMocUpdate[]
  readonly nodeUpdates: readonly NodeUpdateEntry[]
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Valid node ID format: omg/{slug-path} */
const NODE_ID_RE = /^omg\/[a-z0-9][a-z0-9_/-]*$/

const VALID_ACTIONS = new Set<string>(['add', 'remove'])
const VALID_FIELDS = new Set<string>(['description', 'priority', 'body', 'tags', 'links'])
const VALID_UPDATE_ACTIONS = new Set<string>(['set', 'add', 'remove'])

export const EMPTY_REFLECTOR_OUTPUT: ReflectorXmlOutput = Object.freeze({
  reflectionNodes: Object.freeze([]) as readonly ReflectionNodeSpec[],
  archiveNodeIds: Object.freeze([]) as readonly string[],
  mocUpdates: Object.freeze([]) as readonly ReflectorMocUpdate[],
  nodeUpdates: Object.freeze([]) as readonly NodeUpdateEntry[],
})

// ---------------------------------------------------------------------------
// XML parser configuration
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name: string) =>
    name === 'node' || name === 'node-id' || name === 'moc' || name === 'update',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidNodeId(id: unknown): id is string {
  return typeof id === 'string' && NODE_ID_RE.test(id)
}

function parseSources(raw: unknown): readonly string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isValidNodeId(s))
}

/** Parse `<reflection-nodes>` into an array of ReflectionNodeSpec. */
function parseReflectionNodes(section: unknown): readonly ReflectionNodeSpec[] {
  if (section === null || typeof section !== 'object') return []

  const sectionObj = section as Record<string, unknown>
  const rawNodes = sectionObj['node']
  if (!Array.isArray(rawNodes)) return []

  const results: ReflectionNodeSpec[] = []

  for (const rawNode of rawNodes) {
    if (rawNode === null || typeof rawNode !== 'object') continue

    const node = rawNode as Record<string, unknown>
    const id = typeof node['id'] === 'string' ? node['id'].trim() : ''
    const description = typeof node['description'] === 'string' ? node['description'].trim() : ''
    const body = typeof node['body'] === 'string' ? node['body'].trim() : ''
    const rawLevel = node['@_compression-level']
    const levelNum = typeof rawLevel === 'string' ? parseInt(rawLevel, 10) : Number(rawLevel)
    const compressionLevel = isCompressionLevel(levelNum) ? levelNum : 0

    if (!id || !isValidNodeId(id)) {
      console.warn(
        `[omg] Reflector parser: dropping reflection node — invalid or missing id "${id}"`,
      )
      continue
    }
    if (!description) {
      console.warn(
        `[omg] Reflector parser: dropping reflection node "${id}" — missing description`,
      )
      continue
    }

    const sources = parseSources(node['sources'])

    results.push({ id, description, body, sources, compressionLevel })
  }

  return results
}

/** Parse `<archive-nodes>` into an array of node ID strings. */
function parseArchiveNodes(section: unknown): readonly string[] {
  if (section === null || typeof section !== 'object') return []

  const sectionObj = section as Record<string, unknown>
  const rawIds = sectionObj['node-id']
  if (!Array.isArray(rawIds)) return []

  const results: string[] = []
  const seen = new Set<string>()

  for (const raw of rawIds) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (!id || !isValidNodeId(id)) {
      console.warn(
        `[omg] Reflector parser: dropping archive entry — invalid node ID "${id}"`,
      )
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    results.push(id)
  }

  return results
}

/** Parse `<moc-updates>` into an array of ReflectorMocUpdate. */
function parseMocUpdates(section: unknown): readonly ReflectorMocUpdate[] {
  if (section === null || typeof section !== 'object') return []

  const sectionObj = section as Record<string, unknown>
  const rawMocs = sectionObj['moc']
  if (!Array.isArray(rawMocs)) return []

  const results: ReflectorMocUpdate[] = []

  for (const raw of rawMocs) {
    if (raw === null || typeof raw !== 'object') continue

    const moc = raw as Record<string, unknown>
    const domain = typeof moc['@_domain'] === 'string' ? moc['@_domain'].trim() : ''
    const nodeId = typeof moc['@_nodeId'] === 'string' ? moc['@_nodeId'].trim() : ''
    const action = typeof moc['@_action'] === 'string' ? moc['@_action'].trim() : ''

    if (!domain) {
      console.warn(
        `[omg] Reflector parser: dropping <moc> entry — missing domain attribute`,
      )
      continue
    }
    if (!nodeId || !isValidNodeId(nodeId)) {
      console.warn(
        `[omg] Reflector parser: dropping <moc> entry (domain="${domain}") — invalid or missing nodeId "${nodeId}"`,
      )
      continue
    }
    if (!VALID_ACTIONS.has(action)) {
      console.warn(
        `[omg] Reflector parser: dropping <moc> entry (domain="${domain}") — unknown action "${action}"`,
      )
      continue
    }

    results.push({ domain, action: action as 'add' | 'remove', nodeId })
  }

  return results
}

/** Parse `<node-updates>` into an array of NodeUpdateEntry. */
function parseNodeUpdates(section: unknown): readonly NodeUpdateEntry[] {
  if (section === null || typeof section !== 'object') return []

  const sectionObj = section as Record<string, unknown>
  const rawUpdates = sectionObj['update']
  if (!Array.isArray(rawUpdates)) return []

  const results: NodeUpdateEntry[] = []

  for (const raw of rawUpdates) {
    if (raw === null || typeof raw !== 'object') continue

    const update = raw as Record<string, unknown>
    const targetId = typeof update['@_targetId'] === 'string' ? update['@_targetId'].trim() : ''
    const field = typeof update['@_field'] === 'string' ? update['@_field'].trim() : ''
    const action = typeof update['@_action'] === 'string' ? update['@_action'].trim() : ''
    // In fast-xml-parser, element content comes back as '#text' key
    const rawValue = update['#text'] ?? update['value'] ?? ''
    const value = typeof rawValue === 'string' ? rawValue.trim() : ''

    if (!targetId || !isValidNodeId(targetId)) {
      console.warn(
        `[omg] Reflector parser: dropping <update> entry — invalid or missing targetId "${targetId}"`,
      )
      continue
    }
    if (!VALID_FIELDS.has(field)) {
      console.warn(
        `[omg] Reflector parser: dropping <update> for "${targetId}" — unknown field "${field}"`,
      )
      continue
    }
    if (!VALID_UPDATE_ACTIONS.has(action)) {
      console.warn(
        `[omg] Reflector parser: dropping <update> for "${targetId}" — unknown action "${action}"`,
      )
      continue
    }

    results.push({
      targetId,
      field: field as NodeUpdateEntry['field'],
      action: action as NodeUpdateEntry['action'],
      value,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parses the raw Reflector LLM output string into a `ReflectorXmlOutput`.
 *
 * Never throws. Returns `EMPTY_REFLECTOR_OUTPUT` when:
 *   - The input is empty or not a string.
 *   - XML parsing fails (error is logged).
 *   - The `<reflection>` root element is absent (logged).
 *
 * Individual records that fail field validation are dropped with a warning.
 */
export function parseReflectorOutput(raw: string): ReflectorXmlOutput {
  if (typeof raw !== 'string') {
    console.error('[omg] Reflector parser: received non-string input — this is a bug in the LLM client layer')
    return { ...EMPTY_REFLECTOR_OUTPUT }
  }
  if (raw.trim() === '') {
    console.warn('[omg] Reflector parser: LLM returned an empty response — returning empty output')
    return { ...EMPTY_REFLECTOR_OUTPUT }
  }

  // Extract the XML block — the LLM may wrap it in ``` fences or add preamble text.
  const xmlMatch = raw.match(/<reflection[\s\S]*?<\/reflection>/)
  const xmlSource = xmlMatch ? xmlMatch[0] : raw.trim()

  let parsed: Record<string, unknown>
  try {
    const result = xmlParser.parse(xmlSource) as Record<string, unknown>
    if (typeof result !== 'object' || result === null) {
      console.error('[omg] Reflector parser: XMLParser returned a non-object result — returning empty output')
      return { ...EMPTY_REFLECTOR_OUTPUT }
    }
    parsed = result
  } catch (err) {
    console.error(
      '[omg] Reflector parser: XMLParser.parse() threw — returning empty output.',
      err instanceof Error ? err.message : String(err),
    )
    return { ...EMPTY_REFLECTOR_OUTPUT }
  }

  const root = parsed['reflection'] as Record<string, unknown> | undefined
  if (root === undefined || root === null) {
    console.error('[omg] Reflector parser: <reflection> root element not found — returning empty output')
    return { ...EMPTY_REFLECTOR_OUTPUT }
  }

  const reflectionNodes = parseReflectionNodes(root['reflection-nodes'])
  const archiveNodeIds = parseArchiveNodes(root['archive-nodes'])
  const mocUpdates = parseMocUpdates(root['moc-updates'])
  const nodeUpdates = parseNodeUpdates(root['node-updates'])

  return { reflectionNodes, archiveNodeIds, mocUpdates, nodeUpdates }
}
