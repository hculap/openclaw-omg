/**
 * node-writer.ts
 *
 * Writes GraphNode files to disk for observation nodes, reflection nodes,
 * and the singleton now.md node.
 *
 * All writes are atomic: content is written to a temporary file first,
 * then renamed to the final path, preventing partial writes.
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
import { slugify } from '../utils/id.js'

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
 * until an available path is found.
 *
 * @param dir - The directory to write into.
 * @param baseName - The base filename without extension (e.g. "fact-my-note-2026-02-20").
 * @param ext - The file extension including the dot (e.g. ".md").
 * @returns The first available absolute path.
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
    ...(fm.appliesTo !== undefined && { appliesTo: fm.appliesTo }),
    ...(fm.sources !== undefined && { sources: fm.sources }),
    ...(fm.links !== undefined && { links: fm.links }),
    ...(fm.tags !== undefined && { tags: fm.tags }),
    ...(fm.supersedes !== undefined && { supersedes: fm.supersedes }),
    ...(fm.compressionLevel !== undefined && { compressionLevel: fm.compressionLevel }),
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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Writes an observation node produced by the Observer to disk.
 *
 * All three operation kinds (create, update, supersede) produce a new file;
 * the `type` field within the frontmatter is set by the caller.
 * The `operation.kind` discriminant is not read by this function.
 *
 * File location: {omgRoot}/nodes/{type}/{type}-{slug}-{YYYY-MM-DD}[-N].md
 */
export async function writeObservationNode(
  operation: ObserverOperation,
  context: WriteContext
): Promise<GraphNode> {
  const { frontmatter, body } = operation
  const dir = join(context.omgRoot, 'nodes', frontmatter.type)
  return writeNodeToDir(dir, frontmatter, body)
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
  return writeNodeToDir(dir, node.frontmatter, node.body)
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

  return {
    frontmatter,
    body: nowUpdate,
    filePath,
  }
}
