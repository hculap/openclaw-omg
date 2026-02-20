import { vi, describe, it, expect, beforeEach } from 'vitest'
import { vol, fs as memfs } from 'memfs'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

import { scaffoldGraphIfNeeded, regenerateIndex } from '../../src/graph/index-manager.js'
import { parseConfig } from '../../src/config.js'

const WORKSPACE = '/workspace'
const OMG_ROOT = '/workspace/memory/omg'

function readFile(path: string): string {
  return memfs.readFileSync(path, 'utf-8') as string
}

function pathExists(path: string): boolean {
  try {
    memfs.accessSync(path)
    return true
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    const stat = memfs.statSync(path)
    return stat.isDirectory()
  } catch {
    return false
  }
}

describe('scaffoldGraphIfNeeded', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('first run — creates full directory structure', async () => {
    const config = parseConfig({})

    await scaffoldGraphIfNeeded(WORKSPACE, config)

    expect(isDirectory(`${OMG_ROOT}`)).toBe(true)
    expect(isDirectory(`${OMG_ROOT}/mocs`)).toBe(true)
    expect(isDirectory(`${OMG_ROOT}/nodes`)).toBe(true)
    expect(isDirectory(`${OMG_ROOT}/nodes/identity`)).toBe(true)
    expect(isDirectory(`${OMG_ROOT}/nodes/preference`)).toBe(true)
    expect(isDirectory(`${OMG_ROOT}/nodes/project`)).toBe(true)
    expect(isDirectory(`${OMG_ROOT}/nodes/decision`)).toBe(true)
    expect(isDirectory(`${OMG_ROOT}/nodes/fact`)).toBe(true)
    expect(isDirectory(`${OMG_ROOT}/nodes/episode`)).toBe(true)
    expect(isDirectory(`${OMG_ROOT}/reflections`)).toBe(true)
  })

  it('first run — index.md created with correct frontmatter type', async () => {
    const config = parseConfig({})

    await scaffoldGraphIfNeeded(WORKSPACE, config)

    const indexContent = readFile(`${OMG_ROOT}/index.md`)
    expect(indexContent).toContain('type: index')
    expect(indexContent).toContain('id: omg/index')
    expect(indexContent).toContain('priority: high')
    expect(indexContent).toContain('# OMG Index')
  })

  it('first run — now.md created with type=now', async () => {
    const config = parseConfig({})

    await scaffoldGraphIfNeeded(WORKSPACE, config)

    const nowContent = readFile(`${OMG_ROOT}/now.md`)
    expect(nowContent).toContain('type: now')
    expect(nowContent).toContain('id: omg/now')
    expect(nowContent).toContain('priority: high')
    expect(nowContent).toContain('# Now')
  })

  it('first run — moc-identity.md is created with correct content', async () => {
    const config = parseConfig({})

    await scaffoldGraphIfNeeded(WORKSPACE, config)

    const mocPath = `${OMG_ROOT}/mocs/moc-identity.md`
    expect(pathExists(mocPath)).toBe(true)
    const content = readFile(mocPath)
    expect(content).toContain('type: moc')
    expect(content).toContain('domain: identity')
    expect(content).toContain('# Identity')
  })

  it('first run — all six MOC files are created', async () => {
    const config = parseConfig({})

    await scaffoldGraphIfNeeded(WORKSPACE, config)

    const expectedMocs = [
      'moc-identity.md',
      'moc-preferences.md',
      'moc-projects.md',
      'moc-decisions.md',
      'moc-facts.md',
      'moc-reflections.md',
    ]
    for (const moc of expectedMocs) {
      expect(pathExists(`${OMG_ROOT}/mocs/${moc}`)).toBe(true)
    }
  })

  it('first run — nodes/identity/ directory exists', async () => {
    const config = parseConfig({})

    await scaffoldGraphIfNeeded(WORKSPACE, config)

    expect(isDirectory(`${OMG_ROOT}/nodes/identity`)).toBe(true)
  })

  it('second run — idempotent, does NOT overwrite existing files', async () => {
    const config = parseConfig({})

    await scaffoldGraphIfNeeded(WORKSPACE, config)

    const customContent = '---\ntype: index\ncustom: preserved\n---\n# Custom Index\n'
    memfs.writeFileSync(`${OMG_ROOT}/index.md`, customContent, { encoding: 'utf-8' })

    await scaffoldGraphIfNeeded(WORKSPACE, config)

    const indexContent = readFile(`${OMG_ROOT}/index.md`)
    expect(indexContent).toBe(customContent)
  })

  it('second run — idempotent when omgRoot already exists (returns early)', async () => {
    const config = parseConfig({})

    vol.fromJSON({
      [`${OMG_ROOT}/index.md`]: '---\ntype: index\n---\n# Existing\n',
    })

    await scaffoldGraphIfNeeded(WORKSPACE, config)

    // Should not have created mocs/ since we returned early when root existed
    // The directory structure should still only contain what was pre-seeded
    const indexContent = readFile(`${OMG_ROOT}/index.md`)
    expect(indexContent).toBe('---\ntype: index\n---\n# Existing\n')
  })

  it('custom storagePath — files created at correct location', async () => {
    const config = parseConfig({ storagePath: 'custom/path/graph' })
    const customRoot = '/workspace/custom/path/graph'

    await scaffoldGraphIfNeeded(WORKSPACE, config)

    expect(isDirectory(customRoot)).toBe(true)
    expect(pathExists(`${customRoot}/index.md`)).toBe(true)
    expect(pathExists(`${customRoot}/now.md`)).toBe(true)
    expect(isDirectory(`${customRoot}/mocs`)).toBe(true)
    expect(isDirectory(`${customRoot}/nodes/identity`)).toBe(true)
  })
})

describe('regenerateIndex', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('creates/updates index.md with correct node count', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/mocs/moc-identity.md`]: '---\ntype: moc\n---\n',
      [`${OMG_ROOT}/mocs/moc-facts.md`]: '---\ntype: moc\n---\n',
    })

    await regenerateIndex(OMG_ROOT, 42)

    const content = readFile(`${OMG_ROOT}/index.md`)
    expect(content).toContain('Nodes: 42')
    expect(content).toContain('type: index')
    expect(content).toContain('id: omg/index')
    expect(content).toContain('priority: high')
    expect(content).toContain('# OMG Index')
    expect(content).toContain('## Maps of Content')
  })

  it('index.md lists MOC files as wikilinks', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/mocs/moc-identity.md`]: '---\ntype: moc\n---\n',
      [`${OMG_ROOT}/mocs/moc-facts.md`]: '---\ntype: moc\n---\n',
    })

    await regenerateIndex(OMG_ROOT, 10)

    const content = readFile(`${OMG_ROOT}/index.md`)
    expect(content).toContain('[[moc-identity]]')
    expect(content).toContain('[[moc-facts]]')
  })

  it('empty mocs/ dir — index.md created with empty MOC list', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/mocs/.keep`]: '',
    })

    await regenerateIndex(OMG_ROOT, 0)

    const content = readFile(`${OMG_ROOT}/index.md`)
    expect(content).toContain('Nodes: 0')
    expect(content).toContain('## Maps of Content')
    expect(content).not.toContain('[[moc-')
  })

  it('atomic write — no temp files remain after write', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/mocs/moc-identity.md`]: '---\ntype: moc\n---\n',
    })

    await regenerateIndex(OMG_ROOT, 5)

    const rootFiles = memfs.readdirSync(OMG_ROOT) as string[]
    const tempFiles = rootFiles.filter(
      (f) => f.startsWith('.tmp-') || f.endsWith('.tmp') || f.startsWith('tmp-')
    )
    expect(tempFiles).toHaveLength(0)

    expect(pathExists(`${OMG_ROOT}/index.md`)).toBe(true)
  })

  it('overwrites existing index.md with fresh content', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/index.md`]: '---\ntype: index\n---\n# Old Index\n\nNodes: 0\n',
      [`${OMG_ROOT}/mocs/moc-identity.md`]: '---\ntype: moc\n---\n',
    })

    await regenerateIndex(OMG_ROOT, 99)

    const content = readFile(`${OMG_ROOT}/index.md`)
    expect(content).toContain('Nodes: 99')
    expect(content).not.toContain('# Old Index')
  })
})
