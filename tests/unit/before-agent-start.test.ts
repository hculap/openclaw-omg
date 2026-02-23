import { describe, it, expect, beforeEach, vi } from 'vitest'
import { vol } from 'memfs'
import { parseConfig } from '../../src/config.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

const { beforeAgentStart } = await import('../../src/hooks/before-agent-start.js')
const { clearRegistryCache } = await import('../../src/graph/registry.js')

const WORKSPACE = '/workspace'
const SESSION_KEY = 'test-session'
const OMG_ROOT = `${WORKSPACE}/memory/omg`

const INDEX_MD = '---\ntype: index\nid: omg/index\npriority: high\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n# Memory Index\n- [[omg/moc-projects]]\n'
const NOW_MD = '---\ntype: now\nid: omg/now\npriority: high\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n# Now\nWorking on something.\n'

beforeEach(() => {
  vol.reset()
  clearRegistryCache()
})

// ---------------------------------------------------------------------------
// beforeAgentStart — happy paths
// ---------------------------------------------------------------------------

describe('beforeAgentStart — graph present', () => {
  it('returns an object with prependContext string', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/index.md`]: INDEX_MD,
      [`${OMG_ROOT}/now.md`]: NOW_MD,
    })

    const config = parseConfig({})
    const result = await beforeAgentStart(
      { prompt: 'Help me with TypeScript.' },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, config }
    )

    expect(result).toBeDefined()
    expect(typeof result?.prependContext).toBe('string')
    expect(result?.prependContext.length).toBeGreaterThan(0)
  })

  it('prependContext contains <omg-context> wrapper', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/index.md`]: INDEX_MD,
      [`${OMG_ROOT}/now.md`]: NOW_MD,
    })

    const config = parseConfig({})
    const result = await beforeAgentStart(
      { prompt: 'Hello.' },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, config }
    )

    expect(result?.prependContext).toContain('<omg-context>')
    expect(result?.prependContext).toContain('</omg-context>')
  })

  it('prependContext includes index content', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/index.md`]: INDEX_MD,
    })

    const config = parseConfig({})
    const result = await beforeAgentStart(
      { prompt: 'Hello.' },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, config }
    )

    expect(result?.prependContext).toContain('Memory Index')
  })

  it('includes now node content when now.md exists', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/index.md`]: INDEX_MD,
      [`${OMG_ROOT}/now.md`]: NOW_MD,
    })

    const config = parseConfig({})
    const result = await beforeAgentStart(
      { prompt: 'Hello.' },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, config }
    )

    expect(result?.prependContext).toContain('Working on something.')
  })
})

// ---------------------------------------------------------------------------
// beforeAgentStart — empty graph
// ---------------------------------------------------------------------------

describe('beforeAgentStart — empty graph', () => {
  it('returns undefined when graph directory does not exist', async () => {
    const config = parseConfig({})
    const result = await beforeAgentStart(
      { prompt: 'Hello.' },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, config }
    )

    // No index.md and no nodes → nothing to inject
    expect(result).toBeUndefined()
  })

  it('never throws when graph is completely empty', async () => {
    const config = parseConfig({})
    await expect(
      beforeAgentStart(
        { prompt: 'Hello.' },
        { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, config }
      )
    ).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// beforeAgentStart — memoryTools passthrough
// ---------------------------------------------------------------------------

describe('beforeAgentStart — memoryTools passthrough', () => {
  it('accepts memoryTools: null in context without crashing', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/index.md`]: INDEX_MD,
      [`${OMG_ROOT}/now.md`]: NOW_MD,
    })

    const config = parseConfig({})
    const result = await beforeAgentStart(
      { prompt: 'Hello.' },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, config, memoryTools: null }
    )

    expect(result).toBeDefined()
    expect(result?.prependContext).toContain('<omg-context>')
  })

  it('accepts memoryTools with mock search that returns null without crashing', async () => {
    vol.fromJSON({
      [`${OMG_ROOT}/index.md`]: INDEX_MD,
      [`${OMG_ROOT}/now.md`]: NOW_MD,
    })

    const config = parseConfig({})
    const mockMemoryTools = {
      search: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
    }

    const result = await beforeAgentStart(
      { prompt: 'Hello.' },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, config, memoryTools: mockMemoryTools }
    )

    expect(result).toBeDefined()
    expect(result?.prependContext).toContain('<omg-context>')
  })
})

// ---------------------------------------------------------------------------
// beforeAgentStart — knowledge nodes included
// ---------------------------------------------------------------------------

describe('beforeAgentStart — with nodes', () => {
  it('includes relevant nodes in prependContext', async () => {
    const nodeMd = `---
id: omg/typescript-types
description: TypeScript type system overview
type: fact
priority: high
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
---
TypeScript adds static types to JavaScript for better tooling.
`
    vol.fromJSON({
      [`${OMG_ROOT}/index.md`]: INDEX_MD,
      [`${OMG_ROOT}/nodes/fact/fact-typescript-2026-01-01.md`]: nodeMd,
    })

    const config = parseConfig({})
    const result = await beforeAgentStart(
      { prompt: 'Tell me about TypeScript types.' },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, config }
    )

    expect(result?.prependContext).toContain('TypeScript')
  })
})
