import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ConfigValidationError } from '../../src/config.js'
import type { PluginApi } from '../../src/plugin.js'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const scaffoldMock = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/scaffold.js', () => ({
  scaffoldGraphIfNeeded: scaffoldMock,
}))

vi.mock('../../src/bootstrap/bootstrap.js', () => ({
  runBootstrap: vi.fn().mockResolvedValue({ ran: false, chunksProcessed: 0, chunksSucceeded: 0, nodesWritten: 0 }),
}))
vi.mock('../../src/graph/node-reader.js', () => ({
  listAllNodes: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/utils/paths.js', () => ({
  resolveOmgRoot: vi.fn().mockReturnValue('/workspace/memory/omg'),
  resolveMocPath: vi.fn().mockReturnValue('/workspace/memory/omg/mocs/moc-test.md'),
  resolveNodePath: vi.fn().mockReturnValue('/workspace/memory/omg/nodes/fact/fact-test.md'),
  resolveStatePath: vi.fn().mockReturnValue('/workspace/.omg-state/session.json'),
}))

vi.mock('../../src/hooks/agent-end.js', () => ({
  agentEnd: vi.fn().mockResolvedValue(undefined),
  tryRunObservation: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/hooks/before-agent-start.js', () => ({
  beforeAgentStart: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/hooks/before-compaction.js', () => ({
  beforeCompaction: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/hooks/tool-result-persist.js', () => ({
  toolResultPersist: vi.fn().mockReturnValue(undefined),
}))
vi.mock('../../src/llm/client.js', () => ({
  createLlmClient: vi.fn().mockReturnValue({ generate: vi.fn() }),
}))
vi.mock('../../src/cron/register.js', () => ({
  registerCronJobs: vi.fn(),
}))

const { plugin } = await import('../../src/plugin.js')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockApi(config: Record<string, unknown> = {}): PluginApi & { on: ReturnType<typeof vi.fn>; registerCli: ReturnType<typeof vi.fn> } {
  return {
    config,
    workspaceDir: '/workspace',
    generate: vi.fn(),
    on: vi.fn(),
    scheduleCron: vi.fn(),
    registerCli: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// Plugin identity
// ---------------------------------------------------------------------------

describe('plugin — identity', () => {
  it('has id "omg"', () => {
    expect(plugin.id).toBe('omg')
  })

  it('has name "Observational Memory Graph"', () => {
    expect(plugin.name).toBe('Observational Memory Graph')
  })

  it('exposes configSchema with a .parse method', () => {
    expect(typeof plugin.configSchema.parse).toBe('function')
  })
})

// ---------------------------------------------------------------------------
// Hook wiring
// ---------------------------------------------------------------------------

describe('plugin.register — hook wiring', () => {
  it('registers exactly 5 hooks (before_prompt_build, agent_end, before_compaction, tool_result_persist, gateway_start)', () => {
    const api = makeMockApi()
    plugin.register(api)
    expect(api.on).toHaveBeenCalledTimes(5)
  })

  it('registers before_prompt_build hook', () => {
    const api = makeMockApi()
    plugin.register(api)
    expect(api.on).toHaveBeenCalledWith('before_prompt_build', expect.any(Function))
  })

  it('registers agent_end hook', () => {
    const api = makeMockApi()
    plugin.register(api)
    expect(api.on).toHaveBeenCalledWith('agent_end', expect.any(Function))
  })

  it('registers before_compaction hook', () => {
    const api = makeMockApi()
    plugin.register(api)
    expect(api.on).toHaveBeenCalledWith('before_compaction', expect.any(Function))
  })

  it('registers tool_result_persist hook', () => {
    const api = makeMockApi()
    plugin.register(api)
    expect(api.on).toHaveBeenCalledWith('tool_result_persist', expect.any(Function))
  })

  it('registers gateway_start hook', () => {
    const api = makeMockApi()
    plugin.register(api)
    expect(api.on).toHaveBeenCalledWith('gateway_start', expect.any(Function))
  })
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('plugin.register — idempotency', () => {
  it('second call to register on a different api also makes 5 on() calls', () => {
    const api1 = makeMockApi()
    const api2 = makeMockApi()

    plugin.register(api1)
    plugin.register(api2)

    expect(api1.on).toHaveBeenCalledTimes(5)
    expect(api2.on).toHaveBeenCalledTimes(5)
  })
})

// ---------------------------------------------------------------------------
// scaffoldGraphIfNeeded
// ---------------------------------------------------------------------------

describe('plugin.register — scaffoldGraphIfNeeded', () => {
  it('calls scaffoldGraphIfNeeded when gateway_start fires', async () => {
    const api = makeMockApi()
    plugin.register(api)

    // Extract the gateway_start handler registered via api.on and invoke it
    const gwCall = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'gateway_start'
    )
    const gwHandler = gwCall?.[1] as (() => Promise<void>) | undefined
    expect(gwHandler).toBeDefined()

    await gwHandler!()

    expect(scaffoldMock).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// registerCli
// ---------------------------------------------------------------------------

describe('plugin.register — registerCli', () => {
  it('calls registerCli when it is a function', () => {
    const api = makeMockApi()
    plugin.register(api)
    expect(api.registerCli).toHaveBeenCalledTimes(1)
  })

  it('passes commands: ["omg bootstrap"] to registerCli', () => {
    const api = makeMockApi()
    plugin.register(api)
    expect(api.registerCli).toHaveBeenCalledWith(
      expect.any(Function),
      { commands: ['omg bootstrap'] }
    )
  })

  it('does not throw when registerCli is absent (old host version)', () => {
    const api = makeMockApi()
    const { registerCli: _unused, ...apiWithoutCli } = api
    expect(() => plugin.register(apiWithoutCli as PluginApi)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// before_prompt_build bootstrap trigger
// ---------------------------------------------------------------------------

describe('plugin.register — before_prompt_build bootstrap trigger', () => {
  it('triggers runBootstrap fire-and-forget on first before_prompt_build when graph is empty', async () => {
    const { runBootstrap } = await import('../../src/bootstrap/bootstrap.js')
    const { listAllNodes } = await import('../../src/graph/node-reader.js')
    vi.mocked(listAllNodes).mockResolvedValueOnce([])

    const api = makeMockApi()
    plugin.register(api)

    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'before_prompt_build'
    )?.[1] as ((event: { prompt: string }, ctx: { sessionKey: string }) => Promise<unknown>) | undefined
    expect(handler).toBeDefined()

    await handler!({ prompt: 'hello' }, { sessionKey: 'sess-1' })
    // Give fire-and-forget microtasks to run: scaffold → listAllNodes → bootstrap
    for (let i = 0; i < 6; i++) await Promise.resolve()

    expect(runBootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ force: false })
    )
  })

  it('does NOT trigger runBootstrap again on the second before_prompt_build call', async () => {
    const { runBootstrap } = await import('../../src/bootstrap/bootstrap.js')
    const { listAllNodes } = await import('../../src/graph/node-reader.js')
    vi.mocked(listAllNodes).mockResolvedValue([])
    vi.mocked(runBootstrap as ReturnType<typeof vi.fn>).mockResolvedValue({
      ran: true, chunksProcessed: 1, chunksSucceeded: 1, nodesWritten: 2
    })

    const api = makeMockApi()
    plugin.register(api)

    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'before_prompt_build'
    )?.[1] as ((event: { prompt: string }, ctx: { sessionKey: string }) => Promise<unknown>) | undefined

    await handler!({ prompt: 'turn 1' }, { sessionKey: 'sess-1' })
    for (let i = 0; i < 6; i++) await Promise.resolve()
    const callsAfterFirst = vi.mocked(runBootstrap as ReturnType<typeof vi.fn>).mock.calls.length

    await handler!({ prompt: 'turn 2' }, { sessionKey: 'sess-1' })
    for (let i = 0; i < 6; i++) await Promise.resolve()

    expect(vi.mocked(runBootstrap as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAfterFirst)
  })

  it('does NOT trigger runBootstrap when graph is non-empty', async () => {
    const { runBootstrap } = await import('../../src/bootstrap/bootstrap.js')
    const { listAllNodes } = await import('../../src/graph/node-reader.js')
    vi.mocked(listAllNodes).mockResolvedValueOnce([
      { id: 'omg/some-node' } as unknown as Awaited<ReturnType<typeof listAllNodes>>[number]
    ] as Awaited<ReturnType<typeof listAllNodes>>)

    const api = makeMockApi()
    plugin.register(api)

    const handler = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (args: unknown[]) => args[0] === 'before_prompt_build'
    )?.[1] as ((event: { prompt: string }, ctx: { sessionKey: string }) => Promise<unknown>) | undefined

    await handler!({ prompt: 'hello' }, { sessionKey: 'sess-1' })
    for (let i = 0; i < 6; i++) await Promise.resolve()

    expect(runBootstrap).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('plugin.register — config validation', () => {
  it('succeeds with valid empty config (all defaults)', () => {
    const api = makeMockApi({})
    expect(() => plugin.register(api)).not.toThrow()
  })

  it('throws ConfigValidationError when config has an invalid triggerMode', () => {
    const api = makeMockApi({ observation: { triggerMode: 'not-a-valid-mode' } })
    expect(() => plugin.register(api)).toThrow(ConfigValidationError)
  })
})
