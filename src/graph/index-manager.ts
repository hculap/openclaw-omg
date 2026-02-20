import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { OmgConfig } from '../config.js'
import { resolveOmgRoot, resolveMocPath } from '../utils/paths.js'

const MOC_DOMAINS = [
  'identity',
  'preferences',
  'projects',
  'decisions',
  'facts',
  'reflections',
] as const

const NODE_TYPE_DIRS = [
  'identity',
  'preference',
  'project',
  'decision',
  'fact',
  'episode',
] as const

function capitalise(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function buildIndexFrontmatter(iso: string): string {
  return `---\ntype: index\nid: omg/index\npriority: high\ncreated: ${iso}\nupdated: ${iso}\n---\n`
}

function buildNowFrontmatter(iso: string): string {
  return `---\ntype: now\nid: omg/now\npriority: high\ncreated: ${iso}\nupdated: ${iso}\n---\n`
}

function buildMocContent(domain: string, dateOnly: string): string {
  return `---\ntype: moc\ndomain: ${domain}\nupdated: ${dateOnly}\n---\n# ${capitalise(domain)}\n`
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    await fs.access(dirPath)
    return true
  } catch {
    return false
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function writeFileIfAbsent(filePath: string, content: string): Promise<void> {
  const exists = await fileExists(filePath)
  if (!exists) {
    await fs.writeFile(filePath, content, 'utf-8')
  }
}

/**
 * Scaffolds the OMG graph directory structure if it does not already exist.
 *
 * Idempotent: if omgRoot already exists the function returns immediately
 * without modifying any existing files. When creating for the first time,
 * each individual file is also checked before writing so partial scaffolds
 * are handled safely.
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

  await fs.mkdir(omgRoot, { recursive: true })
  await fs.mkdir(path.join(omgRoot, 'mocs'), { recursive: true })
  await fs.mkdir(path.join(omgRoot, 'reflections'), { recursive: true })

  for (const nodeDir of NODE_TYPE_DIRS) {
    await fs.mkdir(path.join(omgRoot, 'nodes', nodeDir), { recursive: true })
  }

  await writeFileIfAbsent(
    path.join(omgRoot, 'index.md'),
    `${buildIndexFrontmatter(iso)}# OMG Index\n`
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
 * The write is atomic: content is first written to a temporary file in
 * omgRoot, then renamed to index.md so readers never see a partial file.
 *
 * @param omgRoot - Absolute path to the OMG storage root.
 * @param nodeCount - The current total number of knowledge nodes in the graph.
 */
export async function regenerateIndex(omgRoot: string, nodeCount: number): Promise<void> {
  const mocsDir = path.join(omgRoot, 'mocs')

  let mocFiles: string[] = []
  try {
    const entries = await fs.readdir(mocsDir)
    mocFiles = entries
      .filter((entry) => entry.endsWith('.md'))
      .sort()
  } catch {
    mocFiles = []
  }

  const wikilinks = mocFiles
    .map((file) => `- [[${file.replace(/\.md$/, '')}]]`)
    .join('\n')

  const iso = new Date().toISOString()

  const content = [
    '---',
    'type: index',
    'id: omg/index',
    'priority: high',
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

  const tmpName = `.tmp-${randomBytes(6).toString('hex')}.md`
  const tmpPath = path.join(omgRoot, tmpName)
  const indexPath = path.join(omgRoot, 'index.md')

  try {
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.rename(tmpPath, indexPath)
  } catch (error) {
    try {
      await fs.unlink(tmpPath)
    } catch {
      // ignore cleanup errors
    }
    throw new Error(`Failed to regenerate index at ${indexPath}: ${String(error)}`)
  }
}
