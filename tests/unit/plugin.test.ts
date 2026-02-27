import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { PluginApi } from '../../src/plugin.js'

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
vi.mock('../../src/scaffold.js', () => ({
  scaffoldGraphIfNeeded: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/cron/workspace-registry.js', () => ({
  readWorkspaceRegistry: vi.fn().mockResolvedValue({ version: 1, workspaces: {} }),
  writeWorkspaceRegistry: vi.fn().mockResolvedValue(undefined),
  addWorkspaceToRegistry: vi.fn().mockResolvedValue(undefined),
  addWorkspace: vi.fn().mockImplementation((reg: unknown) => reg),
  pruneStaleWorkspaces: vi.fn().mockImplementation((reg: unknown) => reg),
  listWorkspacePaths: vi.fn().mockReturnValue([]),
}))

const { register, resolveAllowedWorkspaces } = await import('../../src/plugin.js')

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
// register — hook wiring
// ---------------------------------------------------------------------------

describe('register — hook registration', () => {
  it('registers exactly five hooks', () => {
    const api = makeMockApi()
    register(api)
    expect(api.on).toHaveBeenCalledTimes(5)
  })

  it('registers before_prompt_build hook', () => {
    const api = makeMockApi()
    register(api)
    expect(api.on).toHaveBeenCalledWith('before_prompt_build', expect.any(Function))
  })

  it('registers agent_end hook', () => {
    const api = makeMockApi()
    register(api)
    expect(api.on).toHaveBeenCalledWith('agent_end', expect.any(Function))
  })

  it('registers before_compaction hook', () => {
    const api = makeMockApi()
    register(api)
    expect(api.on).toHaveBeenCalledWith('before_compaction', expect.any(Function))
  })

  it('registers tool_result_persist hook', () => {
    const api = makeMockApi()
    register(api)
    expect(api.on).toHaveBeenCalledWith('tool_result_persist', expect.any(Function))
  })

  it('registers gateway_start hook', () => {
    const api = makeMockApi()
    register(api)
    expect(api.on).toHaveBeenCalledWith('gateway_start', expect.any(Function))
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

// ---------------------------------------------------------------------------
// resolveAllowedWorkspaces
// ---------------------------------------------------------------------------

describe('resolveAllowedWorkspaces', () => {
  it('returns empty set when no agents config exists', () => {
    const result = resolveAllowedWorkspaces({})
    expect(result.size).toBe(0)
  })

  it('collects agents.defaults.workspace', () => {
    const config = { agents: { defaults: { workspace: '/home/user/default' } } }
    const result = resolveAllowedWorkspaces(config)
    expect(result.has('/home/user/default')).toBe(true)
    expect(result.size).toBe(1)
  })

  it('collects agents.list[].workspace', () => {
    const config = {
      agents: {
        list: [
          { name: 'coding', workspace: '/home/user/TechLead' },
          { name: 'pati', workspace: '/home/user/Secretary' },
        ],
      },
    }
    const result = resolveAllowedWorkspaces(config)
    expect(result.has('/home/user/TechLead')).toBe(true)
    expect(result.has('/home/user/Secretary')).toBe(true)
    expect(result.size).toBe(2)
  })

  it('includes pluginWorkspaceDir when provided', () => {
    const result = resolveAllowedWorkspaces({}, '/home/user/plugin-ws')
    expect(result.has('/home/user/plugin-ws')).toBe(true)
    expect(result.size).toBe(1)
  })

  it('deduplicates overlapping workspace paths', () => {
    const config = {
      agents: {
        defaults: { workspace: '/home/user/Secretary' },
        list: [{ name: 'pati', workspace: '/home/user/Secretary' }],
      },
    }
    const result = resolveAllowedWorkspaces(config, '/home/user/Secretary')
    expect(result.size).toBe(1)
  })

  it('combines all three sources', () => {
    const config = {
      agents: {
        defaults: { workspace: '/ws/default' },
        list: [
          { name: 'a', workspace: '/ws/agent-a' },
          { name: 'b', workspace: '/ws/agent-b' },
        ],
      },
    }
    const result = resolveAllowedWorkspaces(config, '/ws/plugin')
    expect(result.size).toBe(4)
    expect(result.has('/ws/default')).toBe(true)
    expect(result.has('/ws/agent-a')).toBe(true)
    expect(result.has('/ws/agent-b')).toBe(true)
    expect(result.has('/ws/plugin')).toBe(true)
  })

  it('skips empty string workspace values', () => {
    const config = {
      agents: {
        defaults: { workspace: '' },
        list: [{ name: 'a', workspace: '' }],
      },
    }
    const result = resolveAllowedWorkspaces(config, '')
    expect(result.size).toBe(0)
  })

  it('skips non-string workspace values', () => {
    const config = {
      agents: {
        defaults: { workspace: 42 },
        list: [{ name: 'a', workspace: true }],
      },
    }
    const result = resolveAllowedWorkspaces(config)
    expect(result.size).toBe(0)
  })

  it('skips agents without workspace field', () => {
    const config = {
      agents: {
        list: [{ name: 'main' }, { name: 'coding', workspace: '/ws/coding' }],
      },
    }
    const result = resolveAllowedWorkspaces(config)
    expect(result.size).toBe(1)
    expect(result.has('/ws/coding')).toBe(true)
  })
})
