import { describe, it, expect, beforeEach, vi } from 'vitest'
import { vol } from 'memfs'
import { parseConfig } from '../../src/config.js'
import type { LlmClient } from '../../src/llm/client.js'
import type { Message } from '../../src/types.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

const { agentEnd } = await import('../../src/hooks/agent-end.js')

const WORKSPACE = '/workspace'
const SESSION_KEY = 'test-session'
const OMG_ROOT = `${WORKSPACE}/memory/omg`

function makeMockLlmClient(responseXml?: string): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content: responseXml ?? '<observations></observations>',
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  }
}

function makeMessages(count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i} content with some words to accumulate tokens.`,
  }))
}

beforeEach(() => {
  vol.reset()
  // Scaffold minimal graph directories
  vol.fromJSON({
    [`${OMG_ROOT}/index.md`]: '---\ntype: index\nid: omg/index\npriority: high\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n# Index\n',
    [`${OMG_ROOT}/now.md`]: '---\ntype: now\nid: omg/now\npriority: high\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n# Now\nInitial state.',
  })
})

// ---------------------------------------------------------------------------
// agentEnd — no-op paths
// ---------------------------------------------------------------------------

describe('agentEnd — below threshold', () => {
  it('does not call LLM when below token threshold', async () => {
    const config = parseConfig({ observation: { triggerMode: 'threshold', messageTokenThreshold: 30_000 } })
    const llmClient = makeMockLlmClient()

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )

    expect(llmClient.generate).not.toHaveBeenCalled()
  })

  it('saves updated state even when observation does not trigger', async () => {
    const config = parseConfig({ observation: { triggerMode: 'threshold', messageTokenThreshold: 30_000 } })
    const llmClient = makeMockLlmClient()

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )

    const { fs } = await import('memfs')
    const stateExists = fs.existsSync(`${WORKSPACE}/.omg-state/${SESSION_KEY}.json`)
    expect(stateExists).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// agentEnd — every-turn mode
// ---------------------------------------------------------------------------

describe('agentEnd — every-turn mode', () => {
  it('calls LLM on every turn regardless of token count', async () => {
    const config = parseConfig({ observation: { triggerMode: 'every-turn' } })
    const llmClient = makeMockLlmClient()

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )

    expect(llmClient.generate).toHaveBeenCalledTimes(1)
  })

  it('updates session state boundary after observation', async () => {
    const config = parseConfig({ observation: { triggerMode: 'every-turn' } })
    const llmClient = makeMockLlmClient()
    const messages = makeMessages(4)

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages, config, llmClient }
    )

    const { loadSessionState } = await import('../../src/state/session-state.js')
    const state = await loadSessionState(WORKSPACE, SESSION_KEY)
    expect(state.observationBoundaryMessageIndex).toBe(messages.length)
  })

  it('resets pendingMessageTokens to 0 after observation', async () => {
    const config = parseConfig({ observation: { triggerMode: 'every-turn' } })
    const llmClient = makeMockLlmClient()

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(3), config, llmClient }
    )

    const { loadSessionState } = await import('../../src/state/session-state.js')
    const state = await loadSessionState(WORKSPACE, SESSION_KEY)
    expect(state.pendingMessageTokens).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// agentEnd — observation with node writes
// ---------------------------------------------------------------------------

describe('agentEnd — observation with node output', () => {
  it('writes observation nodes when LLM returns operations', async () => {
    const xml = `<observations>
<operations>
<operation action="create" type="fact" priority="medium">
  <id>omg/typescript-types</id>
  <description>TypeScript is strongly typed</description>
  <content>TypeScript adds static types to JavaScript.</content>
</operation>
</operations>
</observations>`

    const config = parseConfig({ observation: { triggerMode: 'every-turn' } })
    const llmClient = makeMockLlmClient(xml)

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )

    const { fs } = await import('memfs')
    const nodeDir = `${OMG_ROOT}/nodes/fact`
    const files = fs.readdirSync(nodeDir) as string[]
    expect(files.length).toBeGreaterThan(0)
  })

  it('updates lastObservationNodeIds in state after writing nodes', async () => {
    const xml = `<observations>
<operations>
<operation action="create" type="fact" priority="high">
  <id>omg/new-observation-fact</id>
  <description>A new observation fact</description>
  <content>This is an important fact.</content>
</operation>
</operations>
</observations>`

    const config = parseConfig({ observation: { triggerMode: 'every-turn' } })
    const llmClient = makeMockLlmClient(xml)

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )

    const { loadSessionState } = await import('../../src/state/session-state.js')
    const state = await loadSessionState(WORKSPACE, SESSION_KEY)
    expect(state.lastObservationNodeIds.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// agentEnd — error resilience
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// agentEnd — manual mode
// ---------------------------------------------------------------------------

describe('agentEnd — manual mode', () => {
  it('does not call LLM when triggerMode is manual', async () => {
    const config = parseConfig({ observation: { triggerMode: 'manual' } })
    const llmClient = makeMockLlmClient()

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )

    expect(llmClient.generate).not.toHaveBeenCalled()
  })

  it('saves state even in manual mode', async () => {
    const config = parseConfig({ observation: { triggerMode: 'manual' } })
    const llmClient = makeMockLlmClient()

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )

    const { fs } = await import('memfs')
    expect(fs.existsSync(`${WORKSPACE}/.omg-state/${SESSION_KEY}.json`)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// agentEnd — error resilience
// ---------------------------------------------------------------------------

describe('agentEnd — error resilience', () => {
  it('never throws even when LLM client throws', async () => {
    const config = parseConfig({ observation: { triggerMode: 'every-turn' } })
    const llmClient: LlmClient = {
      generate: vi.fn().mockRejectedValue(new Error('LLM API error')),
    }

    await expect(
      agentEnd(
        { success: true },
        { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
      )
    ).resolves.toBeUndefined()
  })

  it('still saves state even when observation fails', async () => {
    const config = parseConfig({ observation: { triggerMode: 'every-turn' } })
    const llmClient: LlmClient = {
      generate: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    }

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )

    const { fs } = await import('memfs')
    expect(fs.existsSync(`${WORKSPACE}/.omg-state/${SESSION_KEY}.json`)).toBe(true)
  })

  it('does not advance observationBoundaryMessageIndex when observation fails', async () => {
    const config = parseConfig({ observation: { triggerMode: 'every-turn' } })
    const llmClient: LlmClient = {
      generate: vi.fn().mockRejectedValue(new Error('LLM unavailable')),
    }
    const messages = makeMessages(4)

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages, config, llmClient }
    )

    const { loadSessionState } = await import('../../src/state/session-state.js')
    const state = await loadSessionState(WORKSPACE, SESSION_KEY)
    // Boundary must NOT advance — the next turn must retry the same messages
    expect(state.observationBoundaryMessageIndex).toBe(0)
    // Pending tokens must NOT reset — ensures retry accumulates correctly
    expect(state.pendingMessageTokens).toBeGreaterThan(0)
  })
})
