import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { parseFrontmatter } from '../utils/frontmatter.js'
import { parseNodeFrontmatter } from '../frontmatter.js'
import { NODE_TYPES } from '../types.js'
import type { GraphNode, NodeType } from '../types.js'

/**
 * Reads and parses a single markdown node file.
 *
 * Returns null if the file does not exist, cannot be read, has malformed YAML,
 * or has frontmatter that fails validation.
 */
export async function readGraphNode(filePath: string): Promise<GraphNode | null> {
  try {
    const raw = await readFile(filePath, 'utf-8')
    const { frontmatter: rawFrontmatter, body } = parseFrontmatter(raw)
    const frontmatter = parseNodeFrontmatter(rawFrontmatter)
    return { frontmatter, body, filePath }
  } catch {
    return null
  }
}

/**
 * Lists all .md files in `{omgRoot}/nodes/{type}/`, parses each as a GraphNode,
 * skips invalid files, and returns results sorted by `updated` descending.
 *
 * Returns an empty array if the directory does not exist.
 */
export async function listNodesByType(omgRoot: string, type: NodeType): Promise<GraphNode[]> {
  const dir = path.join(omgRoot, 'nodes', type)

  let entries: string[]
  try {
    const dirEntries = await readdir(dir)
    entries = dirEntries
  } catch {
    return []
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
 * Returns an empty array if the `nodes/` directory does not exist.
 */
export async function listAllNodes(omgRoot: string): Promise<GraphNode[]> {
  const nodesDir = path.join(omgRoot, 'nodes')

  try {
    await readdir(nodesDir)
  } catch {
    return []
  }

  const allNodes = await Promise.all(
    NODE_TYPES.map((type) => listNodesByType(omgRoot, type))
  )

  const flat = allNodes.flat()

  return [...flat].sort((a, b) => b.frontmatter.updated.localeCompare(a.frontmatter.updated))
}
