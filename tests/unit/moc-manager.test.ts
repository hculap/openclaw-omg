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

import { applyMocUpdate, regenerateMoc } from '../../src/graph/moc-manager.js'
import type { GraphNode } from '../../src/types.js'

const TODAY = new Date().toISOString().slice(0, 10)

function readFile(path: string): string {
  return memfs.readFileSync(path, 'utf-8') as string
}

function makeNode(id: string, domain: string = 'identity'): GraphNode {
  return {
    filePath: `/omg/nodes/${domain}/${id}.md`,
    body: '',
    frontmatter: {
      id,
      description: `Test node ${id}`,
      type: 'fact',
      priority: 'high',
      created: TODAY,
      updated: TODAY,
    },
  }
}

// ---------------------------------------------------------------------------
// applyMocUpdate
// ---------------------------------------------------------------------------

describe('applyMocUpdate', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('throws when nodeId is an empty string', async () => {
    await expect(
      applyMocUpdate('/omg/mocs/moc-identity.md', { action: 'add', nodeId: '' })
    ).rejects.toThrow('MocUpdateEntry.nodeId must not be empty')
  })

  it('throws when nodeId is whitespace-only', async () => {
    await expect(
      applyMocUpdate('/omg/mocs/moc-identity.md', { action: 'add', nodeId: '   ' })
    ).rejects.toThrow('MocUpdateEntry.nodeId must not be empty')
  })

  it('creates the file with the wikilink when MOC does not exist', async () => {
    await applyMocUpdate('/omg/mocs/moc-identity.md', {
      action: 'add',
      nodeId: 'omg/identity/preferred-name-2026-02-20',
    })

    const content = readFile('/omg/mocs/moc-identity.md')
    expect(content).toContain('[[omg/identity/preferred-name-2026-02-20]]')
  })

  it('adds wikilink to existing MOC with existing links', async () => {
    vol.fromJSON({
      '/omg/mocs/moc-identity.md': [
        '---',
        'type: moc',
        'domain: identity',
        `updated: ${TODAY}`,
        '---',
        '',
        '# Identity',
        '',
        '- [[omg/identity/timezone-2026-02-20]]',
      ].join('\n'),
    })

    await applyMocUpdate('/omg/mocs/moc-identity.md', {
      action: 'add',
      nodeId: 'omg/identity/preferred-name-2026-02-20',
    })

    const content = readFile('/omg/mocs/moc-identity.md')
    expect(content).toContain('[[omg/identity/preferred-name-2026-02-20]]')
    expect(content).toContain('[[omg/identity/timezone-2026-02-20]]')
  })

  it('does not add a duplicate wikilink (idempotent)', async () => {
    const existingLink = '- [[omg/identity/preferred-name-2026-02-20]]'
    vol.fromJSON({
      '/omg/mocs/moc-identity.md': [
        '---',
        'type: moc',
        'domain: identity',
        `updated: ${TODAY}`,
        '---',
        '',
        '# Identity',
        '',
        existingLink,
      ].join('\n'),
    })

    await applyMocUpdate('/omg/mocs/moc-identity.md', {
      action: 'add',
      nodeId: 'omg/identity/preferred-name-2026-02-20',
    })

    const content = readFile('/omg/mocs/moc-identity.md')
    const occurrences = (content.match(/\[\[omg\/identity\/preferred-name-2026-02-20\]\]/g) ?? []).length
    expect(occurrences).toBe(1)
  })

  it('removes an existing wikilink', async () => {
    vol.fromJSON({
      '/omg/mocs/moc-identity.md': [
        '---',
        'type: moc',
        'domain: identity',
        `updated: ${TODAY}`,
        '---',
        '',
        '# Identity',
        '',
        '- [[omg/identity/preferred-name-2026-02-20]]',
        '- [[omg/identity/timezone-2026-02-20]]',
      ].join('\n'),
    })

    await applyMocUpdate('/omg/mocs/moc-identity.md', {
      action: 'remove',
      nodeId: 'omg/identity/preferred-name-2026-02-20',
    })

    const content = readFile('/omg/mocs/moc-identity.md')
    expect(content).not.toContain('[[omg/identity/preferred-name-2026-02-20]]')
    expect(content).toContain('[[omg/identity/timezone-2026-02-20]]')
  })

  it('is unchanged when removing an absent wikilink (no error)', async () => {
    vol.fromJSON({
      '/omg/mocs/moc-identity.md': [
        '---',
        'type: moc',
        'domain: identity',
        `updated: ${TODAY}`,
        '---',
        '',
        '# Identity',
        '',
        '- [[omg/identity/timezone-2026-02-20]]',
      ].join('\n'),
    })

    await applyMocUpdate('/omg/mocs/moc-identity.md', {
      action: 'remove',
      nodeId: 'omg/identity/preferred-name-2026-02-20',
    })

    const content = readFile('/omg/mocs/moc-identity.md')
    expect(content).toContain('[[omg/identity/timezone-2026-02-20]]')
    expect(content).not.toContain('[[omg/identity/preferred-name-2026-02-20]]')
  })

  it('creates the file on nonexistent path (missing directory)', async () => {
    // memfs starts empty — directory does not exist
    await applyMocUpdate('/omg/mocs/moc-identity.md', {
      action: 'add',
      nodeId: 'omg/identity/preferred-name-2026-02-20',
    })

    const content = readFile('/omg/mocs/moc-identity.md')
    expect(content).toContain('[[omg/identity/preferred-name-2026-02-20]]')
  })

  it('propagates non-ENOENT errors from readFile (e.g. EACCES)', async () => {
    vol.fromJSON({
      '/omg/mocs/moc-identity.md': '---\ntype: moc\ndomain: identity\n---\n# Identity\n',
    })

    const accessError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const readSpy = vi.spyOn(memfs.promises, 'readFile').mockRejectedValueOnce(accessError)

    await expect(
      applyMocUpdate('/omg/mocs/moc-identity.md', { action: 'add', nodeId: 'omg/identity/test' })
    ).rejects.toThrow('EACCES')

    readSpy.mockRestore()
  })

  it('propagates errors from the underlying write (e.g. ENOSPC)', async () => {
    const writeError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    })
    const writeSpy = vi.spyOn(memfs.promises, 'writeFile').mockRejectedValueOnce(writeError)

    await expect(
      applyMocUpdate('/omg/mocs/moc-identity.md', { action: 'add', nodeId: 'omg/identity/test' })
    ).rejects.toThrow()

    writeSpy.mockRestore()
  })

  it('updates the frontmatter updated field to today', async () => {
    const oldDate = '2024-01-01'
    vol.fromJSON({
      '/omg/mocs/moc-identity.md': [
        '---',
        'type: moc',
        'domain: identity',
        `updated: ${oldDate}`,
        '---',
        '',
        '# Identity',
        '',
      ].join('\n'),
    })

    await applyMocUpdate('/omg/mocs/moc-identity.md', {
      action: 'add',
      nodeId: 'omg/identity/preferred-name-2026-02-20',
    })

    const content = readFile('/omg/mocs/moc-identity.md')
    expect(content).toContain(`updated: ${TODAY}`)
    expect(content).not.toContain(`updated: ${oldDate}`)
  })
})

// ---------------------------------------------------------------------------
// regenerateMoc
// ---------------------------------------------------------------------------

describe('regenerateMoc', () => {
  beforeEach(() => {
    vol.reset()
  })

  it('generates correct wikilinks in alphabetical order', async () => {
    const nodes = [
      makeNode('omg/identity/timezone-2026-02-20'),
      makeNode('omg/identity/preferred-name-2026-02-20'),
    ]

    await regenerateMoc('identity', nodes, '/omg')

    const content = readFile('/omg/mocs/moc-identity.md')
    const prefIdx = content.indexOf('[[omg/identity/preferred-name-2026-02-20]]')
    const tzIdx = content.indexOf('[[omg/identity/timezone-2026-02-20]]')
    expect(prefIdx).toBeGreaterThan(-1)
    expect(tzIdx).toBeGreaterThan(-1)
    expect(prefIdx).toBeLessThan(tzIdx)
  })

  it('produces header only when nodes list is empty', async () => {
    await regenerateMoc('identity', [], '/omg')

    const content = readFile('/omg/mocs/moc-identity.md')
    expect(content).toContain('# Identity')
    expect(content).not.toContain('[[')
  })

  it('is deterministic (same output for same input)', async () => {
    const nodes = [
      makeNode('omg/identity/timezone-2026-02-20'),
      makeNode('omg/identity/preferred-name-2026-02-20'),
    ]

    await regenerateMoc('identity', nodes, '/omg')
    const first = readFile('/omg/mocs/moc-identity.md')

    await regenerateMoc('identity', nodes, '/omg')
    const second = readFile('/omg/mocs/moc-identity.md')

    expect(first).toBe(second)
  })

  it('capitalises the domain name in the header', async () => {
    await regenerateMoc('identity', [], '/omg')

    const content = readFile('/omg/mocs/moc-identity.md')
    expect(content).toContain('# Identity')
  })

  it('completely overwrites existing content', async () => {
    vol.fromJSON({
      '/omg/mocs/moc-identity.md': [
        '---',
        'type: moc',
        'domain: identity',
        'updated: 2020-01-01',
        '---',
        '',
        '# Identity',
        '',
        '- [[omg/identity/old-stale-node]]',
      ].join('\n'),
    })

    const nodes = [makeNode('omg/identity/preferred-name-2026-02-20')]
    await regenerateMoc('identity', nodes, '/omg')

    const content = readFile('/omg/mocs/moc-identity.md')
    expect(content).not.toContain('[[omg/identity/old-stale-node]]')
    expect(content).toContain('[[omg/identity/preferred-name-2026-02-20]]')
    expect(content).toContain(`updated: ${TODAY}`)
  })
})
