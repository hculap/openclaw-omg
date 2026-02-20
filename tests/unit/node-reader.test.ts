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

import { readGraphNode, listNodesByType, listAllNodes } from '../../src/graph/node-reader.js'

/**
 * Builds a valid markdown node file string.
 * IDs must match the schema: `namespace/slug` (single slash, lowercase, no leading hyphen).
 */
function makeNodeFile(overrides: Partial<Record<string, unknown>> = {}): string {
  const fm = {
    id: 'omg/test-node',
    description: 'Test node',
    type: 'identity',
    priority: 'medium',
    created: '2024-01-01T00:00:00Z',
    updated: '2024-01-02T00:00:00Z',
    ...overrides,
  }
  return `---\n${Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\nBody content here`
}

beforeEach(() => {
  vol.reset()
})

// ---------------------------------------------------------------------------
// readGraphNode
// ---------------------------------------------------------------------------

describe('readGraphNode', () => {
  it('returns a correct GraphNode for a valid file', async () => {
    vol.fromJSON({
      '/omg/nodes/identity/test-node.md': makeNodeFile(),
    })

    const result = await readGraphNode('/omg/nodes/identity/test-node.md')

    expect(result).not.toBeNull()
    expect(result?.frontmatter.id).toBe('omg/test-node')
    expect(result?.frontmatter.type).toBe('identity')
    expect(result?.frontmatter.priority).toBe('medium')
    expect(result?.frontmatter.created).toBe('2024-01-01T00:00:00Z')
    expect(result?.frontmatter.updated).toBe('2024-01-02T00:00:00Z')
    expect(result?.body).toBe('Body content here')
    expect(result?.filePath).toBe('/omg/nodes/identity/test-node.md')
  })

  it('returns null for a nonexistent file path', async () => {
    const result = await readGraphNode('/omg/nodes/identity/does-not-exist.md')
    expect(result).toBeNull()
  })

  it('returns null when frontmatter is missing a required field', async () => {
    // Missing 'type' field — will fail parseNodeFrontmatter validation
    vol.fromJSON({
      '/omg/nodes/identity/bad-node.md': makeNodeFile({ type: undefined }),
    })

    const result = await readGraphNode('/omg/nodes/identity/bad-node.md')
    expect(result).toBeNull()
  })

  it('returns null for a file with malformed YAML in frontmatter', async () => {
    vol.fromJSON({
      '/omg/nodes/identity/malformed.md': '---\nkey: [unclosed bracket\n---\nBody',
    })

    const result = await readGraphNode('/omg/nodes/identity/malformed.md')
    expect(result).toBeNull()
  })

  it('throws for non-ENOENT filesystem errors (e.g. EACCES)', async () => {
    const accessError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const readSpy = vi.spyOn(memfs.promises, 'readFile').mockRejectedValueOnce(accessError)

    await expect(readGraphNode('/omg/nodes/identity/any.md')).rejects.toThrow('Failed to read node file')

    readSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// listNodesByType
// ---------------------------------------------------------------------------

describe('listNodesByType', () => {
  it('returns all nodes sorted by updated descending', async () => {
    vol.fromJSON({
      '/omg/nodes/identity/node-a.md': makeNodeFile({
        id: 'omg/node-a',
        updated: '2024-01-03T00:00:00Z',
      }),
      '/omg/nodes/identity/node-b.md': makeNodeFile({
        id: 'omg/node-b',
        updated: '2024-01-05T00:00:00Z',
      }),
      '/omg/nodes/identity/node-c.md': makeNodeFile({
        id: 'omg/node-c',
        updated: '2024-01-01T00:00:00Z',
      }),
    })

    const result = await listNodesByType('/omg', 'identity')

    expect(result).toHaveLength(3)
    expect(result[0]?.frontmatter.updated).toBe('2024-01-05T00:00:00Z')
    expect(result[1]?.frontmatter.updated).toBe('2024-01-03T00:00:00Z')
    expect(result[2]?.frontmatter.updated).toBe('2024-01-01T00:00:00Z')
  })

  it('returns an empty array when the directory does not exist', async () => {
    const result = await listNodesByType('/omg', 'identity')
    expect(result).toEqual([])
  })

  it('throws for non-ENOENT errors on the type directory (e.g. EACCES)', async () => {
    const accessError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const readdirSpy = vi.spyOn(memfs.promises, 'readdir').mockRejectedValueOnce(accessError)

    await expect(listNodesByType('/omg', 'identity')).rejects.toThrow('Failed to read node directory')

    readdirSpy.mockRestore()
  })

  it('ignores non-.md files in the directory', async () => {
    vol.fromJSON({
      '/omg/nodes/identity/node-a.md': makeNodeFile({ id: 'omg/node-a' }),
      '/omg/nodes/identity/.gitkeep': '',
      '/omg/nodes/identity/README.txt': 'some text',
    })

    const result = await listNodesByType('/omg', 'identity')

    expect(result).toHaveLength(1)
    expect(result[0]?.frontmatter.id).toBe('omg/node-a')
  })
})

// ---------------------------------------------------------------------------
// listAllNodes
// ---------------------------------------------------------------------------

describe('listAllNodes', () => {
  it('scans multiple subdirectories and returns all valid nodes sorted by updated descending', async () => {
    vol.fromJSON({
      '/omg/nodes/identity/id-node.md': makeNodeFile({
        id: 'omg/id-node',
        type: 'identity',
        updated: '2024-01-01T00:00:00Z',
      }),
      '/omg/nodes/fact/fact-node.md': makeNodeFile({
        id: 'omg/fact-node',
        type: 'fact',
        updated: '2024-01-03T00:00:00Z',
      }),
      '/omg/nodes/preference/pref-node.md': makeNodeFile({
        id: 'omg/pref-node',
        type: 'preference',
        updated: '2024-01-02T00:00:00Z',
      }),
    })

    const result = await listAllNodes('/omg')

    expect(result).toHaveLength(3)
    expect(result[0]?.frontmatter.updated).toBe('2024-01-03T00:00:00Z')
    expect(result[1]?.frontmatter.updated).toBe('2024-01-02T00:00:00Z')
    expect(result[2]?.frontmatter.updated).toBe('2024-01-01T00:00:00Z')
  })

  it('returns an empty array when the nodes/ directory does not exist', async () => {
    const result = await listAllNodes('/omg')
    expect(result).toEqual([])
  })

  it('throws for non-ENOENT errors on the nodes/ directory (e.g. EACCES)', async () => {
    const accessError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    const readdirSpy = vi.spyOn(memfs.promises, 'readdir').mockRejectedValueOnce(accessError)

    await expect(listAllNodes('/omg')).rejects.toThrow('Failed to read nodes directory')

    readdirSpy.mockRestore()
  })

  it('skips invalid/null files and returns only valid nodes', async () => {
    vol.fromJSON({
      '/omg/nodes/identity/valid-node.md': makeNodeFile({ id: 'omg/valid-node' }),
      '/omg/nodes/identity/invalid-node.md': '---\nbroken: [yaml\n---\nbody',
    })

    const result = await listAllNodes('/omg')

    expect(result).toHaveLength(1)
    expect(result[0]?.frontmatter.id).toBe('omg/valid-node')
  })
})
