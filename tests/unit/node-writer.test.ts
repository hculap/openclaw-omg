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
const SCOPE = '/workspace/proj'

const context: WriteContext = {
  omgRoot: OMG_ROOT,
  sessionKey: SESSION_KEY,
  scope: SCOPE,
}

function makeUpsertOperation(overrides: Partial<{
  canonicalKey: string
  type: ObserverOperation extends { kind: 'upsert' } ? ObserverOperation['type'] : never
  title: string
  description: string
  body: string
  priority: 'high' | 'medium' | 'low'
  mocHints: string[]
  tags: string[]
  linkKeys: string[]
}> = {}): ObserverOperation {
  return {
    kind: 'upsert',
    canonicalKey: 'preferences.editor_theme',
    type: 'preference',
    title: 'Editor Theme Preference',
    description: 'User prefers dark mode in all editors',
    body: 'The user explicitly stated they prefer dark mode.',
    priority: 'high',
    ...overrides,
  } as ObserverOperation
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

// ─── writeObservationNode — upsert ────────────────────────────────────────────

describe('writeObservationNode — upsert (deterministic paths)', () => {
  it('writes to a deterministic path nodes/{type}/{slug}.md', async () => {
    const node = await writeObservationNode(makeUpsertOperation(), context)

    expect(node.filePath).toBe(`${OMG_ROOT}/nodes/preference/preferences-editor-theme.md`)
    expect(memfs.existsSync(node.filePath)).toBe(true)
  })

  it('same canonicalKey always produces same file path (idempotent)', async () => {
    const op = makeUpsertOperation()
    const node1 = await writeObservationNode(op, context)

    // Re-write same key
    const node2 = await writeObservationNode(op, context)

    expect(node1.filePath).toBe(node2.filePath)
    // Only one file should exist (not two)
    const dir = `${OMG_ROOT}/nodes/preference`
    const files = memfs.readdirSync(dir) as string[]
    expect(files).toHaveLength(1)
  })

  it('preserves original created timestamp on second write (merge behavior)', async () => {
    const op = makeUpsertOperation()
    const node1 = await writeObservationNode(op, context)
    const raw1 = memfs.readFileSync(node1.filePath, 'utf-8') as string
    const fm1 = parseFrontmatter(raw1)
    const originalCreated = fm1.frontmatter['created'] as string

    // Write again (merge/update)
    const op2 = makeUpsertOperation({ body: 'Updated body content.' })
    const node2 = await writeObservationNode(op2, context)
    const raw2 = memfs.readFileSync(node2.filePath, 'utf-8') as string
    const fm2 = parseFrontmatter(raw2)

    expect(fm2.frontmatter['created']).toBe(originalCreated)
    expect(fm2.body).toBe('Updated body content.')
  })

  it('writes uid to frontmatter (12-char hex)', async () => {
    const node = await writeObservationNode(makeUpsertOperation(), context)
    const raw = memfs.readFileSync(node.filePath, 'utf-8') as string
    const fm = parseFrontmatter(raw)

    expect(typeof fm.frontmatter['uid']).toBe('string')
    expect((fm.frontmatter['uid'] as string).length).toBe(12)
    expect(fm.frontmatter['uid']).toMatch(/^[a-f0-9]{12}$/)
  })

  it('writes canonicalKey to frontmatter', async () => {
    const node = await writeObservationNode(makeUpsertOperation({ canonicalKey: 'preferences.editor_theme' }), context)
    const raw = memfs.readFileSync(node.filePath, 'utf-8') as string
    const fm = parseFrontmatter(raw)

    expect(fm.frontmatter['canonicalKey']).toBe('preferences.editor_theme')
  })

  it('writes id in omg/{type}/{slug} format', async () => {
    const node = await writeObservationNode(makeUpsertOperation(), context)
    const raw = memfs.readFileSync(node.filePath, 'utf-8') as string
    const fm = parseFrontmatter(raw)

    expect(fm.frontmatter['id']).toBe('omg/preference/preferences-editor-theme')
  })

  it('uid is deterministic — same scope+type+canonicalKey always produce same uid', async () => {
    const op = makeUpsertOperation()
    const node1 = await writeObservationNode(op, context)
    const raw1 = memfs.readFileSync(node1.filePath, 'utf-8') as string
    const fm1 = parseFrontmatter(raw1)
    const uid1 = fm1.frontmatter['uid']

    // Second write (merge)
    const node2 = await writeObservationNode(op, context)
    const raw2 = memfs.readFileSync(node2.filePath, 'utf-8') as string
    const fm2 = parseFrontmatter(raw2)
    const uid2 = fm2.frontmatter['uid']

    expect(uid1).toBe(uid2)
  })

  it('creates the directory if it does not exist', async () => {
    expect(memfs.existsSync(`${OMG_ROOT}/nodes/decision`)).toBe(false)

    await writeObservationNode(makeUpsertOperation({ canonicalKey: 'decisions.use_typescript', type: 'decision' as never }), context)

    expect(memfs.existsSync(`${OMG_ROOT}/nodes/decision`)).toBe(true)
  })

  it('writes moc links from mocHints when present', async () => {
    const op = makeUpsertOperation({ mocHints: ['preferences', 'tools'] })
    const node = await writeObservationNode(op, context)
    const raw = memfs.readFileSync(node.filePath, 'utf-8') as string
    const fm = parseFrontmatter(raw)

    const links = fm.frontmatter['links'] as string[]
    expect(links).toContain('omg/moc-preferences')
    expect(links).toContain('omg/moc-tools')
  })

  it('writes tags to frontmatter when present', async () => {
    const op = makeUpsertOperation({ tags: ['editor', 'appearance'] })
    const node = await writeObservationNode(op, context)
    const raw = memfs.readFileSync(node.filePath, 'utf-8') as string
    const fm = parseFrontmatter(raw)

    expect(fm.frontmatter['tags']).toEqual(['editor', 'appearance'])
  })

  it('leaves no temporary files after successful write', async () => {
    await writeObservationNode(makeUpsertOperation(), context)

    const dir = `${OMG_ROOT}/nodes/preference`
    const files = memfs.readdirSync(dir) as string[]
    const tmpFiles = files.filter((f) => f.startsWith('.tmp-'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('returns a GraphNode with matching data', async () => {
    const op = makeUpsertOperation()
    const node = await writeObservationNode(op, context)

    expect(node.frontmatter.type).toBe('preference')
    expect(node.frontmatter.canonicalKey).toBe('preferences.editor_theme')
    expect(node.body).toBe('The user explicitly stated they prefer dark mode.')
    expect(node.filePath).toBe(`${OMG_ROOT}/nodes/preference/preferences-editor-theme.md`)
  })

  it('different canonicalKeys write to different files', async () => {
    const op1 = makeUpsertOperation({ canonicalKey: 'preferences.editor_theme' })
    const op2 = makeUpsertOperation({ canonicalKey: 'preferences.font_size' })

    const node1 = await writeObservationNode(op1, context)
    const node2 = await writeObservationNode(op2, context)

    expect(node1.filePath).not.toBe(node2.filePath)
    expect(memfs.existsSync(node1.filePath)).toBe(true)
    expect(memfs.existsSync(node2.filePath)).toBe(true)
  })

  it('uses omgRoot as scope fallback when context.scope is undefined', async () => {
    const ctxNoScope: WriteContext = { omgRoot: OMG_ROOT, sessionKey: SESSION_KEY }
    const node = await writeObservationNode(makeUpsertOperation(), ctxNoScope)

    // Should still write to deterministic path
    expect(node.filePath).toBe(`${OMG_ROOT}/nodes/preference/preferences-editor-theme.md`)
    // uid should be computed with omgRoot as scope
    const raw = memfs.readFileSync(node.filePath, 'utf-8') as string
    const fm = parseFrontmatter(raw)
    expect(fm.frontmatter['uid']).toMatch(/^[a-f0-9]{12}$/)
  })
})

// ─── writeObservationNode — atomic write ─────────────────────────────────────

describe('writeObservationNode — atomic write', () => {
  it('rejects with an error message when the underlying write fails', async () => {
    const writeError = Object.assign(new Error('ENOSPC: no space left on device'), {
      code: 'ENOSPC',
    })
    const writeSpy = vi.spyOn(memfs.promises, 'writeFile').mockRejectedValueOnce(writeError)

    await expect(writeObservationNode(makeUpsertOperation(), context)).rejects.toThrow('Atomic write failed')

    writeSpy.mockRestore()
  })

  it('rejects with a directory creation error message when mkdir fails', async () => {
    const mkdirError = Object.assign(new Error('EPERM: operation not permitted'), {
      code: 'EPERM',
    })
    const mkdirSpy = vi.spyOn(memfs.promises, 'mkdir').mockRejectedValueOnce(mkdirError)

    await expect(writeObservationNode(makeUpsertOperation(), context)).rejects.toThrow(
      'Failed to create directory'
    )

    mkdirSpy.mockRestore()
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
    await writeNowNode(nowUpdate, [], context)

    const raw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const parsed = parseFrontmatter(raw)

    expect(parsed.frontmatter['type']).toBe('now')
    expect(parsed.frontmatter['id']).toBe('omg/now')
    expect(parsed.frontmatter['priority']).toBe('high')
  })

  it('writes the nowUpdate string as the body', async () => {
    const nowUpdate = 'Current focus: implementing node-writer.'
    await writeNowNode(nowUpdate, [], context)

    const raw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const parsed = parseFrontmatter(raw)

    expect(parsed.body).toBe(nowUpdate)
  })

  it('sets created and updated to the same ISO 8601 instant on first write', async () => {
    await writeNowNode('Update content.', [], context)

    const raw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const parsed = parseFrontmatter(raw)

    const created = parsed.frontmatter['created'] as string
    const updated = parsed.frontmatter['updated'] as string

    expect(created).toBe(updated)
    expect(new Date(created).toISOString()).toBe(created)
  })

  it('preserves the original created timestamp on subsequent writes', async () => {
    await writeNowNode('First update.', [], context)
    const firstRaw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const firstParsed = parseFrontmatter(firstRaw)
    const originalCreated = firstParsed.frontmatter['created'] as string

    await writeNowNode('Second update.', [], context)
    const secondRaw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const secondParsed = parseFrontmatter(secondRaw)

    expect(secondParsed.frontmatter['created']).toBe(originalCreated)
    expect(secondParsed.body).toBe('Second update.')
  })

  it('includes links field in written file when recentNodeIds is non-empty', async () => {
    await writeNowNode('Update.', ['omg/fact/node-1', 'omg/fact/node-2'], context)

    const raw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const parsed = parseFrontmatter(raw)

    expect(parsed.frontmatter['links']).toEqual(['omg/fact/node-1', 'omg/fact/node-2'])
  })

  it('omits links field in written file when recentNodeIds is empty', async () => {
    await writeNowNode('Update.', [], context)

    const raw = memfs.readFileSync(`${OMG_ROOT}/now.md`, 'utf-8') as string
    const parsed = parseFrontmatter(raw)

    expect(parsed.frontmatter['links']).toBeUndefined()
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
