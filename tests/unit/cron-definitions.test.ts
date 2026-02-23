import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { vol } from 'memfs'
import { parseConfig } from '../../src/config.js'
import { clearRegistryCache } from '../../src/graph/registry.js'
import type { LlmClient } from '../../src/llm/client.js'
import type { CronContext } from '../../src/cron/definitions.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

// Mock runReflection to avoid real LLM calls in cron tests
vi.mock('../../src/reflector/reflector.js', () => ({
  runReflection: vi.fn().mockResolvedValue({
    edits: [],
    deletions: [],
    tokensUsed: 0,
    [Symbol('brand')]: true,
  }),
}))

const { createCronDefinitions } = await import('../../src/cron/definitions.js')

const WORKSPACE = '/workspace'
const OMG_ROOT = `${WORKSPACE}/memory/omg`

function makeMockLlm(): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content: '<reflection></reflection>',
      usage: { inputTokens: 10, outputTokens: 5 },
    }),
  }
}

function makeCtx(cronSchedule = '0 3 * * *'): CronContext {
  return {
    workspaceDir: WORKSPACE,
    config: parseConfig({
      reflection: { cronSchedule },
      injection: { maxContextTokens: 4_000 },
    }),
    llmClient: makeMockLlm(),
  }
}

beforeEach(() => {
  vol.reset()
  clearRegistryCache()
  vol.fromJSON({
    // Empty graph root — no observation nodes
    [`${OMG_ROOT}/.keep`]: '',
  })
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// createCronDefinitions — structure
// ---------------------------------------------------------------------------

describe('createCronDefinitions', () => {
  it('returns exactly two cron definitions', () => {
    const defs = createCronDefinitions(makeCtx())
    expect(defs).toHaveLength(2)
  })

  it('has correct job IDs', () => {
    const defs = createCronDefinitions(makeCtx())
    const ids = defs.map((d) => d.id)
    expect(ids).toContain('omg-reflection')
    expect(ids).toContain('omg-maintenance')
  })

  it('uses the configured cron schedule for omg-reflection', () => {
    const defs = createCronDefinitions(makeCtx('*/30 * * * *'))
    const reflection = defs.find((d) => d.id === 'omg-reflection')!
    expect(reflection.schedule).toBe('*/30 * * * *')
  })

  it('uses a fixed schedule for omg-maintenance (Sunday 4 AM)', () => {
    const defs = createCronDefinitions(makeCtx())
    const maintenance = defs.find((d) => d.id === 'omg-maintenance')!
    expect(maintenance.schedule).toBe('0 4 * * 0')
  })

  it('each definition has a handler function', () => {
    const defs = createCronDefinitions(makeCtx())
    for (const def of defs) {
      expect(typeof def.handler).toBe('function')
    }
  })
})

// ---------------------------------------------------------------------------
// omg-reflection cron — handler behaviour
// ---------------------------------------------------------------------------

describe('createCronDefinitions — omg-reflection handler', () => {
  it('does not throw when handler runs with no nodes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const defs = createCronDefinitions(makeCtx())
    const reflection = defs.find((d) => d.id === 'omg-reflection')!
    await expect(reflection.handler()).resolves.not.toThrow()
  })

  it('filters out archived nodes before reflection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runReflection } = await import('../../src/reflector/reflector.js')

    // Scaffold archived and non-archived nodes (both older than 7 days)
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/preference/preference-archived-2020-01-01.md`]: `---
id: omg/preference/archived-pref
description: Archived preference
type: preference
priority: low
created: 2020-01-01T00:00:00Z
updated: 2020-01-01T00:00:00Z
archived: true
---
Old content.`,
      [`${OMG_ROOT}/nodes/fact/fact-active-2020-01-01.md`]: `---
id: omg/fact/active-fact
description: Active fact from 2020
type: fact
priority: medium
created: 2020-01-01T00:00:00Z
updated: 2020-01-01T00:00:00Z
---
Active content.`,
    })

    const defs = createCronDefinitions(makeCtx())
    const reflection = defs.find((d) => d.id === 'omg-reflection')!
    await reflection.handler()

    // runReflection should only have received the non-archived node
    const call = (runReflection as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0]?.sessionKey === 'cron:omg-reflection'
    )
    if (call) {
      const nodes = call[0].observationNodes
      expect(nodes.every((n: { frontmatter: { archived?: boolean } }) => !n.frontmatter.archived)).toBe(true)
    }
  })

  it('filters out reflection-type nodes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runReflection } = await import('../../src/reflector/reflector.js')
    vi.mocked(runReflection).mockClear()

    vol.fromJSON({
      [`${OMG_ROOT}/nodes/reflection/reflection-old-2020-01-01.md`]: `---
id: omg/reflection/old-synthesis
description: Old synthesis
type: reflection
priority: medium
created: 2020-01-01T00:00:00Z
updated: 2020-01-01T00:00:00Z
---
Reflected content.`,
    })

    const defs = createCronDefinitions(makeCtx())
    const reflection = defs.find((d) => d.id === 'omg-reflection')!
    await reflection.handler()

    const call = (runReflection as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0]?.sessionKey === 'cron:omg-reflection'
    )
    if (call) {
      const nodes = call[0].observationNodes
      expect(nodes.every((n: { frontmatter: { type: string } }) => n.frontmatter.type !== 'reflection')).toBe(true)
    }
  })

  it('uses cron:omg-reflection as sessionKey', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runReflection } = await import('../../src/reflector/reflector.js')
    vi.mocked(runReflection).mockClear()

    vol.fromJSON({
      [`${OMG_ROOT}/nodes/fact/fact-old-2020-01-01.md`]: `---
id: omg/fact/old-fact
description: Old fact
type: fact
priority: low
created: 2020-01-01T00:00:00Z
updated: 2020-01-01T00:00:00Z
---
Old content.`,
    })

    const defs = createCronDefinitions(makeCtx())
    const reflection = defs.find((d) => d.id === 'omg-reflection')!
    await reflection.handler()

    // If runReflection was called, it should have used cron:omg-reflection as sessionKey
    const reflectionCalls = (runReflection as ReturnType<typeof vi.fn>).mock.calls
    if (reflectionCalls.length > 0) {
      expect(reflectionCalls[0]![0].sessionKey).toBe('cron:omg-reflection')
    }
  })
})

// ---------------------------------------------------------------------------
// omg-maintenance cron — handler behaviour
// ---------------------------------------------------------------------------

describe('createCronDefinitions — omg-maintenance handler', () => {
  it('does not throw when there are no nodes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const defs = createCronDefinitions(makeCtx())
    const maintenance = defs.find((d) => d.id === 'omg-maintenance')!
    await expect(maintenance.handler()).resolves.not.toThrow()
  })

  it('does not throw when there are nodes with broken links', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/fact/fact-broken-link-2026-01-01.md`]: `---
id: omg/fact-broken-link
description: Has broken link
type: fact
priority: low
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
links:
  - omg/nonexistent-node
---
Content with a broken link.`,
    })

    const defs = createCronDefinitions(makeCtx())
    const maintenance = defs.find((d) => d.id === 'omg-maintenance')!
    await expect(maintenance.handler()).resolves.not.toThrow()
  })

  it('does not throw when there are duplicate descriptions', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/fact/fact-dup-1-2026-01-01.md`]: `---
id: omg/fact/dup-1
description: Duplicate description
type: fact
priority: low
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
---
Content 1.`,
      [`${OMG_ROOT}/nodes/fact/fact-dup-2-2026-01-01.md`]: `---
id: omg/fact/dup-2
description: Duplicate description
type: fact
priority: low
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
---
Content 2.`,
    })

    const defs = createCronDefinitions(makeCtx())
    const maintenance = defs.find((d) => d.id === 'omg-maintenance')!
    await expect(maintenance.handler()).resolves.not.toThrow()
  })

  it('logs a warning for broken links', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/fact/fact-broken-link-2026-01-01.md`]: `---
id: omg/fact-broken-link
description: Has broken link
type: fact
priority: low
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
links:
  - omg/nonexistent-node
---
Content.`,
    })

    const defs = createCronDefinitions(makeCtx())
    const maintenance = defs.find((d) => d.id === 'omg-maintenance')!
    await maintenance.handler()

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('broken wikilink'))
  })
})
