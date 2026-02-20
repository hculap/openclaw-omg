import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { MocUpdateEntry, GraphNode } from '../types.js'
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter.js'
import { atomicWrite } from '../utils/fs.js'
import { insertWikilink, removeWikilink } from '../utils/markdown.js'
import { resolveMocPath } from '../utils/paths.js'
import { capitalise } from '../utils/string.js'

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException
    if (nodeErr.code === 'ENOENT') {
      return ''
    }
    throw err
  }
}

/**
 * Applies a single add/remove update to a MOC file.
 *
 * - If the MOC does not exist, it is created.
 * - The 'updated' frontmatter field is set to today's date.
 * - Writes are performed atomically via a temp-file rename.
 * - Remove operations are idempotent: if the wikilink is not present in
 *   the file, the content is returned unchanged.
 */
export async function applyMocUpdate(
  mocPath: string,
  update: MocUpdateEntry,
): Promise<void> {
  if (!update.nodeId || update.nodeId.trim() === '') {
    throw new Error('MocUpdateEntry.nodeId must not be empty')
  }

  const raw = await readFileOrEmpty(mocPath)
  const { frontmatter, body } = parseFrontmatter(raw)

  const updatedBody =
    update.action === 'add'
      ? insertWikilink(body, update.nodeId)
      : removeWikilink(body, update.nodeId)

  const updatedFrontmatter = {
    ...frontmatter,
    updated: today(),
  }

  const output = serializeFrontmatter(updatedFrontmatter, updatedBody)
  await fs.mkdir(path.dirname(mocPath), { recursive: true })
  await atomicWrite(mocPath, output)
}

/**
 * Fully regenerates the MOC for a given domain from the provided node list.
 *
 * - Sorts nodes by `frontmatter.id` using locale-aware string comparison (localeCompare).
 * - Overwrites any existing content deterministically.
 * - Writes atomically.
 */
export async function regenerateMoc(
  domain: string,
  nodes: GraphNode[],
  omgRoot: string,
): Promise<void> {
  const mocPath = resolveMocPath(omgRoot, domain)

  const sortedNodes = [...nodes].sort((a, b) =>
    a.frontmatter.id.localeCompare(b.frontmatter.id)
  )

  const header = `# ${capitalise(domain)}`
  const linkLines = sortedNodes
    .map((node) => `- [[${node.frontmatter.id}]]`)
    .join('\n')

  const body =
    sortedNodes.length > 0
      ? `${header}\n\n${linkLines}`
      : `${header}`

  const frontmatter: Record<string, unknown> = {
    type: 'moc',
    domain,
    updated: today(),
  }

  const output = serializeFrontmatter(frontmatter, body)
  await fs.mkdir(path.dirname(mocPath), { recursive: true })
  await atomicWrite(mocPath, output)
}
