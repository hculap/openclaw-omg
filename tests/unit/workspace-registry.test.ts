import { describe, it, expect, vi, beforeEach } from 'vitest'
import { vol } from 'memfs'
import { parseConfig } from '../../src/config.js'
import type { OmgConfig } from '../../src/config.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

// os.homedir() must be mocked before importing the module under test.
vi.mock('node:os', () => ({
  default: { homedir: () => '/home/test' },
  homedir: () => '/home/test',
}))

const {
  resolveRegistryPath,
  readWorkspaceRegistry,
  writeWorkspaceRegistry,
  addWorkspace,
  pruneStaleWorkspaces,
  listWorkspacePaths,
} = await import('../../src/cron/workspace-registry.js')

const REGISTRY_PATH = '/home/test/.openclaw/omg-workspaces.json'

function makeConfig(overrides: Record<string, unknown> = {}): OmgConfig {
  return parseConfig(overrides)
}

beforeEach(() => {
  vol.reset()
})

// ---------------------------------------------------------------------------
// resolveRegistryPath
// ---------------------------------------------------------------------------

describe('resolveRegistryPath', () => {
  it('returns the expected path under ~/.openclaw', () => {
    expect(resolveRegistryPath()).toBe(REGISTRY_PATH)
  })
})

// ---------------------------------------------------------------------------
// readWorkspaceRegistry
// ---------------------------------------------------------------------------

describe('readWorkspaceRegistry', () => {
  it('returns empty registry when file does not exist (ENOENT)', async () => {
    const reg = await readWorkspaceRegistry()
    expect(reg).toEqual({ version: 1, workspaces: {} })
  })

  it('returns empty registry when file contains invalid JSON', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vol.fromJSON({ [REGISTRY_PATH]: 'not-valid-json' })
    const reg = await readWorkspaceRegistry()
    expect(reg).toEqual({ version: 1, workspaces: {} })
  })

  it('returns empty registry when JSON has wrong schema', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vol.fromJSON({ [REGISTRY_PATH]: JSON.stringify({ version: 99, workspaces: {} }) })
    const reg = await readWorkspaceRegistry()
    expect(reg).toEqual({ version: 1, workspaces: {} })
  })

  it('logs a warning when JSON is malformed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vol.fromJSON({ [REGISTRY_PATH]: '{broken' })
    await readWorkspaceRegistry()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('failed to parse registry'),
      expect.anything()
    )
  })

  it('parses a valid registry file', async () => {
    const data = {
      version: 1,
      workspaces: {
        '/ws/foo': { path: '/ws/foo', addedAt: '2026-01-01T00:00:00.000Z' },
      },
    }
    vol.fromJSON({ [REGISTRY_PATH]: JSON.stringify(data) })
    const reg = await readWorkspaceRegistry()
    expect(reg.version).toBe(1)
    expect(reg.workspaces['/ws/foo']).toMatchObject({ path: '/ws/foo' })
  })
})

// ---------------------------------------------------------------------------
// writeWorkspaceRegistry + readWorkspaceRegistry round-trip
// ---------------------------------------------------------------------------

describe('writeWorkspaceRegistry', () => {
  it('round-trips a registry correctly', async () => {
    vol.fromJSON({ '/home/test/.openclaw/.keep': '' })
    const original = {
      version: 1 as const,
      workspaces: {
        '/ws/alpha': { path: '/ws/alpha', addedAt: '2026-02-01T00:00:00.000Z' },
      },
    }
    await writeWorkspaceRegistry(original)
    const read = await readWorkspaceRegistry()
    expect(read).toEqual(original)
  })

  it('creates the parent directory if it does not exist', async () => {
    const reg = { version: 1 as const, workspaces: {} }
    await writeWorkspaceRegistry(reg)
    const read = await readWorkspaceRegistry()
    expect(read).toEqual(reg)
  })

  it('serializes concurrent writes correctly (second write is not lost)', async () => {
    vol.fromJSON({ '/home/test/.openclaw/.keep': '' })

    const reg1 = {
      version: 1 as const,
      workspaces: {
        '/ws/a': { path: '/ws/a', addedAt: '2026-01-01T00:00:00.000Z' },
      },
    }
    const reg2 = {
      version: 1 as const,
      workspaces: {
        '/ws/b': { path: '/ws/b', addedAt: '2026-01-02T00:00:00.000Z' },
      },
    }

    // Fire both writes concurrently — the second should not stomp the first mid-write.
    const [, p2] = [writeWorkspaceRegistry(reg1), writeWorkspaceRegistry(reg2)]
    await p2

    // The last write wins — the file should contain reg2.
    const read = await readWorkspaceRegistry()
    expect(read).toEqual(reg2)
  })
})

// ---------------------------------------------------------------------------
// addWorkspace
// ---------------------------------------------------------------------------

describe('addWorkspace', () => {
  it('adds a new workspace entry', () => {
    const reg = { version: 1 as const, workspaces: {} }
    const updated = addWorkspace(reg, '/ws/new')
    expect(updated.workspaces['/ws/new']).toBeDefined()
    expect(updated.workspaces['/ws/new']!.path).toBe('/ws/new')
  })

  it('sets addedAt to a valid ISO string', () => {
    const before = Date.now()
    const reg = { version: 1 as const, workspaces: {} }
    const updated = addWorkspace(reg, '/ws/new')
    const addedAt = new Date(updated.workspaces['/ws/new']!.addedAt).getTime()
    expect(addedAt).toBeGreaterThanOrEqual(before)
  })

  it('is idempotent — does not overwrite existing entry', () => {
    const original = {
      version: 1 as const,
      workspaces: {
        '/ws/existing': { path: '/ws/existing', addedAt: '2020-01-01T00:00:00.000Z' },
      },
    }
    const updated = addWorkspace(original, '/ws/existing')
    expect(updated).toBe(original) // same reference — no allocation
  })

  it('preserves existing entries', () => {
    const reg = {
      version: 1 as const,
      workspaces: {
        '/ws/old': { path: '/ws/old', addedAt: '2020-01-01T00:00:00.000Z' },
      },
    }
    const updated = addWorkspace(reg, '/ws/new')
    expect(updated.workspaces['/ws/old']).toBeDefined()
    expect(updated.workspaces['/ws/new']).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// pruneStaleWorkspaces
// ---------------------------------------------------------------------------

describe('pruneStaleWorkspaces', () => {
  it('keeps entries whose omgRoot exists', () => {
    const config = makeConfig()
    vol.fromJSON({ '/ws/valid/memory/omg/.keep': '' })

    const reg = {
      version: 1 as const,
      workspaces: {
        '/ws/valid': { path: '/ws/valid', addedAt: '2026-01-01T00:00:00.000Z' },
      },
    }
    const pruned = pruneStaleWorkspaces(reg, config)
    expect(pruned.workspaces['/ws/valid']).toBeDefined()
  })

  it('removes entries whose omgRoot does not exist', () => {
    const config = makeConfig()
    const reg = {
      version: 1 as const,
      workspaces: {
        '/ws/stale': { path: '/ws/stale', addedAt: '2026-01-01T00:00:00.000Z' },
      },
    }
    const pruned = pruneStaleWorkspaces(reg, config)
    expect(pruned.workspaces['/ws/stale']).toBeUndefined()
  })

  it('handles a mix of valid and stale entries', () => {
    const config = makeConfig()
    vol.fromJSON({ '/ws/valid/memory/omg/.keep': '' })

    const reg = {
      version: 1 as const,
      workspaces: {
        '/ws/valid': { path: '/ws/valid', addedAt: '2026-01-01T00:00:00.000Z' },
        '/ws/stale': { path: '/ws/stale', addedAt: '2026-01-01T00:00:00.000Z' },
      },
    }
    const pruned = pruneStaleWorkspaces(reg, config)
    expect(pruned.workspaces['/ws/valid']).toBeDefined()
    expect(pruned.workspaces['/ws/stale']).toBeUndefined()
  })

  it('returns a new registry object (does not mutate input)', () => {
    const config = makeConfig()
    const reg = {
      version: 1 as const,
      workspaces: {
        '/ws/stale': { path: '/ws/stale', addedAt: '2026-01-01T00:00:00.000Z' },
      },
    }
    const pruned = pruneStaleWorkspaces(reg, config)
    expect(pruned).not.toBe(reg)
    expect(reg.workspaces['/ws/stale']).toBeDefined() // original untouched
  })
})

// ---------------------------------------------------------------------------
// listWorkspacePaths
// ---------------------------------------------------------------------------

describe('listWorkspacePaths', () => {
  it('returns empty array for empty registry', () => {
    const reg = { version: 1 as const, workspaces: {} }
    expect(listWorkspacePaths(reg)).toEqual([])
  })

  it('returns all workspace paths', () => {
    const reg = {
      version: 1 as const,
      workspaces: {
        '/ws/a': { path: '/ws/a', addedAt: '2026-01-01T00:00:00.000Z' },
        '/ws/b': { path: '/ws/b', addedAt: '2026-01-02T00:00:00.000Z' },
      },
    }
    const paths = listWorkspacePaths(reg)
    expect(paths).toContain('/ws/a')
    expect(paths).toContain('/ws/b')
    expect(paths).toHaveLength(2)
  })
})
