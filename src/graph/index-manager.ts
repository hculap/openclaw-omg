import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { OmgConfig } from '../config.js'
import type { NodeType } from '../types.js'
import { parseFrontmatter } from '../utils/frontmatter.js'
import { atomicWrite, isEnoent } from '../utils/fs.js'
import { resolveOmgRoot, resolveMocPath } from '../utils/paths.js'
import { capitalise } from '../utils/string.js'

// Subdirectories created under `nodes/` during scaffold. Intentionally omits
// 'reflection' (stored under `reflections/`, not `nodes/`), and 'moc',
// 'index', 'now' (stored at the root level — mocs/, index.md, now.md).
// Must be kept in sync with write paths in node-writer.ts.
const NODE_TYPE_DIRS: readonly NodeType[] = [
  'identity',
  'preference',
  'project',
  'decision',
  'fact',
  'episode',
]

const MOC_DOMAINS = [
  'identity',
  'preferences',
  'projects',
  'decisions',
  'facts',
  'reflections',
] as const

function buildIndexFrontmatter(created: string, updated: string): string {
  return `---\ntype: index\nid: omg/index\npriority: high\ncreated: ${created}\nupdated: ${updated}\n---\n`
}

function buildNowFrontmatter(iso: string): string {
  return `---\ntype: now\nid: omg/now\npriority: high\ncreated: ${iso}\nupdated: ${iso}\n---\n`
}

function buildMocContent(domain: string, dateOnly: string): string {
  return `---\ntype: moc\ndomain: ${domain}\nupdated: ${dateOnly}\n---\n# ${capitalise(domain)}\n`
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath)
    return stat.isDirectory()
  } catch (err) {
    if (isEnoent(err)) {
      return false
    }
    throw err
  }
}

async function writeFileIfAbsent(filePath: string, content: string): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return
    }
    throw new Error(
      `Failed to write scaffold file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err }
    )
  }
}

async function listMocFiles(mocsDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(mocsDir)
    return entries.filter((entry) => entry.endsWith('.md')).sort()
  } catch (err) {
    if (isEnoent(err)) {
      return []
    }
    throw new Error(
      `Failed to read MOC directory ${mocsDir}: ${(err as Error).message ?? String(err)}`,
      { cause: err }
    )
  }
}

async function readExistingCreated(indexPath: string): Promise<string | null> {
  let raw: string
  try {
    raw = await fs.readFile(indexPath, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) {
      return null
    }
    throw new Error(
      `Failed to read ${indexPath} for created timestamp: ${err instanceof Error ? err.message : String(err)}`,
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
 * Scaffolds the OMG graph directory structure if it does not already exist.
 *
 * Non-destructive: if omgRoot already exists the function returns immediately
 * without modifying any existing files. Note that once omgRoot exists, this
 * function assumes the internal structure is complete — a partially initialised
 * structure within an existing root is not repaired.
 *
 * When creating for the first time, each individual file is also checked before
 * writing so partial scaffolds within a newly created root are handled safely.
 *
 * @param workspaceDir - Absolute path to the workspace root.
 * @param config - The parsed OMG configuration.
 */
export async function scaffoldGraphIfNeeded(
  workspaceDir: string,
  config: OmgConfig
): Promise<void> {
  const omgRoot = resolveOmgRoot(workspaceDir, config)

  const rootExists = await directoryExists(omgRoot)
  if (rootExists) {
    return
  }

  const iso = new Date().toISOString()
  const dateOnly = iso.slice(0, 10)

  const dirsToCreate = [
    omgRoot,
    path.join(omgRoot, 'mocs'),
    path.join(omgRoot, 'reflections'),
    ...NODE_TYPE_DIRS.map((nodeDir) => path.join(omgRoot, 'nodes', nodeDir)),
  ]

  for (const dir of dirsToCreate) {
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch (err) {
      throw new Error(
        `Failed to create scaffold directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      )
    }
  }

  await writeFileIfAbsent(
    path.join(omgRoot, 'index.md'),
    `${buildIndexFrontmatter(iso, iso)}# OMG Index\n`
  )

  await writeFileIfAbsent(
    path.join(omgRoot, 'now.md'),
    `${buildNowFrontmatter(iso)}# Now\n`
  )

  for (const domain of MOC_DOMAINS) {
    const mocPath = resolveMocPath(omgRoot, domain)
    await writeFileIfAbsent(mocPath, buildMocContent(domain, dateOnly))
  }
}

/**
 * Regenerates the index.md file for the OMG graph, listing all MOC files
 * as wikilinks and reflecting the current node count.
 *
 * Preserves the `created` timestamp from the existing index.md if present,
 * falling back to the current time on first generation.
 *
 * The write is atomic: content is first written to a temporary file in
 * the same directory as index.md, then renamed to index.md so readers
 * never see a partial file.
 *
 * @param omgRoot - Absolute path to the OMG storage root.
 * @param nodeCount - The current total number of knowledge nodes in the graph.
 */
export async function regenerateIndex(omgRoot: string, nodeCount: number): Promise<void> {
  const mocsDir = path.join(omgRoot, 'mocs')
  const indexPath = path.join(omgRoot, 'index.md')

  const mocFiles = await listMocFiles(mocsDir)

  const wikilinks = mocFiles
    .map((file) => `- [[${file.replace(/\.md$/, '')}]]`)
    .join('\n')

  const iso = new Date().toISOString()
  const existingCreated = await readExistingCreated(indexPath)
  const created = existingCreated ?? iso

  const content = [
    '---',
    'type: index',
    'id: omg/index',
    'priority: high',
    `created: ${created}`,
    `updated: ${iso}`,
    '---',
    '# OMG Index',
    '',
    `Nodes: ${nodeCount}`,
    '',
    '## Maps of Content',
    '',
    wikilinks,
    '',
  ].join('\n')

  try {
    await atomicWrite(indexPath, content)
  } catch (error) {
    throw new Error(
      `Failed to regenerate index at ${indexPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    )
  }
}
