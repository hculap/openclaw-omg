import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PluginApi } from '../../src/plugin.js'

vi.mock('../../src/hooks/agent-end.js', () => ({
  agentEnd: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/hooks/before-agent-start.js', () => ({
  beforeAgentStart: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/hooks/tool-result-persist.js', () => ({
  toolResultPersist: vi.fn().mockReturnValue(undefined),
}))
vi.mock('../../src/llm/client.js', () => ({
  createLlmClient: vi.fn().mockReturnValue({ generate: vi.fn() }),
}))

const { register } = await import('../../src/plugin.js')

function makeMockApi(config: Record<string, unknown> = {}): PluginApi & { on: ReturnType<typeof vi.fn> } {
  return {
    config,
    workspaceDir: '/workspace',
    generate: vi.fn(),
    on: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---------------------------------------------------------------------------
// register — hook wiring
// ---------------------------------------------------------------------------

describe('register — hook registration', () => {
  it('registers exactly three hooks', () => {
    const api = makeMockApi()
    register(api)
    expect(api.on).toHaveBeenCalledTimes(3)
  })

  it('registers before_agent_start hook', () => {
    const api = makeMockApi()
    register(api)
    expect(api.on).toHaveBeenCalledWith('before_agent_start', expect.any(Function))
  })

  it('registers agent_end hook', () => {
    const api = makeMockApi()
    register(api)
    expect(api.on).toHaveBeenCalledWith('agent_end', expect.any(Function))
  })

  it('registers tool_result_persist hook', () => {
    const api = makeMockApi()
    register(api)
    expect(api.on).toHaveBeenCalledWith('tool_result_persist', expect.any(Function))
  })
})

// ---------------------------------------------------------------------------
// register — config validation
// ---------------------------------------------------------------------------

describe('register — config validation', () => {
  it('succeeds with valid empty config (all defaults)', () => {
    const api = makeMockApi({})
    expect(() => register(api)).not.toThrow()
  })

  it('throws when config has an invalid triggerMode', () => {
    const api = makeMockApi({ observation: { triggerMode: 'not-a-valid-mode' } })
    expect(() => register(api)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// register — default export
// ---------------------------------------------------------------------------

describe('register — default export', () => {
  it('default export equals named register export', async () => {
    const mod = await import('../../src/plugin.js')
    expect(mod.default).toBe(mod.register)
  })
})

// ---------------------------------------------------------------------------
// register — agent_end handler argument forwarding
// ---------------------------------------------------------------------------

describe('register — agent_end handler', () => {
  it('forwards ctx.messages to agentEnd', async () => {
    const { agentEnd } = await import('../../src/hooks/agent-end.js')
    const api = makeMockApi()
    register(api)

    const agentEndCall = (api.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'agent_end'
    )
    const handler = agentEndCall![1] as (
      event: { success: boolean },
      ctx: { sessionKey: string; messages: Array<{ role: string; content: string }> }
    ) => Promise<void>

    const messages = [{ role: 'user' as const, content: 'Hello' }]
    await handler({ success: true }, { sessionKey: 'test-session', messages })

    expect(agentEnd).toHaveBeenCalledWith(
      { success: true },
      expect.objectContaining({ messages })
    )
  })
})
