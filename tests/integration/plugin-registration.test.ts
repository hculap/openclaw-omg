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

function makeMockApi(config: Record<string, unknown> = {}): PluginApi & { on: ReturnType<typeof vi.fn> } {
  return {
    config,
    workspaceDir: '/workspace',
    generate: vi.fn(),
    on: vi.fn(),
    scheduleCron: vi.fn(),
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
  it('calls scaffoldGraphIfNeeded once per register() call', async () => {
    const api1 = makeMockApi()
    const api2 = makeMockApi()

    plugin.register(api1)
    plugin.register(api2)

    // scaffoldGraphIfNeeded is called via a void promise — flush microtasks
    await Promise.resolve()

    expect(scaffoldMock).toHaveBeenCalledTimes(2)
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
