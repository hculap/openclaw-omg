import path from 'node:path'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { MocUpdateEntry, GraphNode } from '../types.js'
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter.js'
import { insertWikilink, removeWikilink } from '../utils/markdown.js'
import { resolveMocPath } from '../utils/paths.js'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath)
  const tmpPath = path.join(dir, `.tmp-${randomBytes(8).toString('hex')}`)
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.rename(tmpPath, filePath)
  } catch (err) {
    try {
      await fs.unlink(tmpPath)
    } catch {
      // ignore — tmp file may not exist if writeFile failed
    }
    throw err
  }
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Applies a single add/remove update to a MOC file.
 *
 * - If the MOC does not exist, it is created.
 * - The 'updated' frontmatter field is set to today's date.
 * - Writes are performed atomically via a temp-file rename.
 */
export async function applyMocUpdate(
  mocPath: string,
  update: MocUpdateEntry,
): Promise<void> {
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
  await atomicWrite(mocPath, output)
}

/**
 * Fully regenerates the MOC for a given domain from the provided node list.
 *
 * - Sorts nodes alphabetically by their `id` field.
 * - Overwrites any existing content deterministically.
 * - Writes atomically.
 */
export async function regenerateMoc(
  domain: string,
  nodes: GraphNode[],
  omgRoot: string,
): Promise<void> {
  const mocPath = resolveMocPath(omgRoot, domain)

  const sortedNodes = [...nodes].sort((a, b) => {
    const idA = String(a.frontmatter.id ?? '')
    const idB = String(b.frontmatter.id ?? '')
    return idA.localeCompare(idB)
  })

  const header = `# ${capitalise(domain)}`
  const linkLines = sortedNodes
    .map((node) => `- [[${String(node.frontmatter.id ?? '')}]]`)
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
  await atomicWrite(mocPath, output)
}
