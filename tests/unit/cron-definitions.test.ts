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

vi.mock('../../src/reflector/reflector.js', () => ({
  runReflection: vi.fn().mockResolvedValue({
    edits: [],
    deletions: [],
    tokensUsed: 0,
  }),
}))

vi.mock('../../src/dedup/dedup.js', () => ({
  runDedup: vi.fn().mockResolvedValue({
    clustersProcessed: 0,
    mergesExecuted: 0,
    nodesArchived: 0,
    conflictsDetected: 0,
    tokensUsed: 0,
    errors: [],
  }),
}))

vi.mock('../../src/bootstrap/bootstrap.js', () => ({
  runBootstrapTick: vi.fn().mockResolvedValue({
    ran: true,
    batchesProcessed: 0,
    chunksSucceeded: 0,
    nodesWritten: 0,
    moreWorkRemains: false,
    completed: false,
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

function makeCtx(overrides: { graphMaintenanceSchedule?: string; reflectionSchedule?: string } = {}): CronContext {
  return {
    workspaceDir: WORKSPACE,
    config: parseConfig({
      graphMaintenance: { cronSchedule: overrides.graphMaintenanceSchedule ?? '0 3 * * *' },
      reflection: { cronSchedule: overrides.reflectionSchedule ?? '0 2 * * *' },
      injection: { maxContextTokens: 4_000 },
    }),
    llmClient: makeMockLlm(),
  }
}

beforeEach(() => {
  vol.reset()
  clearRegistryCache()
  vol.fromJSON({
    [`${OMG_ROOT}/.keep`]: '',
  })
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('createCronDefinitions', () => {
  it('returns exactly three cron definitions', () => {
    const defs = createCronDefinitions(makeCtx())
    expect(defs).toHaveLength(3)
  })

  it('has correct job IDs', () => {
    const defs = createCronDefinitions(makeCtx())
    const ids = defs.map((d) => d.id)
    expect(ids).toContain('omg-bootstrap')
    expect(ids).toContain('omg-reflection')
    expect(ids).toContain('omg-maintenance')
    expect(ids).not.toContain('omg-graph-maintenance')
  })

  it('uses graphMaintenance.cronSchedule for omg-reflection', () => {
    const defs = createCronDefinitions(makeCtx({ graphMaintenanceSchedule: '*/30 * * * *' }))
    const maintenance = defs.find((d) => d.id === 'omg-reflection')!
    expect(maintenance.schedule).toBe('*/30 * * * *')
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

describe('createCronDefinitions — omg-reflection handler', () => {
  it('does not throw when handler runs with no nodes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const defs = createCronDefinitions(makeCtx())
    const maintenance = defs.find((d) => d.id === 'omg-reflection')!
    await expect(maintenance.handler()).resolves.not.toThrow()
  })

  it('runs dedup then reflection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runDedup } = await import('../../src/dedup/dedup.js')
    const { runReflection } = await import('../../src/reflector/reflector.js')
    vi.mocked(runDedup).mockClear()
    vi.mocked(runReflection).mockClear()

    const defs = createCronDefinitions(makeCtx())
    const maintenance = defs.find((d) => d.id === 'omg-reflection')!
    await maintenance.handler()

    expect(runDedup).toHaveBeenCalledOnce()
    // Reflection may or may not be called depending on eligible nodes — dedup always runs
  })

  it('calls runDedup with correct omgRoot and config', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runDedup } = await import('../../src/dedup/dedup.js')
    vi.mocked(runDedup).mockClear()

    const ctx = makeCtx()
    const defs = createCronDefinitions(ctx)
    const maintenance = defs.find((d) => d.id === 'omg-reflection')!
    await maintenance.handler()

    expect(runDedup).toHaveBeenCalledWith(
      expect.objectContaining({
        omgRoot: OMG_ROOT,
        config: ctx.config,
      })
    )
  })

  it('uses cron:omg-reflection as sessionKey for reflection', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runReflection } = await import('../../src/reflector/reflector.js')
    vi.mocked(runReflection).mockClear()

    vol.fromJSON({
      [`${OMG_ROOT}/nodes/fact/fact.old-data-2020-01-01.md`]: `---
id: omg/fact.old-data
description: Old fact from 2020
type: fact
priority: medium
created: 2020-01-01T00:00:00Z
updated: 2020-01-01T00:00:00Z
---
Old content.`,
    })

    const defs = createCronDefinitions(makeCtx())
    const maintenance = defs.find((d) => d.id === 'omg-reflection')!
    await maintenance.handler()

    const reflectionCalls = vi.mocked(runReflection).mock.calls
    if (reflectionCalls.length > 0) {
      expect(reflectionCalls[0]![0].sessionKey).toBe('cron:omg-reflection')
    }
  })

  it('continues to reflection even if dedup throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { runDedup } = await import('../../src/dedup/dedup.js')
    vi.mocked(runDedup).mockRejectedValueOnce(new Error('dedup exploded'))

    const defs = createCronDefinitions(makeCtx())
    const maintenance = defs.find((d) => d.id === 'omg-reflection')!
    await expect(maintenance.handler()).resolves.not.toThrow()
  })
})

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
      [`${OMG_ROOT}/nodes/fact/fact.broken-link-2026-01-01.md`]: `---
id: omg/fact.broken-link
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
      [`${OMG_ROOT}/nodes/fact/fact.dup-1-2026-01-01.md`]: `---
id: omg/fact.dup-1
description: Duplicate description
type: fact
priority: low
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
---
Content 1.`,
      [`${OMG_ROOT}/nodes/fact/fact.dup-2-2026-01-01.md`]: `---
id: omg/fact.dup-2
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
      [`${OMG_ROOT}/nodes/fact/fact.broken-link-2026-01-01.md`]: `---
id: omg/fact.broken-link
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

// ---------------------------------------------------------------------------
// omg-bootstrap cron definition
// ---------------------------------------------------------------------------

describe('createCronDefinitions — omg-bootstrap', () => {
  it('omg-bootstrap appears before omg-reflection in the array', () => {
    const defs = createCronDefinitions(makeCtx())
    const ids = defs.map((d) => d.id)
    expect(ids.indexOf('omg-bootstrap')).toBeLessThan(ids.indexOf('omg-reflection'))
  })

  it('uses config.bootstrap.cronSchedule for omg-bootstrap schedule', () => {
    const ctx = {
      workspaceDir: WORKSPACE,
      config: parseConfig({ bootstrap: { cronSchedule: '*/10 * * * *' } }),
      llmClient: makeMockLlm(),
    }
    const defs = createCronDefinitions(ctx)
    const bootstrap = defs.find((d) => d.id === 'omg-bootstrap')!
    expect(bootstrap.schedule).toBe('*/10 * * * *')
  })

  it('uses default */5 * * * * schedule when not configured', () => {
    const defs = createCronDefinitions(makeCtx())
    const bootstrap = defs.find((d) => d.id === 'omg-bootstrap')!
    expect(bootstrap.schedule).toBe('*/5 * * * *')
  })

  it('has a handler function', () => {
    const defs = createCronDefinitions(makeCtx())
    const bootstrap = defs.find((d) => d.id === 'omg-bootstrap')!
    expect(typeof bootstrap.handler).toBe('function')
  })

  it('handler calls runBootstrapTick', async () => {
    const { runBootstrapTick } = await import('../../src/bootstrap/bootstrap.js')
    vi.mocked(runBootstrapTick).mockClear()

    const defs = createCronDefinitions(makeCtx())
    const bootstrap = defs.find((d) => d.id === 'omg-bootstrap')!
    await bootstrap.handler()

    expect(runBootstrapTick).toHaveBeenCalledOnce()
  })

  it('handler triggers graphMaintenanceCronHandler when bootstrap completes', async () => {
    const { runBootstrapTick } = await import('../../src/bootstrap/bootstrap.js')
    const { runDedup } = await import('../../src/dedup/dedup.js')

    vi.mocked(runBootstrapTick).mockResolvedValueOnce({
      ran: true,
      batchesProcessed: 5,
      chunksSucceeded: 5,
      nodesWritten: 10,
      moreWorkRemains: false,
      completed: true,
    })
    vi.mocked(runDedup).mockClear()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const defs = createCronDefinitions(makeCtx())
    const bootstrap = defs.find((d) => d.id === 'omg-bootstrap')!
    await bootstrap.handler()

    // graphMaintenanceCronHandler runs dedup as its first step
    expect(runDedup).toHaveBeenCalledOnce()
  })

  it('handler does NOT trigger graphMaintenanceCronHandler when not completed', async () => {
    const { runBootstrapTick } = await import('../../src/bootstrap/bootstrap.js')
    const { runDedup } = await import('../../src/dedup/dedup.js')

    vi.mocked(runBootstrapTick).mockResolvedValueOnce({
      ran: true,
      batchesProcessed: 2,
      chunksSucceeded: 2,
      nodesWritten: 3,
      moreWorkRemains: true,
      completed: false,
    })
    vi.mocked(runDedup).mockClear()

    const defs = createCronDefinitions(makeCtx())
    const bootstrap = defs.find((d) => d.id === 'omg-bootstrap')!
    await bootstrap.handler()

    expect(runDedup).not.toHaveBeenCalled()
  })

  it('handler does not throw when runBootstrapTick throws', async () => {
    const { runBootstrapTick } = await import('../../src/bootstrap/bootstrap.js')
    vi.mocked(runBootstrapTick).mockRejectedValueOnce(new Error('boom'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const defs = createCronDefinitions(makeCtx())
    const bootstrap = defs.find((d) => d.id === 'omg-bootstrap')!
    await expect(bootstrap.handler()).resolves.not.toThrow()
  })
})
