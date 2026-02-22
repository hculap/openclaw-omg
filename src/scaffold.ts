import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { OmgConfig } from './config.js'
import { resolveOmgRoot } from './utils/paths.js'

const TEMPLATES_DIR = fileURLToPath(new URL('../templates', import.meta.url))

const TEMPLATE_FILES = [
  'index.md',
  'now.md',
  'moc-identity.md',
  'moc-preferences.md',
  'moc-projects.md',
  'moc-decisions.md',
  'moc-facts.md',
  'moc-reflections.md',
]

const NODE_SUBDIRS = [
  'identity',
  'preference',
  'project',
  'decision',
  'fact',
  'episode',
  'reflection',
]

/**
 * Creates the OMG graph directory structure and seeds template files if the
 * graph root does not yet exist. Idempotent — returns early when `index.md`
 * already exists in `omgRoot`.
 *
 * @param workspaceDir - Absolute path to the workspace root.
 * @param config - The parsed OMG configuration.
 */
export async function scaffoldGraphIfNeeded(workspaceDir: string, config: OmgConfig): Promise<void> {
  const omgRoot = resolveOmgRoot(workspaceDir, config)
  const indexPath = path.join(omgRoot, 'index.md')

  try {
    await fs.access(indexPath)
    return
  } catch {
    // index.md does not exist — proceed with scaffold
  }

  await fs.mkdir(path.join(omgRoot, 'mocs'), { recursive: true })
  await Promise.all(
    NODE_SUBDIRS.map((sub) => fs.mkdir(path.join(omgRoot, 'nodes', sub), { recursive: true }))
  )

  const date = new Date().toISOString().slice(0, 10)
  await Promise.all(
    TEMPLATE_FILES.map(async (filename) => {
      const src = path.join(TEMPLATES_DIR, filename)
      const raw = await fs.readFile(src, 'utf8')
      const content = raw.replaceAll('{{DATE}}', date)
      await fs.writeFile(path.join(omgRoot, filename), content, 'utf8')
    })
  )
}
