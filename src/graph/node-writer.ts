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
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import type {
  GraphNode,
  NodeFrontmatter,
  ObserverOperation,
  ReflectionNodeData,
  NowUpdate,
  WriteContext,
} from '../types.js'
import { serializeFrontmatter } from '../utils/frontmatter.js'
import { slugify } from '../utils/id.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns today's date in YYYY-MM-DD format.
 */
function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Writes content to a temporary file, then atomically renames it to the
 * final path. Prevents partial writes from being observed by readers.
 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  const tmpName = `.tmp-${randomBytes(4).toString('hex')}`
  const tmpPath = join(dir, tmpName)

  try {
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    // Best-effort cleanup of the temp file if rename failed
    await fs.unlink(tmpPath).catch(() => undefined)
    throw new Error(
      `Atomic write failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Ensures a directory exists, creating it recursively if needed.
 */
async function ensureDir(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true })
  } catch (error) {
    throw new Error(
      `Failed to create directory ${dirPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

/**
 * Checks whether a file exists at the given path.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
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
    `Could not find an available path for ${baseName}${ext} after 99 attempts`
  )
}

/**
 * Serializes a NodeFrontmatter into a plain Record for YAML output.
 * Excludes undefined optional fields to keep output clean.
 */
function frontmatterToRecord(fm: NodeFrontmatter): Record<string, unknown> {
  const record: Record<string, unknown> = {
    id: fm.id,
    description: fm.description,
    type: fm.type,
    priority: fm.priority,
    created: fm.created,
    updated: fm.updated,
  }

  if (fm.appliesTo !== undefined) record['appliesTo'] = fm.appliesTo
  if (fm.sources !== undefined) record['sources'] = fm.sources
  if (fm.links !== undefined) record['links'] = fm.links
  if (fm.tags !== undefined) record['tags'] = fm.tags
  if (fm.supersedes !== undefined) record['supersedes'] = fm.supersedes
  if (fm.compressionLevel !== undefined) record['compressionLevel'] = fm.compressionLevel

  return record
}

/**
 * Builds a filename base from type, description, and today's date.
 * Format: {type}-{slug(description)}-{YYYY-MM-DD}
 */
function buildBaseFilename(type: string, description: string): string {
  const slug = slugify(description)
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
 * the kind is recorded in frontmatter by the caller before passing here.
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
 * Creates simple frontmatter with:
 *   type='now', id='omg/now', priority='high', created=now, updated=now
 */
export async function writeNowNode(
  nowUpdate: NowUpdate,
  recentNodeIds: readonly string[],
  context: WriteContext
): Promise<GraphNode> {
  const now = new Date().toISOString()

  const frontmatter: NodeFrontmatter = {
    id: 'omg/now',
    description: 'Current state snapshot',
    type: 'now',
    priority: 'high',
    created: now,
    updated: now,
    ...(recentNodeIds.length > 0 ? { links: recentNodeIds } : {}),
  }

  const dir = context.omgRoot
  const filePath = join(dir, 'now.md')

  await ensureDir(dir)

  const content = serializeFrontmatter(frontmatterToRecord(frontmatter), nowUpdate)
  await atomicWrite(filePath, content)

  return {
    frontmatter,
    body: nowUpdate,
    filePath,
  }
}
