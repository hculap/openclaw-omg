import { vi, describe, it, expect, beforeEach } from 'vitest'
import { vol, fs as memfs } from 'memfs'

vi.mock('node:fs', async () => {
  const memfsModule = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: memfsModule.fs, ...memfsModule.fs }
})
vi.mock('node:fs/promises', async () => {
  const memfsModule = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: memfsModule.fs.promises, ...memfsModule.fs.promises }
})

import {
  getNodeIndex,
  getRegistryEntries,
  getRegistryEntry,
  getNodeFilePaths,
  registerNode,
  updateRegistryEntry,
  removeRegistryEntry,
  rebuildRegistry,
  getNodeCount,
  clearRegistryCache,
  buildRegistryEntry,
} from '../../src/graph/registry.js'
import type { RegistryNodeEntry, RegistryData } from '../../src/graph/registry.js'
import type { GraphNode } from '../../src/types.js'

const OMG_ROOT = '/test/omg'
const REGISTRY_PATH = `${OMG_ROOT}/.registry.json`

function makeEntry(overrides: Partial<RegistryNodeEntry> = {}): RegistryNodeEntry {
  return {
    type: 'fact',
    kind: 'observation',
    description: 'Test fact',
    priority: 'medium',
    created: '2026-02-20T10:00:00Z',
    updated: '2026-02-20T10:00:00Z',
    filePath: '/test/omg/nodes/fact/fact-test-2026-02-20.md',
    ...overrides,
  }
}

function writeRegistryFile(data: RegistryData): void {
  vol.mkdirSync(OMG_ROOT, { recursive: true })
  vol.writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2))
}

function readRegistryFile(): RegistryData {
  const raw = vol.readFileSync(REGISTRY_PATH, 'utf-8') as string
  return JSON.parse(raw) as RegistryData
}

beforeEach(() => {
  vol.reset()
  clearRegistryCache()
})

// ─── Empty registry creation + persistence ──────────────────────────────────

describe('empty registry', () => {
  it('creates an empty registry on cold start when no nodes exist', async () => {
    // Set up empty nodes directory
    vol.mkdirSync(`${OMG_ROOT}/nodes`, { recursive: true })

    const data = await rebuildRegistry(OMG_ROOT)

    expect(data.version).toBe(1)
    expect(Object.keys(data.nodes)).toHaveLength(0)
    expect(memfs.existsSync(REGISTRY_PATH)).toBe(true)
  })

  it('persists empty registry to disk', async () => {
    vol.mkdirSync(`${OMG_ROOT}/nodes`, { recursive: true })

    await rebuildRegistry(OMG_ROOT)

    const diskData = readRegistryFile()
    expect(diskData.version).toBe(1)
    expect(Object.keys(diskData.nodes)).toHaveLength(0)
  })
})

// ─── Register + get round-trip ──────────────────────────────────────────────

describe('registerNode + getRegistryEntry', () => {
  it('registers a node and retrieves it by ID', async () => {
    vol.mkdirSync(OMG_ROOT, { recursive: true })
    writeRegistryFile({ version: 1, nodes: {} })

    const entry = makeEntry()
    await registerNode(OMG_ROOT, 'omg/fact-test', entry)

    const retrieved = await getRegistryEntry(OMG_ROOT, 'omg/fact-test')
    expect(retrieved).toEqual(entry)
  })

  it('returns null for non-existent node', async () => {
    writeRegistryFile({ version: 1, nodes: {} })

    const retrieved = await getRegistryEntry(OMG_ROOT, 'omg/does-not-exist')
    expect(retrieved).toBeNull()
  })

  it('persists registered node to disk', async () => {
    writeRegistryFile({ version: 1, nodes: {} })

    const entry = makeEntry()
    await registerNode(OMG_ROOT, 'omg/fact-test', entry)

    const diskData = readRegistryFile()
    expect(diskData.nodes['omg/fact-test']).toEqual(entry)
  })

  it('overwrites existing entry with same ID', async () => {
    writeRegistryFile({ version: 1, nodes: {} })

    const entry1 = makeEntry({ description: 'First' })
    await registerNode(OMG_ROOT, 'omg/fact-test', entry1)

    const entry2 = makeEntry({ description: 'Second' })
    await registerNode(OMG_ROOT, 'omg/fact-test', entry2)

    const retrieved = await getRegistryEntry(OMG_ROOT, 'omg/fact-test')
    expect(retrieved?.description).toBe('Second')
  })
})

// ─── Update partial fields ──────────────────────────────────────────────────

describe('updateRegistryEntry', () => {
  it('updates partial fields on an existing entry', async () => {
    const entry = makeEntry({ priority: 'low' })
    writeRegistryFile({ version: 1, nodes: { 'omg/fact-test': entry } })

    await updateRegistryEntry(OMG_ROOT, 'omg/fact-test', {
      priority: 'high',
      description: 'Updated description',
    })

    const retrieved = await getRegistryEntry(OMG_ROOT, 'omg/fact-test')
    expect(retrieved?.priority).toBe('high')
    expect(retrieved?.description).toBe('Updated description')
    // Unchanged fields preserved
    expect(retrieved?.type).toBe('fact')
    expect(retrieved?.kind).toBe('observation')
  })

  it('is a no-op for non-existent node', async () => {
    writeRegistryFile({ version: 1, nodes: {} })

    await updateRegistryEntry(OMG_ROOT, 'omg/nonexistent', { priority: 'high' })

    const count = await getNodeCount(OMG_ROOT)
    expect(count).toBe(0)
  })

  it('persists updates to disk', async () => {
    const entry = makeEntry()
    writeRegistryFile({ version: 1, nodes: { 'omg/fact-test': entry } })

    await updateRegistryEntry(OMG_ROOT, 'omg/fact-test', { archived: true })

    const diskData = readRegistryFile()
    expect(diskData.nodes['omg/fact-test']?.archived).toBe(true)
  })
})

// ─── Remove entry ───────────────────────────────────────────────────────────

describe('removeRegistryEntry', () => {
  it('removes an existing entry', async () => {
    const entry = makeEntry()
    writeRegistryFile({ version: 1, nodes: { 'omg/fact-test': entry } })

    await removeRegistryEntry(OMG_ROOT, 'omg/fact-test')

    const retrieved = await getRegistryEntry(OMG_ROOT, 'omg/fact-test')
    expect(retrieved).toBeNull()
  })

  it('is a no-op for non-existent node', async () => {
    writeRegistryFile({ version: 1, nodes: {} })

    await removeRegistryEntry(OMG_ROOT, 'omg/nonexistent')

    const count = await getNodeCount(OMG_ROOT)
    expect(count).toBe(0)
  })

  it('persists removal to disk', async () => {
    const entry = makeEntry()
    writeRegistryFile({ version: 1, nodes: { 'omg/fact-test': entry } })

    await removeRegistryEntry(OMG_ROOT, 'omg/fact-test')

    const diskData = readRegistryFile()
    expect(diskData.nodes['omg/fact-test']).toBeUndefined()
  })
})

// ─── Filtered queries ───────────────────────────────────────────────────────

describe('getRegistryEntries (filtered)', () => {
  const entries: Record<string, RegistryNodeEntry> = {
    'omg/fact-active': makeEntry({ type: 'fact', archived: false }),
    'omg/fact-archived': makeEntry({ type: 'fact', archived: true }),
    'omg/identity-core': makeEntry({ type: 'identity', archived: false }),
    'omg/reflection-insight': makeEntry({
      type: 'reflection',
      kind: 'reflection',
      archived: false,
    }),
  }

  beforeEach(() => {
    writeRegistryFile({ version: 1, nodes: entries })
  })

  it('returns all entries when no filter', async () => {
    const result = await getRegistryEntries(OMG_ROOT)
    expect(result).toHaveLength(4)
  })

  it('filters by archived: false', async () => {
    const result = await getRegistryEntries(OMG_ROOT, { archived: false })
    expect(result).toHaveLength(3)
    expect(result.every(([, e]) => !e.archived)).toBe(true)
  })

  it('filters by archived: true', async () => {
    const result = await getRegistryEntries(OMG_ROOT, { archived: true })
    expect(result).toHaveLength(1)
    expect(result[0]![0]).toBe('omg/fact-archived')
  })

  it('filters by type', async () => {
    const result = await getRegistryEntries(OMG_ROOT, { type: 'fact' })
    expect(result).toHaveLength(2)
  })

  it('combines archived + type filters', async () => {
    const result = await getRegistryEntries(OMG_ROOT, { archived: false, type: 'fact' })
    expect(result).toHaveLength(1)
    expect(result[0]![0]).toBe('omg/fact-active')
  })
})

// ─── getNodeIndex ───────────────────────────────────────────────────────────

describe('getNodeIndex', () => {
  it('returns entries sorted by updated desc', async () => {
    writeRegistryFile({
      version: 1,
      nodes: {
        'omg/fact-old': makeEntry({ updated: '2026-01-01T00:00:00Z', description: 'Old' }),
        'omg/fact-new': makeEntry({ updated: '2026-02-20T10:00:00Z', description: 'New' }),
        'omg/fact-mid': makeEntry({ updated: '2026-01-15T00:00:00Z', description: 'Mid' }),
      },
    })

    const index = await getNodeIndex(OMG_ROOT)

    expect(index).toHaveLength(3)
    expect(index[0]!.id).toBe('omg/fact-new')
    expect(index[1]!.id).toBe('omg/fact-mid')
    expect(index[2]!.id).toBe('omg/fact-old')
  })

  it('returns id and description only', async () => {
    writeRegistryFile({
      version: 1,
      nodes: { 'omg/fact-test': makeEntry({ description: 'Test fact' }) },
    })

    const index = await getNodeIndex(OMG_ROOT)

    expect(index[0]).toEqual({ id: 'omg/fact-test', description: 'Test fact' })
  })
})

// ─── getNodeFilePaths ───────────────────────────────────────────────────────

describe('getNodeFilePaths', () => {
  it('returns file paths for requested IDs', async () => {
    writeRegistryFile({
      version: 1,
      nodes: {
        'omg/fact-a': makeEntry({ filePath: '/a.md' }),
        'omg/fact-b': makeEntry({ filePath: '/b.md' }),
        'omg/fact-c': makeEntry({ filePath: '/c.md' }),
      },
    })

    const paths = await getNodeFilePaths(OMG_ROOT, ['omg/fact-a', 'omg/fact-c', 'omg/nonexistent'])

    expect(paths.size).toBe(2)
    expect(paths.get('omg/fact-a')).toBe('/a.md')
    expect(paths.get('omg/fact-c')).toBe('/c.md')
    expect(paths.has('omg/nonexistent')).toBe(false)
  })
})

// ─── getNodeCount ───────────────────────────────────────────────────────────

describe('getNodeCount', () => {
  it('returns correct count', async () => {
    writeRegistryFile({
      version: 1,
      nodes: {
        'omg/fact-a': makeEntry(),
        'omg/fact-b': makeEntry(),
      },
    })

    const count = await getNodeCount(OMG_ROOT)
    expect(count).toBe(2)
  })

  it('returns 0 for empty registry', async () => {
    writeRegistryFile({ version: 1, nodes: {} })

    const count = await getNodeCount(OMG_ROOT)
    expect(count).toBe(0)
  })
})

// ─── Cold-start rebuild ─────────────────────────────────────────────────────

describe('cold-start rebuild from disk nodes', () => {
  it('triggers rebuild when .registry.json is missing', async () => {
    // Create a node on disk but no registry file
    vol.mkdirSync(`${OMG_ROOT}/nodes/fact`, { recursive: true })
    vol.writeFileSync(
      `${OMG_ROOT}/nodes/fact/fact-test-2026-02-20.md`,
      [
        '---',
        'id: omg/fact-test',
        'description: Test fact from disk',
        'type: fact',
        'priority: medium',
        'created: 2026-02-20T10:00:00Z',
        'updated: 2026-02-20T10:00:00Z',
        '---',
        'Test body content.',
      ].join('\n')
    )

    const entry = await getRegistryEntry(OMG_ROOT, 'omg/fact-test')

    expect(entry).not.toBeNull()
    expect(entry?.description).toBe('Test fact from disk')
    // Registry file should now exist
    expect(memfs.existsSync(REGISTRY_PATH)).toBe(true)
  })
})

// ─── Version mismatch triggers rebuild ──────────────────────────────────────

describe('version mismatch', () => {
  it('triggers rebuild when version is not 1', async () => {
    vol.mkdirSync(`${OMG_ROOT}/nodes`, { recursive: true })
    vol.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: 99, nodes: {} }))

    // Should trigger rebuild (listAllNodes returns [] from empty dirs)
    const count = await getNodeCount(OMG_ROOT)
    expect(count).toBe(0)

    // Registry on disk should now be version 1
    const diskData = readRegistryFile()
    expect(diskData.version).toBe(1)
  })
})

// ─── Corrupt JSON triggers rebuild ──────────────────────────────────────────

describe('corrupt JSON', () => {
  it('triggers rebuild when registry file contains invalid JSON', async () => {
    vol.mkdirSync(`${OMG_ROOT}/nodes`, { recursive: true })
    vol.writeFileSync(REGISTRY_PATH, 'not json at all {{{')

    const count = await getNodeCount(OMG_ROOT)
    expect(count).toBe(0)

    // Registry should be rebuilt
    const diskData = readRegistryFile()
    expect(diskData.version).toBe(1)
  })
})

// ─── Multiple omgRoot instances ─────────────────────────────────────────────

describe('multiple omgRoot instances', () => {
  const ROOT_A = '/workspace-a/omg'
  const ROOT_B = '/workspace-b/omg'

  beforeEach(() => {
    vol.mkdirSync(ROOT_A, { recursive: true })
    vol.mkdirSync(ROOT_B, { recursive: true })
    writeRegistryAtPath(ROOT_A, { version: 1, nodes: {} })
    writeRegistryAtPath(ROOT_B, { version: 1, nodes: {} })
  })

  function writeRegistryAtPath(root: string, data: RegistryData): void {
    vol.writeFileSync(`${root}/.registry.json`, JSON.stringify(data, null, 2))
  }

  it('maintains independent registries per omgRoot', async () => {
    await registerNode(ROOT_A, 'omg/fact-a', makeEntry({ description: 'A' }))
    await registerNode(ROOT_B, 'omg/fact-b', makeEntry({ description: 'B' }))

    const entryA = await getRegistryEntry(ROOT_A, 'omg/fact-a')
    const entryB = await getRegistryEntry(ROOT_B, 'omg/fact-b')

    expect(entryA?.description).toBe('A')
    expect(entryB?.description).toBe('B')

    // Cross-root lookups should fail
    expect(await getRegistryEntry(ROOT_A, 'omg/fact-b')).toBeNull()
    expect(await getRegistryEntry(ROOT_B, 'omg/fact-a')).toBeNull()
  })
})

// ─── clearRegistryCache ─────────────────────────────────────────────────────

describe('clearRegistryCache', () => {
  it('clears specific omgRoot cache', async () => {
    writeRegistryFile({
      version: 1,
      nodes: { 'omg/fact-test': makeEntry() },
    })

    // Load into cache
    await getNodeCount(OMG_ROOT)

    // Clear cache for OMG_ROOT
    clearRegistryCache(OMG_ROOT)

    // Should reload from disk
    const count = await getNodeCount(OMG_ROOT)
    expect(count).toBe(1)
  })

  it('clears all caches when no arg', async () => {
    writeRegistryFile({ version: 1, nodes: { 'omg/fact-test': makeEntry() } })
    await getNodeCount(OMG_ROOT)

    clearRegistryCache()

    // Should reload from disk
    const count = await getNodeCount(OMG_ROOT)
    expect(count).toBe(1)
  })
})

// ─── buildRegistryEntry ─────────────────────────────────────────────────────

describe('buildRegistryEntry', () => {
  it('builds entry from GraphNode', () => {
    const node: GraphNode = {
      frontmatter: {
        id: 'omg/fact-test',
        description: 'Test fact',
        type: 'fact',
        priority: 'medium',
        created: '2026-02-20T10:00:00Z',
        updated: '2026-02-20T10:00:00Z',
        tags: ['tag1'],
        links: ['omg/moc-facts'],
      },
      body: 'Test body.',
      filePath: '/test/omg/nodes/fact/fact-test-2026-02-20.md',
    }

    const entry = buildRegistryEntry(node, 'observation')

    expect(entry.type).toBe('fact')
    expect(entry.kind).toBe('observation')
    expect(entry.description).toBe('Test fact')
    expect(entry.priority).toBe('medium')
    expect(entry.tags).toEqual(['tag1'])
    expect(entry.links).toEqual(['omg/moc-facts'])
    expect(entry.filePath).toBe('/test/omg/nodes/fact/fact-test-2026-02-20.md')
  })

  it('omits optional fields when absent', () => {
    const node: GraphNode = {
      frontmatter: {
        id: 'omg/fact-test',
        description: 'Test',
        type: 'fact',
        priority: 'low',
        created: '2026-02-20T10:00:00Z',
        updated: '2026-02-20T10:00:00Z',
      },
      body: '',
      filePath: '/test.md',
    }

    const entry = buildRegistryEntry(node, 'observation')

    expect(entry.archived).toBeUndefined()
    expect(entry.links).toBeUndefined()
    expect(entry.tags).toBeUndefined()
  })
})
