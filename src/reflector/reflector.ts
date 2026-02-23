/**
 * Reflector orchestrator.
 *
 * Coordinates the full reflection pass: prompt building → LLM call → parsing →
 * progressive compression → node writes → archive marking → MOC updates → node updates.
 *
 * Never throws — all errors are caught and logged. Returns an empty ReflectorOutput on failure.
 */

import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { GraphNode, ReflectorOutput, ReflectorNodeEdit, CompressionLevel } from '../types.js'
import { createReflectorOutput } from '../types.js'
import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import { buildReflectorSystemPrompt, buildReflectorUserPrompt } from './prompts.js'
import { parseReflectorOutput, type ReflectorXmlOutput } from './parser.js'
import { writeReflectionNode } from '../graph/node-writer.js'
import { getRegistryEntry, updateRegistryEntry } from '../graph/registry.js'
import { readGraphNode } from '../graph/node-reader.js'
import { applyMocUpdate } from '../graph/moc-manager.js'
import { estimateTokens } from '../utils/tokens.js'
import { atomicWrite, isEnoent } from '../utils/fs.js'
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter.js'
import { resolveMocPath } from '../utils/paths.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum tokens to request from the LLM for the reflection response. */
const REFLECTOR_MAX_TOKENS = 8192

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input parameters for a single reflection pass. */
export interface ReflectionParams {
  /** Observation nodes to compress and synthesise. */
  readonly observationNodes: readonly GraphNode[]
  readonly config: OmgConfig
  readonly llmClient: LlmClient
  /** Absolute path to the OMG graph root. */
  readonly omgRoot: string
  readonly sessionKey: string
  /** Maximum compression level to attempt before accepting results. Default: 3. */
  readonly maxCompressionLevel?: CompressionLevel
}

// ---------------------------------------------------------------------------
// Empty output helper
// ---------------------------------------------------------------------------

function emptyOutput(): ReflectorOutput {
  return createReflectorOutput([], [], 0)
}

// ---------------------------------------------------------------------------
// Archive marking
// ---------------------------------------------------------------------------

/**
 * Reads a node file, sets `archived: true` in frontmatter, and writes it back
 * atomically. Silently skips files that are not found or fail to parse.
 */
async function markNodeArchived(filePath: string, nodeId: string, omgRoot: string): Promise<void> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return
    // Non-ENOENT errors (EACCES, EIO, EMFILE, etc.) indicate a real problem —
    // rethrow so the caller (Promise.allSettled) can log and count the failure.
    throw err
  }

  let frontmatterRecord: Record<string, unknown>
  let body: string
  try {
    const parsed = parseFrontmatter(raw)
    frontmatterRecord = { ...parsed.frontmatter, archived: true }
    body = parsed.body
  } catch (err) {
    console.warn(
      `[omg] Reflector: skipping archive of "${filePath}" — frontmatter parse failed:`,
      err instanceof Error ? err.message : String(err),
    )
    return
  }

  const dir = dirname(filePath)
  await fs.mkdir(dir, { recursive: true })
  const content = serializeFrontmatter(frontmatterRecord, body)
  await atomicWrite(filePath, content)

  try {
    await updateRegistryEntry(omgRoot, nodeId, { archived: true })
  } catch (err) {
    console.error(`[omg] Reflector: registry update failed for archive of "${nodeId}":`, err)
  }
}

// ---------------------------------------------------------------------------
// Apply node-level field updates
// ---------------------------------------------------------------------------

/**
 * Applies a single field update to an existing node file.
 * Reads the file, applies the change, and writes back atomically.
 */
async function applyNodeFieldUpdate(
  nodeId: string,
  field: string,
  action: string,
  value: string,
  omgRoot: string,
): Promise<void> {
  // Find the node by scanning the graph
  const node = await findNodeById(nodeId, omgRoot)
  if (node === null) {
    console.warn(
      `[omg] Reflector: skipping node-update for "${nodeId}" — node not found in graph`,
    )
    return
  }

  let raw: string
  try {
    raw = await fs.readFile(node.filePath, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return
    // Non-ENOENT errors (EACCES, EIO, EMFILE, etc.) indicate a real problem —
    // rethrow so the caller (Promise.allSettled) can log and count the failure.
    throw err
  }

  let frontmatterRecord: Record<string, unknown>
  let body: string
  try {
    const parsed = parseFrontmatter(raw)
    frontmatterRecord = { ...parsed.frontmatter }
    body = parsed.body
  } catch {
    console.warn(`[omg] Reflector: skipping node-update for "${nodeId}" — frontmatter parse failed`)
    return
  }

  if (field === 'body') {
    if (action === 'set') {
      body = value
    } else if (action === 'add') {
      body = body.trimEnd() + '\n\n' + value
    } else if (action === 'remove') {
      body = body.replace(value, '').trim()
    }
  } else if (field === 'tags') {
    const existingTags = Array.isArray(frontmatterRecord['tags'])
      ? (frontmatterRecord['tags'] as string[])
      : []
    if (action === 'set') {
      frontmatterRecord = { ...frontmatterRecord, tags: value.split(',').map((t) => t.trim()).filter(Boolean) }
    } else if (action === 'add') {
      const newTag = value.trim()
      if (newTag && !existingTags.includes(newTag)) {
        frontmatterRecord = { ...frontmatterRecord, tags: [...existingTags, newTag] }
      }
    } else if (action === 'remove') {
      frontmatterRecord = { ...frontmatterRecord, tags: existingTags.filter((t) => t !== value.trim()) }
    }
  } else if (field === 'links') {
    const existingLinks = Array.isArray(frontmatterRecord['links'])
      ? (frontmatterRecord['links'] as string[])
      : []
    if (action === 'set') {
      frontmatterRecord = { ...frontmatterRecord, links: value.split(',').map((l) => l.trim()).filter(Boolean) }
    } else if (action === 'add') {
      const newLink = value.trim()
      if (newLink && !existingLinks.includes(newLink)) {
        frontmatterRecord = { ...frontmatterRecord, links: [...existingLinks, newLink] }
      }
    } else if (action === 'remove') {
      frontmatterRecord = { ...frontmatterRecord, links: existingLinks.filter((l) => l !== value.trim()) }
    }
  } else {
    // description, priority — simple string set
    if (action === 'set') {
      frontmatterRecord = { ...frontmatterRecord, [field]: value }
    }
  }

  const content = serializeFrontmatter(frontmatterRecord, body)
  await atomicWrite(node.filePath, content)

  // Update registry with changed fields
  try {
    const registryUpdates: Record<string, unknown> = {}
    if (field === 'description' && action === 'set') {
      registryUpdates['description'] = value
    } else if (field === 'priority' && action === 'set') {
      registryUpdates['priority'] = value
    } else if (field === 'tags') {
      registryUpdates['tags'] = frontmatterRecord['tags']
    } else if (field === 'links') {
      registryUpdates['links'] = frontmatterRecord['links']
    }
    if (Object.keys(registryUpdates).length > 0) {
      await updateRegistryEntry(omgRoot, nodeId, registryUpdates)
    }
  } catch (err) {
    console.error(`[omg] Reflector: registry update failed for field update of "${nodeId}":`, err)
  }
}

// ---------------------------------------------------------------------------
// Graph node lookup
// ---------------------------------------------------------------------------

/**
 * Finds a node by ID using the registry for O(1) lookup,
 * then hydrates the full GraphNode from disk.
 * Returns null if not found.
 */
async function findNodeById(nodeId: string, omgRoot: string): Promise<GraphNode | null> {
  const entry = await getRegistryEntry(omgRoot, nodeId)
  if (!entry) return null
  return readGraphNode(entry.filePath)
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs a single reflection pass over the provided observation nodes.
 *
 * Flow:
 *   1. Guard: return empty output if nodes is empty.
 *   2. Progressive compression loop (L0 → maxCompressionLevel):
 *      a. Build prompts and call LLM.
 *      b. Parse response.
 *      c. Estimate total tokens of reflection nodes.
 *      d. If tokens fit within threshold OR level === max → apply and break.
 *      e. Else: escalate to next level.
 *   3. Write reflection nodes to disk.
 *   4. Mark archived nodes (set archived: true in frontmatter).
 *   5. Apply MOC updates.
 *   6. Apply node-level field updates.
 *   7. Return ReflectorOutput.
 *
 * Never throws — errors are caught and logged. Returns empty output on LLM failure.
 */
export async function runReflection(params: ReflectionParams): Promise<ReflectorOutput> {
  const { observationNodes, config, llmClient, omgRoot, sessionKey, maxCompressionLevel = 3 } = params

  if (observationNodes.length === 0) {
    return emptyOutput()
  }

  const tokenThreshold = config.injection.maxContextTokens
  const system = buildReflectorSystemPrompt()

  // --- Progressive compression loop ---
  let chosenOutput: ReflectorXmlOutput | null = null
  let totalTokensUsed = 0

  for (let level = 0 as CompressionLevel; level <= maxCompressionLevel; level++) {
    const user = buildReflectorUserPrompt({
      nodes: observationNodes,
      compressionLevel: level as CompressionLevel,
    })

    let responseContent: string
    let responseTokens: number
    try {
      const response = await llmClient.generate({ system, user, maxTokens: REFLECTOR_MAX_TOKENS })
      responseContent = response.content
      responseTokens = response.usage.inputTokens + response.usage.outputTokens
    } catch (err) {
      console.error(
        `[omg] Reflector [${sessionKey}]: LLM call failed at compression level ${level}:`,
        err instanceof Error ? err.message : String(err),
      )
      return emptyOutput()
    }

    const parsed = parseReflectorOutput(responseContent)

    // Estimate total tokens of all reflection node bodies
    const reflectionBodyTokens = parsed.reflectionNodes.reduce(
      (sum, node) => sum + estimateTokens(node.body),
      0,
    )

    const fits = reflectionBodyTokens <= tokenThreshold
    const isLast = level === maxCompressionLevel

    if (fits || isLast) {
      chosenOutput = parsed
      totalTokensUsed += responseTokens
      if (!fits) {
        console.warn(
          `[omg] Reflector [${sessionKey}]: reflection output still exceeds threshold at max level ${level} ` +
            `(${reflectionBodyTokens} tokens > ${tokenThreshold}). Applying best-effort result.`,
        )
      }
      break
    }

    console.warn(
      `[omg] Reflector [${sessionKey}]: compression level ${level} output too large ` +
        `(${reflectionBodyTokens} tokens > ${tokenThreshold}). Escalating to level ${level + 1}.`,
    )
  }

  if (chosenOutput === null) {
    // Guard: loop exhausted without setting a result (shouldn't happen given the isLast check).
    return emptyOutput()
  }

  const xmlOutput = chosenOutput
  const now = new Date().toISOString()
  const writeContext = { omgRoot, sessionKey }

  // --- Write reflection nodes ---
  const edits: ReflectorNodeEdit[] = []
  const writeResults = await Promise.allSettled(
    xmlOutput.reflectionNodes.map(async (spec) => {
      const frontmatter = {
        id: spec.id,
        description: spec.description,
        type: 'reflection' as const,
        priority: 'medium' as const,
        created: now,
        updated: now,
        ...(spec.sources.length > 0 ? { links: spec.sources } : {}),
        compressionLevel: spec.compressionLevel,
      }
      const written = await writeReflectionNode({ frontmatter, body: spec.body, sourceNodeIds: spec.sources }, writeContext)
      return { spec, written }
    }),
  )

  for (const result of writeResults) {
    if (result.status === 'fulfilled') {
      const { spec, written } = result.value
      edits.push({
        targetId: spec.id,
        frontmatter: written.frontmatter,
        body: written.body,
        compressionLevel: spec.compressionLevel,
      })
    } else {
      console.error(
        `[omg] Reflector [${sessionKey}]: failed to write reflection node:`,
        result.reason,
      )
    }
  }

  // --- Mark archived nodes ---
  const archiveResults = await Promise.allSettled(
    xmlOutput.archiveNodeIds.map(async (nodeId) => {
      const node = await findNodeById(nodeId, omgRoot)
      if (node !== null) {
        await markNodeArchived(node.filePath, nodeId, omgRoot)
      }
    }),
  )
  for (const result of archiveResults) {
    if (result.status === 'rejected') {
      console.error(
        `[omg] Reflector [${sessionKey}]: failed to archive node:`,
        result.reason,
      )
    }
  }

  // --- Apply MOC updates ---
  const mocResults = await Promise.allSettled(
    xmlOutput.mocUpdates.map(async (mocUpdate) => {
      const mocPath = resolveMocPath(omgRoot, mocUpdate.domain)
      const entry: import('../types.js').MocUpdateEntry = {
        action: mocUpdate.action,
        nodeId: mocUpdate.nodeId,
      }
      await applyMocUpdate(mocPath, entry)
    }),
  )
  for (const result of mocResults) {
    if (result.status === 'rejected') {
      console.error(
        `[omg] Reflector [${sessionKey}]: failed to apply MOC update:`,
        result.reason,
      )
    }
  }

  // --- Apply node-level field updates ---
  const updateResults = await Promise.allSettled(
    xmlOutput.nodeUpdates.map((update) =>
      applyNodeFieldUpdate(update.targetId, update.field, update.action, update.value, omgRoot),
    ),
  )
  for (const result of updateResults) {
    if (result.status === 'rejected') {
      console.error(
        `[omg] Reflector [${sessionKey}]: failed to apply node update:`,
        result.reason,
      )
    }
  }

  try {
    return createReflectorOutput(edits, xmlOutput.archiveNodeIds, totalTokensUsed)
  } catch (err) {
    console.error(
      `[omg] Reflector [${sessionKey}]: createReflectorOutput invariant violation:`,
      err instanceof Error ? err.message : String(err),
    )
    return emptyOutput()
  }
}
