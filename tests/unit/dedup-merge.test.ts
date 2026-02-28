import { describe, it, expect, vi, beforeEach } from 'vitest'
import { vol } from 'memfs'
import { clearRegistryCache } from '../../src/graph/registry.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

const { executeMerge } = await import('../../src/dedup/merge.js')

const OMG_ROOT = '/workspace/memory/omg'

function makeNodeFile(id: string, opts: { links?: string[] } = {}): string {
  const linkYaml = opts.links && opts.links.length > 0
    ? `links:\n${opts.links.map((l) => `  - ${l}`).join('\n')}\n`
    : ''
  return `---
id: ${id}
description: Node ${id}
type: preference
priority: medium
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
${linkYaml}---
Body for ${id}.`
}

function makeRegistryData(nodes: Record<string, {
  filePath: string
  links?: string[]
  archived?: boolean
}>) {
  const entries: Record<string, unknown> = {}
  for (const [id, opts] of Object.entries(nodes)) {
    entries[id] = {
      type: 'preference',
      kind: 'observation',
      description: `Node ${id}`,
      priority: 'medium',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      filePath: opts.filePath,
      ...(opts.links ? { links: opts.links } : {}),
      ...(opts.archived ? { archived: true } : {}),
    }
  }
  return { version: 1, nodes: entries }
}

beforeEach(() => {
  vol.reset()
  clearRegistryCache()
})

// ---------------------------------------------------------------------------
// Redirect incoming links after merge
// ---------------------------------------------------------------------------

describe('executeMerge — link redirect', () => {
  it('redirects incoming links from losers to keeper', async () => {
    const keeperPath = `${OMG_ROOT}/nodes/preference/keeper.md`
    const loserPath = `${OMG_ROOT}/nodes/preference/loser.md`
    const refererPath = `${OMG_ROOT}/nodes/preference/referer.md`

    vol.fromJSON({
      [keeperPath]: makeNodeFile('omg/keeper'),
      [loserPath]: makeNodeFile('omg/loser'),
      [refererPath]: makeNodeFile('omg/referer', { links: ['omg/loser', 'omg/unrelated'] }),
      [`${OMG_ROOT}/registry.json`]: JSON.stringify(makeRegistryData({
        'omg/keeper': { filePath: keeperPath },
        'omg/loser': { filePath: loserPath },
        'omg/referer': { filePath: refererPath, links: ['omg/loser', 'omg/unrelated'] },
      })),
    })

    const filePaths = new Map([
      ['omg/keeper', keeperPath],
      ['omg/loser', loserPath],
    ])

    await executeMerge(
      {
        keepUid: 'uid-keeper',
        keepNodeId: 'omg/keeper',
        mergeUids: ['uid-loser'],
        mergeNodeIds: ['omg/loser'],
        aliasKeys: [],
        conflicts: [],
        patch: {},
      },
      filePaths,
      OMG_ROOT,
    )

    const { fs } = await import('memfs')
    const refererContent = fs.readFileSync(refererPath, 'utf-8') as string
    // The loser link should be replaced with keeper
    expect(refererContent).toContain('omg/keeper')
    expect(refererContent).not.toContain('omg/loser')
    // Unrelated links should be preserved
    expect(refererContent).toContain('omg/unrelated')
  })

  it('does not create duplicate links when referer already links to keeper', async () => {
    const keeperPath = `${OMG_ROOT}/nodes/preference/keeper.md`
    const loserPath = `${OMG_ROOT}/nodes/preference/loser.md`
    const refererPath = `${OMG_ROOT}/nodes/preference/referer.md`

    vol.fromJSON({
      [keeperPath]: makeNodeFile('omg/keeper'),
      [loserPath]: makeNodeFile('omg/loser'),
      [refererPath]: makeNodeFile('omg/referer', { links: ['omg/loser', 'omg/keeper'] }),
      [`${OMG_ROOT}/registry.json`]: JSON.stringify(makeRegistryData({
        'omg/keeper': { filePath: keeperPath },
        'omg/loser': { filePath: loserPath },
        'omg/referer': { filePath: refererPath, links: ['omg/loser', 'omg/keeper'] },
      })),
    })

    const filePaths = new Map([
      ['omg/keeper', keeperPath],
      ['omg/loser', loserPath],
    ])

    await executeMerge(
      {
        keepUid: 'uid-keeper',
        keepNodeId: 'omg/keeper',
        mergeUids: ['uid-loser'],
        mergeNodeIds: ['omg/loser'],
        aliasKeys: [],
        conflicts: [],
        patch: {},
      },
      filePaths,
      OMG_ROOT,
    )

    const { fs } = await import('memfs')
    const refererContent = fs.readFileSync(refererPath, 'utf-8') as string
    // Should have exactly one 'omg/keeper' link
    const matches = refererContent.match(/omg\/keeper/g) ?? []
    expect(matches.length).toBe(1)
    // Loser link should be gone
    expect(refererContent).not.toContain('omg/loser')
  })

  it('handles nodes with no incoming links gracefully', async () => {
    const keeperPath = `${OMG_ROOT}/nodes/preference/keeper.md`
    const loserPath = `${OMG_ROOT}/nodes/preference/loser.md`

    vol.fromJSON({
      [keeperPath]: makeNodeFile('omg/keeper'),
      [loserPath]: makeNodeFile('omg/loser'),
      [`${OMG_ROOT}/registry.json`]: JSON.stringify(makeRegistryData({
        'omg/keeper': { filePath: keeperPath },
        'omg/loser': { filePath: loserPath },
      })),
    })

    const filePaths = new Map([
      ['omg/keeper', keeperPath],
      ['omg/loser', loserPath],
    ])

    // Should not throw
    await expect(
      executeMerge(
        {
          keepUid: 'uid-keeper',
          keepNodeId: 'omg/keeper',
          mergeUids: ['uid-loser'],
          mergeNodeIds: ['omg/loser'],
          aliasKeys: [],
          conflicts: [],
          patch: {},
        },
        filePaths,
        OMG_ROOT,
      ),
    ).resolves.not.toThrow()
  })
})
