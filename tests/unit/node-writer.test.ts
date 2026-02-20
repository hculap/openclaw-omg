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
  writeObservationNode,
  writeReflectionNode,
  writeNowNode,
} from '../../src/graph/node-writer.js'
import { parseFrontmatter } from '../../src/utils/frontmatter.js'
import type {
  ObserverOperation,
  WriteContext,
  NodeFrontmatter,
  ReflectionNodeData,
} from '../../src/types.js'

const OMG_ROOT = '/test/omg'
const SESSION_KEY = 'session-abc123'

const context: WriteContext = {
  omgRoot: OMG_ROOT,
  sessionKey: SESSION_KEY,
}

function makeBaseFrontmatter(overrides: Partial<NodeFrontmatter> = {}): NodeFrontmatter {
  return {
    id: 'omg/fact/user-prefers-dark-mode',
    description: 'User prefers dark mode',
    type: 'fact',
    priority: 'medium',
    created: '2026-02-20T10:00:00Z',
    updated: '2026-02-20T10:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vol.reset()
})

// ─── writeObservationNode ────────────────────────────────────────────────────

describe('writeObservationNode', () => {
  describe('create operation', () => {
    it('writes a file at the correct path for a create operation', async () => {
      const operation: ObserverOperation = {
        kind: 'create',
        frontmatter: makeBaseFrontmatter(),
        body: 'The user expressed a preference for dark mode.',
      }

      const node = await writeObservationNode(operation, context)

      // File should be under nodes/{type}/
      expect(node.filePath).toMatch(new RegExp(`^${OMG_ROOT}/nodes/fact/`))
      expect(node.filePath).toMatch(/\.md$/)

      // File should exist in memfs
      const exists = memfs.existsSync(node.filePath)
      expect(exists).toBe(true)
    })

    it('file name follows {type}-{slug}-{YYYY-MM-DD}.md pattern', async () => {
      const operation: ObserverOperation = {
        kind: 'create',
        frontmatter: makeBaseFrontmatter({ description: 'User prefers dark mode' }),
        body: 'Body content.',
      }

      const node = await writeObservationNode(operation, context)
      const filename = node.filePath.split('/').pop()!

      // Should match fact-user-prefers-dark-mode-YYYY-MM-DD.md
      expect(filename).toMatch(/^fact-user-prefers-dark-mode-\d{4}-\d{2}-\d{2}\.md$/)
    })

    it('writes correct frontmatter and body content to file', async () => {
      const fm = makeBaseFrontmatter()
      const body = 'The user expressed a preference for dark mode.'
      const operation: ObserverOperation = {
        kind: 'create',
        frontmatter: fm,
        body,
      }

      const node = await writeObservationNode(operation, context)

      const raw = memfs.readFileSync(node.filePath, 'utf-8') as string
      const parsed = parseFrontmatter(raw)

      expect(parsed.frontmatter['id']).toBe(fm.id)
      expect(parsed.frontmatter['type']).toBe('fact')
      expect(parsed.frontmatter['description']).toBe(fm.description)
      expect(parsed.body).toBe(body)
    })

    it('returns a GraphNode with matching frontmatter and body', async () => {
      const fm = makeBaseFrontmatter()
      const body = 'Node body content.'
      const operation: ObserverOperation = {
        kind: 'create',
        frontmatter: fm,
        body,
      }

      const node = await writeObservationNode(operation, context)

      expect(node.frontmatter.id).toBe(fm.id)
      expect(node.frontmatter.type).toBe('fact')
      expect(node.body).toBe(body)
    })

    it('creates the directory if it does not exist', async () => {
      const operation: ObserverOperation = {
        kind: 'create',
        frontmatter: makeBaseFrontmatter({ type: 'decision', id: 'omg/decision/use-typescript' }),
        body: 'We decided to use TypeScript.',
      }

      // Directory should not exist yet
      expect(memfs.existsSync(`${OMG_ROOT}/nodes/decision`)).toBe(false)

      const node = await writeObservationNode(operation, context)

      expect(memfs.existsSync(`${OMG_ROOT}/nodes/decision`)).toBe(true)
      expect(memfs.existsSync(node.filePath)).toBe(true)
    })
  })

  describe('collision handling', () => {
    it('appends -2 suffix when file already exists', async () => {
      const fm = makeBaseFrontmatter({ description: 'User prefers dark mode' })
      const body = 'Body content.'
      const operation: ObserverOperation = {
        kind: 'create',
        frontmatter: fm,
        body,
      }

      // Write first file
      const node1 = await writeObservationNode(operation, context)
      const filename1 = node1.filePath.split('/').pop()!

      // Write second file with same description
      const node2 = await writeObservationNode(operation, context)
      const filename2 = node2.filePath.split('/').pop()!

      // First file should be without suffix
      expect(filename1).toMatch(/^fact-user-prefers-dark-mode-\d{4}-\d{2}-\d{2}\.md$/)
      // Second file should have -2 suffix
      expect(filename2).toMatch(/^fact-user-prefers-dark-mode-\d{4}-\d{2}-\d{2}-2\.md$/)

      // Both files should exist
      expect(memfs.existsSync(node1.filePath)).toBe(true)
      expect(memfs.existsSync(node2.filePath)).toBe(true)
    })

    it('appends -3 suffix when both base and -2 already exist', async () => {
      const fm = makeBaseFrontmatter({ description: 'User prefers dark mode' })
      const body = 'Body.'
      const operation: ObserverOperation = {
        kind: 'create',
        frontmatter: fm,
        body,
      }

      const node1 = await writeObservationNode(operation, context)
      const node2 = await writeObservationNode(operation, context)
      const node3 = await writeObservationNode(operation, context)

      const filename3 = node3.filePath.split('/').pop()!
      expect(filename3).toMatch(/^fact-user-prefers-dark-mode-\d{4}-\d{2}-\d{2}-3\.md$/)

      expect(memfs.existsSync(node1.filePath)).toBe(true)
      expect(memfs.existsSync(node2.filePath)).toBe(true)
      expect(memfs.existsSync(node3.filePath)).toBe(true)
    })
  })

  describe('update operation', () => {
    it('writes a new file for an update operation', async () => {
      const operation: ObserverOperation = {
        kind: 'update',
        targetId: 'omg/fact/old-node',
        frontmatter: makeBaseFrontmatter({
          description: 'Updated preference note',
          type: 'preference',
          id: 'omg/preference/updated-preference-note',
        }),
        body: 'Updated body content.',
      }

      const node = await writeObservationNode(operation, context)

      expect(node.filePath).toMatch(new RegExp(`^${OMG_ROOT}/nodes/preference/`))
      expect(memfs.existsSync(node.filePath)).toBe(true)
      expect(node.body).toBe('Updated body content.')
    })
  })

  describe('supersede operation', () => {
    it('writes a new file for a supersede operation', async () => {
      const operation: ObserverOperation = {
        kind: 'supersede',
        targetId: 'omg/fact/old-fact',
        frontmatter: makeBaseFrontmatter({
          description: 'New superseding fact',
          id: 'omg/fact/new-superseding-fact',
        }),
        body: 'New superseding body.',
      }

      const node = await writeObservationNode(operation, context)

      expect(node.filePath).toMatch(new RegExp(`^${OMG_ROOT}/nodes/fact/`))
      expect(memfs.existsSync(node.filePath)).toBe(true)
    })
  })

  describe('atomic write', () => {
    it('leaves no temporary files after successful write', async () => {
      const operation: ObserverOperation = {
        kind: 'create',
        frontmatter: makeBaseFrontmatter(),
        body: 'Body content.',
      }

      await writeObservationNode(operation, context)

      const dir = `${OMG_ROOT}/nodes/fact`
      const files = memfs.readdirSync(dir) as string[]
      const tmpFiles = files.filter((f) => f.startsWith('.tmp-'))
      expect(tmpFiles).toHaveLength(0)
    })
  })
})

// ─── writeReflectionNode ─────────────────────────────────────────────────────

describe('writeReflectionNode', () => {
  it('writes to the reflections/ directory', async () => {
    const data: ReflectionNodeData = {
      frontmatter: makeBaseFrontmatter({
        type: 'reflection',
        id: 'omg/reflection/insight-about-preferences',
        description: 'Insight about preferences',
      }),
      body: 'This is a reflection on user preferences.',
      sourceNodeIds: ['omg/fact/node-1', 'omg/preference/node-2'],
    }

    const node = await writeReflectionNode(data, context)

    expect(node.filePath).toMatch(new RegExp(`^${OMG_ROOT}/reflections/`))
    expect(memfs.existsSync(node.filePath)).toBe(true)
  })

  it('file name follows {type}-{slug}-{YYYY-MM-DD}.md in reflections/', async () => {
    const data: ReflectionNodeData = {
      frontmatter: makeBaseFrontmatter({
        type: 'reflection',
        id: 'omg/reflection/insight-about-preferences',
        description: 'Insight about preferences',
      }),
      body: 'Reflection body.',
      sourceNodeIds: [],
    }

    const node = await writeReflectionNode(data, context)
    const filename = node.filePath.split('/').pop()!

    expect(filename).toMatch(/^reflection-insight-about-preferences-\d{4}-\d{2}-\d{2}\.md$/)
  })

  it('writes correct frontmatter and body', async () => {
    const fm = makeBaseFrontmatter({
      type: 'reflection',
      id: 'omg/reflection/insight-about-preferences',
      description: 'Insight about preferences',
    })
    const body = 'Reflection body content.'
    const data: ReflectionNodeData = {
      frontmatter: fm,
      body,
      sourceNodeIds: ['omg/fact/node-1'],
    }

    const node = await writeReflectionNode(data, context)

    const raw = memfs.readFileSync(node.filePath, 'utf-8') as string
    const parsed = parseFrontmatter(raw)

    expect(parsed.frontmatter['id']).toBe(fm.id)
    expect(parsed.frontmatter['type']).toBe('reflection')
    expect(parsed.body).toBe(body)
  })

  it('creates the reflections/ directory if not exists', async () => {
    expect(memfs.existsSync(`${OMG_ROOT}/reflections`)).toBe(false)

    const data: ReflectionNodeData = {
      frontmatter: makeBaseFrontmatter({
        type: 'reflection',
        id: 'omg/reflection/test',
        description: 'Test reflection',
      }),
      body: 'Body.',
      sourceNodeIds: [],
    }

    await writeReflectionNode(data, context)

    expect(memfs.existsSync(`${OMG_ROOT}/reflections`)).toBe(true)
  })

  it('leaves no temporary files after successful write', async () => {
    const data: ReflectionNodeData = {
      frontmatter: makeBaseFrontmatter({
        type: 'reflection',
        id: 'omg/reflection/test',
        description: 'Test reflection',
      }),
      body: 'Body.',
      sourceNodeIds: [],
    }

    await writeReflectionNode(data, context)

    const files = memfs.readdirSync(`${OMG_ROOT}/reflections`) as string[]
    const tmpFiles = files.filter((f) => f.startsWith('.tmp-'))
    expect(tmpFiles).toHaveLength(0)
  })
})

// ─── writeNowNode ─────────────────────────────────────────────────────────────

describe('writeNowNode', () => {
  it('writes to {omgRoot}/now.md', async () => {
    const node = await writeNowNode('Current state update.', [], context)

    expect(node.filePath).toBe(`${OMG_ROOT}/now.md`)
    expect(memfs.existsSync(`${OMG_ROOT}/now.md`)).toBe(true)
  })

  it('creates frontmatter with type=now, id=omg/now, priority=high', async () => {
    const nowUpdate = 'Working on phase 2 implementation.'
    const node = await writeNowNode(nowUpdate, [], context)

    const raw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const parsed = parseFrontmatter(raw)

    expect(parsed.frontmatter['type']).toBe('now')
    expect(parsed.frontmatter['id']).toBe('omg/now')
    expect(parsed.frontmatter['priority']).toBe('high')
  })

  it('writes the nowUpdate string as the body', async () => {
    const nowUpdate = 'Current focus: implementing node-writer.'
    const node = await writeNowNode(nowUpdate, [], context)

    const raw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const parsed = parseFrontmatter(raw)

    expect(parsed.body).toBe(nowUpdate)
  })

  it('sets created and updated timestamps in frontmatter', async () => {
    const node = await writeNowNode('Update content.', [], context)

    const raw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const parsed = parseFrontmatter(raw)

    expect(typeof parsed.frontmatter['created']).toBe('string')
    expect(typeof parsed.frontmatter['updated']).toBe('string')
    expect((parsed.frontmatter['created'] as string).length).toBeGreaterThan(0)
  })

  it('overwrites existing now.md on second write', async () => {
    await writeNowNode('First update.', [], context)
    await writeNowNode('Second update.', [], context)

    const raw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const parsed = parseFrontmatter(raw)

    expect(parsed.body).toBe('Second update.')
  })

  it('returns a GraphNode with correct filePath and frontmatter', async () => {
    const node = await writeNowNode('Now update body.', ['omg/fact/node-1'], context)

    expect(node.filePath).toBe(`${OMG_ROOT}/now.md`)
    expect(node.frontmatter.type).toBe('now')
    expect(node.frontmatter.id).toBe('omg/now')
    expect(node.body).toBe('Now update body.')
  })

  it('leaves no temporary files after successful write', async () => {
    await writeNowNode('Update content.', [], context)

    // now.md should exist, but no .tmp- files at root
    const files = memfs.readdirSync(OMG_ROOT) as string[]
    const tmpFiles = files.filter((f) => f.startsWith('.tmp-'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('creates omgRoot directory if it does not exist', async () => {
    const freshContext: WriteContext = {
      omgRoot: '/fresh/omg',
      sessionKey: 'test',
    }

    const node = await writeNowNode('Fresh update.', [], freshContext)

    expect(memfs.existsSync('/fresh/omg/now.md')).toBe(true)
    expect(node.filePath).toBe('/fresh/omg/now.md')
  })
})
