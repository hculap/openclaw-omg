/**
 * node-writer.ts
 *
 * Writes GraphNode files to disk for observation nodes, reflection nodes,
 * and the singleton now.md node.
 *
 * All writes are atomic: content is written to a temporary file first,
 * then renamed to the final path, preventing partial writes.
 *
 * Observation nodes use deterministic, content-addressed paths:
 *   {omgRoot}/nodes/{type}/{slugify(canonicalKey)}.md
 * If the file exists, the existing `created` timestamp is preserved (merge).
 */

import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import type {
  GraphNode,
  NodeFrontmatter,
  ObserverOperation,
  ReflectionNodeData,
  NowUpdate,
  WriteContext,
} from '../types.js'
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter.js'
import { atomicWrite, isEnoent } from '../utils/fs.js'
import { slugify, computeUid, computeNodeId, computeNodePath } from '../utils/id.js'
import { registerNode, buildRegistryEntry, getRegistryEntry, updateRegistryEntry } from './registry.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true })
  } catch (error) {
    throw new Error(
      `Failed to create directory ${dirPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch (err) {
    if (isEnoent(err)) {
      return false
    }
    throw err
  }
}

/**
 * Reads the `created` frontmatter field from an existing file.
 * Returns null if the file does not exist (ENOENT) or if the field is absent/invalid.
 * Throws for unexpected filesystem errors (e.g. EACCES, EIO).
 */
async function readExistingCreated(filePath: string): Promise<string | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) {
      return null
    }
    throw new Error(
      `Failed to read ${filePath} for created timestamp: ${err instanceof Error ? (err as Error).message : String(err)}`,
      { cause: err }
    )
  }
  try {
    const { frontmatter } = parseFrontmatter(raw)
    const created = frontmatter['created']
    return typeof created === 'string' ? created : null
  } catch {
    // Malformed frontmatter is recoverable — fall back to current time.
    return null
  }
}

/**
 * Resolves a collision-free file path by appending -2, -3, ... suffixes
 * until an available path is found. Used by reflection nodes (date-based paths).
 */
async function resolveAvailablePath(
  dir: string,
  baseName: string,
  ext: string
): Promise<string> {
  const base = join(dir, `${baseName}${ext}`)
  if (!(await fileExists(base))) {
    return base
  }

  for (let suffix = 2; suffix <= 99; suffix++) {
    const candidate = join(dir, `${baseName}-${suffix}${ext}`)
    if (!(await fileExists(candidate))) {
      return candidate
    }
  }

  throw new Error(
    `Could not find an available path for ${join(dir, baseName)}${ext} after 99 attempts`
  )
}

/**
 * Serializes a NodeFrontmatter into a plain Record for YAML output.
 * Excludes undefined optional fields to keep output clean.
 */
function frontmatterToRecord(fm: NodeFrontmatter): Record<string, unknown> {
  return {
    id: fm.id,
    description: fm.description,
    type: fm.type,
    priority: fm.priority,
    created: fm.created,
    updated: fm.updated,
    ...(fm.uid !== undefined && { uid: fm.uid }),
    ...(fm.canonicalKey !== undefined && { canonicalKey: fm.canonicalKey }),
    ...(fm.aliases !== undefined && { aliases: fm.aliases }),
    ...(fm.appliesTo !== undefined && { appliesTo: fm.appliesTo }),
    ...(fm.sources !== undefined && { sources: fm.sources }),
    ...(fm.links !== undefined && { links: fm.links }),
    ...(fm.tags !== undefined && { tags: fm.tags }),
    ...(fm.supersedes !== undefined && { supersedes: fm.supersedes }),
    ...(fm.compressionLevel !== undefined && { compressionLevel: fm.compressionLevel }),
    ...(fm.archived !== undefined && { archived: fm.archived }),
    ...(fm.mergedInto !== undefined && { mergedInto: fm.mergedInto }),
  }
}

/**
 * Builds a filename base from type, description, and today's date.
 * Format: {type}-{slug(description)}-{YYYY-MM-DD}
 *
 * @throws If description slugifies to an empty string.
 */
function buildBaseFilename(type: string, description: string): string {
  const slug = slugify(description)
  if (slug === '') {
    throw new Error(
      `Cannot build filename: description "${description}" produces an empty slug`
    )
  }
  const date = todayDateString()
  return `${type}-${slug}-${date}`
}

/**
 * Writes the given frontmatter and body to a collision-safe path within dir,
 * creates the directory if needed, and returns the written GraphNode.
 * Used for reflection nodes (date-based paths).
 */
async function writeNodeToDir(
  dir: string,
  frontmatter: NodeFrontmatter,
  body: string
): Promise<GraphNode> {
  await ensureDir(dir)

  const baseName = buildBaseFilename(frontmatter.type, frontmatter.description)
  const filePath = await resolveAvailablePath(dir, baseName, '.md')

  const content = serializeFrontmatter(frontmatterToRecord(frontmatter), body)
  await atomicWrite(filePath, content)

  return {
    frontmatter,
    body,
    filePath,
  }
}

/**
 * Writes an upsert operation to a deterministic path:
 *   {omgRoot}/nodes/{type}/{slugify(canonicalKey)}.md
 *
 * If the file already exists, the `created` timestamp is preserved (merge).
 * The `uid` is computed from scope+type+canonicalKey and written to frontmatter.
 */
async function writeNodeToDeterministicPath(
  omgRoot: string,
  operation: Extract<ObserverOperation, { kind: 'upsert' }>,
  scope: string
): Promise<GraphNode> {
  const { canonicalKey, type, title, description, body, priority, mocHints, linkKeys, tags } = operation

  const slug = slugify(canonicalKey)
  if (slug === '') {
    throw new Error(
      `Cannot write node: canonicalKey "${canonicalKey}" (type="${type}") produces an empty slug`
    )
  }

  const now = new Date().toISOString()
  const uid = computeUid(scope, type, canonicalKey)
  const nodeId = computeNodeId(type, canonicalKey)
  const relativePath = computeNodePath(type, canonicalKey)
  const filePath = join(omgRoot, relativePath)

  const dir = dirname(filePath)
  await ensureDir(dir)

  // Preserve created timestamp on merge (file exists)
  const existingCreated = await readExistingCreated(filePath)
  const created = existingCreated ?? now

  // Resolve MOC links from mocHints
  const mocLinks = (mocHints ?? []).map((hint) => `omg/moc-${hint}`)

  const frontmatter: NodeFrontmatter = {
    id: nodeId,
    description,
    type,
    priority,
    created,
    updated: now,
    uid,
    canonicalKey,
    ...(title && description !== title ? {} : {}),  // title stored in body heading, not frontmatter
    ...(mocLinks.length > 0 || (linkKeys?.length ?? 0) > 0
      ? { links: [...mocLinks, ...(linkKeys ?? [])] }
      : {}),
    ...(tags && tags.length > 0 ? { tags: [...tags] } : {}),
  }

  const content = serializeFrontmatter(frontmatterToRecord(frontmatter), body)
  await atomicWrite(filePath, content)

  return {
    frontmatter,
    body,
    filePath,
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Writes an observation node produced by the Observer to disk.
 *
 * For `upsert` operations: uses deterministic content-addressed path.
 *   File location: {omgRoot}/nodes/{type}/{slugify(canonicalKey)}.md
 *   If the file exists, preserves the original `created` timestamp (merge).
 *
 * For legacy `create/update/supersede` operations: uses date-based collision-safe paths.
 *   File location: {omgRoot}/nodes/{type}/{type}-{slug}-{YYYY-MM-DD}[-N].md
 */
export async function writeObservationNode(
  operation: ObserverOperation,
  context: WriteContext
): Promise<GraphNode> {
  if (operation.kind === 'upsert') {
    const scope = context.scope ?? context.omgRoot
    const node = await writeNodeToDeterministicPath(context.omgRoot, operation, scope)
    try {
      await registerNode(context.omgRoot, node.frontmatter.id, buildRegistryEntry(node, 'observation'))
    } catch (err) {
      console.error(`[omg] node-writer: registry update failed for ${node.frontmatter.id}:`, err)
    }
    return node
  }

  // Legacy path for create/update/supersede (backward compat)
  const { frontmatter, body } = operation
  const dir = join(context.omgRoot, 'nodes', frontmatter.type)
  const node = await writeNodeToDir(dir, frontmatter, body)
  try {
    await registerNode(context.omgRoot, frontmatter.id, buildRegistryEntry(node, 'observation'))
  } catch (err) {
    console.error(`[omg] node-writer: registry update failed for ${frontmatter.id}:`, err)
  }
  return node
}

/**
 * Writes a reflection node produced by the Reflector to disk.
 *
 * File location: {omgRoot}/reflections/{type}-{slug}-{YYYY-MM-DD}[-N].md
 */
export async function writeReflectionNode(
  node: ReflectionNodeData,
  context: WriteContext
): Promise<GraphNode> {
  const dir = join(context.omgRoot, 'reflections')
  const written = await writeNodeToDir(dir, node.frontmatter, node.body)
  try {
    await registerNode(context.omgRoot, node.frontmatter.id, buildRegistryEntry(written, 'reflection'))
  } catch (err) {
    console.error(`[omg] node-writer: registry update failed for ${node.frontmatter.id}:`, err)
  }
  return written
}

/** Parameters for writing a domain-scoped clustered reflection node. */
export interface ClusteredReflectionParams {
  readonly frontmatter: NodeFrontmatter
  readonly body: string
  readonly sourceNodeIds: readonly string[]
  /** Domain slug used for directory scoping. */
  readonly domain: string
  /** Time range for deterministic file naming. */
  readonly timeRange: { readonly start: string; readonly end: string }
}

/**
 * Writes a clustered reflection node to a deterministic, domain-scoped path.
 *
 * File location: {omgRoot}/reflections/{domain}/{start}__{end}.md
 *
 * Reruns overwrite the same file (idempotent, deterministic path).
 */
export async function writeClusteredReflectionNode(
  params: ClusteredReflectionParams,
  context: WriteContext,
): Promise<GraphNode> {
  const { frontmatter, body, domain, timeRange } = params
  const dir = join(context.omgRoot, 'reflections', slugify(domain))
  await ensureDir(dir)

  const startDate = timeRange.start.slice(0, 10)
  const endDate = timeRange.end.slice(0, 10)
  const filePath = join(dir, `${startDate}__${endDate}.md`)

  const content = serializeFrontmatter(frontmatterToRecord(frontmatter), body)
  await atomicWrite(filePath, content)

  const written: GraphNode = { frontmatter, body, filePath }

  try {
    await registerNode(context.omgRoot, frontmatter.id, buildRegistryEntry(written, 'reflection'))
  } catch (err) {
    console.error(`[omg] node-writer: registry update failed for ${frontmatter.id}:`, err)
  }

  return written
}

/**
 * Writes (or overwrites) the singleton now.md node.
 *
 * File location: {omgRoot}/now.md
 *
 * Preserves the `created` timestamp from any existing now.md, falling back
 * to the current time on first write. Sets `updated` to the current time.
 * Populates `links` from recentNodeIds when non-empty.
 */
export async function writeNowNode(
  nowUpdate: NowUpdate,
  recentNodeIds: readonly string[],
  context: WriteContext
): Promise<GraphNode> {
  const now = new Date().toISOString()
  const filePath = join(context.omgRoot, 'now.md')

  const existingCreated = await readExistingCreated(filePath)
  const created = existingCreated ?? now

  const frontmatter: NodeFrontmatter = {
    id: 'omg/now',
    description: 'Current state snapshot',
    type: 'now',
    priority: 'high',
    created,
    updated: now,
    ...(recentNodeIds.length > 0 ? { links: recentNodeIds } : {}),
  }

  await ensureDir(dirname(filePath))

  const content = serializeFrontmatter(frontmatterToRecord(frontmatter), nowUpdate)
  await atomicWrite(filePath, content)

  const node: GraphNode = { frontmatter, body: nowUpdate, filePath }
  try {
    await registerNode(context.omgRoot, 'omg/now', buildRegistryEntry(node, 'observation'))
  } catch (err) {
    console.error('[omg] node-writer: registry update failed for omg/now:', err)
  }
  return node
}

/**
 * Appends additional content to the body of an existing observation node.
 *
 * Uses the AsyncMutex via registerNode to prevent race conditions.
 * Updates the `updated` timestamp in frontmatter and the registry.
 *
 * @param omgRoot     Root of the OMG graph.
 * @param nodeId      ID of the node to append to (e.g. "omg/preference/editor-theme").
 * @param bodyAppend  Markdown content to append (separated by a blank line).
 * @returns The updated GraphNode, or null if the node was not found in the registry.
 */
export async function appendToExistingNode(
  omgRoot: string,
  nodeId: string,
  bodyAppend: string
): Promise<GraphNode | null> {
  const entry = await getRegistryEntry(omgRoot, nodeId)
  if (!entry) {
    console.warn(`[omg] node-writer: appendToExistingNode — node not found in registry: ${nodeId}`)
    return null
  }

  const { filePath } = entry

  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) {
      console.warn(`[omg] node-writer: appendToExistingNode — file not found: ${filePath}`)
      return null
    }
    throw new Error(
      `appendToExistingNode: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }

  const { frontmatter: rawFm, body: existingBody } = parseFrontmatter(raw)
  const now = new Date().toISOString()

  const updatedFm: Record<string, unknown> = { ...rawFm, updated: now }
  const updatedBody = bodyAppend.trim()
    ? `${existingBody}\n\n${bodyAppend.trim()}`
    : existingBody

  const content = serializeFrontmatter(updatedFm, updatedBody)
  await atomicWrite(filePath, content)

  // Update registry updated timestamp
  try {
    await updateRegistryEntry(omgRoot, nodeId, { updated: now })
  } catch (err) {
    console.error(`[omg] node-writer: registry update failed for ${nodeId}:`, err)
  }

  // Reconstruct and return the updated node
  const updatedFrontmatter: NodeFrontmatter = {
    id: nodeId,
    description: entry.description,
    type: entry.type,
    priority: entry.priority,
    created: typeof rawFm['created'] === 'string' ? rawFm['created'] : now,
    updated: now,
    ...(entry.links !== undefined ? { links: entry.links } : {}),
    ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
    ...(entry.canonicalKey !== undefined ? { canonicalKey: entry.canonicalKey } : {}),
  }

  return { frontmatter: updatedFrontmatter, body: updatedBody, filePath }
}

/**
 * Adds an alias key to an existing observation node's frontmatter.
 *
 * Reads the existing node, merges the new aliasKey into frontmatter.aliases,
 * and writes the file atomically. Updates the registry.
 *
 * @param omgRoot   Root of the OMG graph.
 * @param nodeId    ID of the target node.
 * @param aliasKey  The canonical key to add as an alias.
 * @returns The updated GraphNode, or null if not found.
 */
export async function addAliasToNode(
  omgRoot: string,
  nodeId: string,
  aliasKey: string
): Promise<GraphNode | null> {
  const entry = await getRegistryEntry(omgRoot, nodeId)
  if (!entry) {
    console.warn(`[omg] node-writer: addAliasToNode — node not found in registry: ${nodeId}`)
    return null
  }

  const { filePath } = entry

  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) {
      console.warn(`[omg] node-writer: addAliasToNode — file not found: ${filePath}`)
      return null
    }
    throw new Error(
      `addAliasToNode: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }

  const { frontmatter: rawFm, body } = parseFrontmatter(raw)
  const now = new Date().toISOString()

  // Merge alias into existing aliases array (deduplicated)
  const existingAliases = Array.isArray(rawFm['aliases']) ? (rawFm['aliases'] as string[]) : []
  const aliases = [...new Set([...existingAliases, aliasKey])]

  const updatedFm: Record<string, unknown> = { ...rawFm, updated: now, aliases }
  const content = serializeFrontmatter(updatedFm, body)
  await atomicWrite(filePath, content)

  // Update registry updated timestamp
  try {
    await updateRegistryEntry(omgRoot, nodeId, { updated: now })
  } catch (err) {
    console.error(`[omg] node-writer: registry update failed for ${nodeId}:`, err)
  }

  const updatedFrontmatter: NodeFrontmatter = {
    id: nodeId,
    description: entry.description,
    type: entry.type,
    priority: entry.priority,
    created: typeof rawFm['created'] === 'string' ? rawFm['created'] : now,
    updated: now,
    aliases,
    ...(entry.links !== undefined ? { links: entry.links } : {}),
    ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
    ...(entry.canonicalKey !== undefined ? { canonicalKey: entry.canonicalKey } : {}),
  }

  return { frontmatter: updatedFrontmatter, body, filePath }
}
