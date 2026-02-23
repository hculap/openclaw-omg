import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from '../utils/frontmatter.js'
import { parseNodeFrontmatter } from '../frontmatter.js'
import { NODE_TYPES } from '../types.js'
import type { GraphNode, NodeType } from '../types.js'

/**
 * Reads and parses a single markdown node file.
 *
 * Returns null if the file does not exist (ENOENT), has malformed YAML,
 * or has frontmatter that fails validation.
 * Throws for unexpected filesystem errors (e.g. EACCES, EIO).
 */
export async function readGraphNode(filePath: string): Promise<GraphNode | null> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw new Error(`Failed to read node file ${filePath}: ${String(err)}`)
  }

  try {
    const { frontmatter: rawFrontmatter, body } = parseFrontmatter(raw)
    const frontmatter = parseNodeFrontmatter(rawFrontmatter)
    return { frontmatter, body, filePath }
  } catch (err) {
    // Re-throw internal bugs so they are not silently swallowed.
    // Malformed YAML and schema validation failures are recoverable — return null.
    if (err instanceof Error && err.message.startsWith('[omg] Internal')) {
      throw err
    }
    return null
  }
}

/**
 * Lists all .md files in `{omgRoot}/nodes/{type}/`, parses each as a GraphNode,
 * skips invalid files, and returns results sorted by `updated` descending.
 *
 * Returns an empty array if the directory does not exist (ENOENT).
 * Throws for unexpected filesystem errors (e.g. EACCES, EIO).
 */
export async function listNodesByType(omgRoot: string, type: NodeType): Promise<GraphNode[]> {
  const dir = path.join(omgRoot, 'nodes', type)

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw new Error(`Failed to read node directory ${dir}: ${String(err)}`)
  }

  const mdFiles = entries.filter((entry) => entry.endsWith('.md'))

  const results = await Promise.all(
    mdFiles.map((entry) => readGraphNode(path.join(dir, entry)))
  )

  const valid = results.filter((node): node is GraphNode => node !== null)

  return [...valid].sort((a, b) => b.frontmatter.updated.localeCompare(a.frontmatter.updated))
}

/**
 * Recursively scans `{omgRoot}/nodes/` for all .md files across all known
 * NodeType subdirectories, parses each as a GraphNode, skips invalid files,
 * and returns results sorted by `updated` descending.
 *
 * The initial readdir is a lightweight existence check; if the `nodes/`
 * directory does not exist (ENOENT), an empty array is returned early.
 * Throws for unexpected filesystem errors (e.g. EACCES, EIO).
 *
 * @deprecated Use the registry API (`getRegistryEntries`, `getNodeIndex`) for
 * O(1) metadata lookups. This function is retained for `rebuildRegistry`'s
 * cold-start scan only.
 */
export async function listAllNodes(omgRoot: string): Promise<GraphNode[]> {
  const nodesDir = path.join(omgRoot, 'nodes')

  try {
    await fs.readdir(nodesDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw new Error(`Failed to read nodes directory ${nodesDir}: ${String(err)}`)
  }

  const allNodes = await Promise.all(
    NODE_TYPES.map((type) => listNodesByType(omgRoot, type))
  )

  const flat = allNodes.flat()

  return [...flat].sort((a, b) => b.frontmatter.updated.localeCompare(a.frontmatter.updated))
}
