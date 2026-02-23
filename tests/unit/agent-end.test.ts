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
// agentEnd — observation with node writes (new upsert format)
// ---------------------------------------------------------------------------

describe('agentEnd — observation with node output', () => {
  it('writes observation nodes to deterministic path when LLM returns upsert operations', async () => {
    const xml = `<observations>
<operations>
<operation type="fact" priority="medium">
  <canonical-key>facts.typescript-typing</canonical-key>
  <title>TypeScript Type System</title>
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
    // New format: deterministic path nodes/{type}/{slugify(canonicalKey)}.md
    const nodePath = `${OMG_ROOT}/nodes/fact/facts-typescript-typing.md`
    expect(fs.existsSync(nodePath)).toBe(true)
  })

  it('updates lastObservationNodeIds in state after writing nodes', async () => {
    const xml = `<observations>
<operations>
<operation type="fact" priority="high">
  <canonical-key>facts.new-observation</canonical-key>
  <title>A New Observation Fact</title>
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

  it('does not call listAllNodes (no node index is gathered)', async () => {
    // Verify the observer is called WITHOUT existingNodeIndex being populated
    // by checking that the user prompt does NOT contain "Existing Node Index"
    const xml = '<observations></observations>'
    const config = parseConfig({ observation: { triggerMode: 'every-turn' } })
    const llmClient = makeMockLlmClient(xml)

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )

    const call = (llmClient.generate as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]
    expect(call?.user).not.toContain('Existing Node Index')
  })
})

// ---------------------------------------------------------------------------
// agentEnd — MOC update via moc-hints in new upsert format
// ---------------------------------------------------------------------------

describe('agentEnd — MOC update uses links (via moc-hints in upsert)', () => {
  it('creates MOC file for a domain when upsert operation includes moc-hints', async () => {
    // New format: moc-hints drives mocUpdates, node-writer adds omg/moc-{domain} to links
    const xml = `<observations>
<operations>
<operation type="preference" priority="medium">
  <canonical-key>preferences.dark-mode</canonical-key>
  <title>Dark Mode Preference</title>
  <description>User prefers dark mode</description>
  <content>The user has expressed a preference for dark mode in editors.</content>
  <moc-hints>preferences</moc-hints>
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
    // MOC file must exist because moc-hints caused mocUpdates → domain node links to omg/moc-preferences
    const mocPath = `${OMG_ROOT}/mocs/moc-preferences.md`
    expect(fs.existsSync(mocPath)).toBe(true)
  })

  it('does NOT create MOC file when operation has no moc-hints', async () => {
    const xml = `<observations>
<operations>
<operation type="fact" priority="medium">
  <canonical-key>facts.no-moc-fact</canonical-key>
  <title>A Fact Without MOC</title>
  <description>Node with no moc-hints</description>
  <content>This fact does not belong to any MOC domain.</content>
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
    const mocPath = `${OMG_ROOT}/mocs/moc-preferences.md`
    expect(fs.existsSync(mocPath)).toBe(false)
  })
})

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
// agentEnd — reflection trigger
// ---------------------------------------------------------------------------

describe('agentEnd — reflection trigger', () => {
  it('calls LLM a second time for reflection when token delta exceeds threshold', async () => {
    // Pre-seed a state with totalObservationTokens already above the threshold.
    // Empty observations don't accumulate tokens, so we need an existing baseline.
    const stateJson = JSON.stringify({
      lastObservedAtMs: 0,
      pendingMessageTokens: 0,
      totalObservationTokens: 50_000,
      lastReflectionTotalTokens: 0,
      observationBoundaryMessageIndex: 0,
      nodeCount: 0,
      lastObservationNodeIds: [],
    })
    // Scaffold an observation node so the reflector has something to work with.
    vol.fromJSON({
      ...vol.toJSON(),
      [`${WORKSPACE}/.omg-state/${SESSION_KEY}.json`]: stateJson,
      [`${OMG_ROOT}/nodes/fact/fact-existing.md`]: '---\nid: omg/fact-existing\ndescription: Existing fact\ntype: fact\npriority: medium\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\nAn existing fact.',
    })

    // Threshold of 1 → delta of 50,000 already exceeds it on the first observation.
    const config = parseConfig({
      observation: { triggerMode: 'every-turn' },
      reflection: { observationTokenThreshold: 1 },
    })

    const observationXml = '<observations></observations>'
    const reflectionXml = `
      <reflection>
        <reflection-nodes>
          <node compression-level="0">
            <id>omg/reflection/trigger-test</id>
            <description>Triggered reflection</description>
            <sources>omg/fact-existing</sources>
            <body>Synthesis of existing facts.</body>
          </node>
        </reflection-nodes>
        <archive-nodes></archive-nodes>
        <moc-updates></moc-updates>
        <node-updates></node-updates>
      </reflection>`

    const llmClient: LlmClient = {
      generate: vi.fn()
        .mockResolvedValueOnce({ content: observationXml, usage: { inputTokens: 100, outputTokens: 50 } })
        .mockResolvedValueOnce({ content: reflectionXml, usage: { inputTokens: 200, outputTokens: 100 } }),
    }

    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )

    // First call = observation, second call = reflection
    expect(llmClient.generate).toHaveBeenCalledTimes(2)
  })

  it('advances lastReflectionTotalTokens watermark after reflection fires', async () => {
    // Pre-seed state: totalObservationTokens above threshold, watermark at 0.
    const stateJson = JSON.stringify({
      lastObservedAtMs: 0,
      pendingMessageTokens: 0,
      totalObservationTokens: 50_000,
      lastReflectionTotalTokens: 0,
      observationBoundaryMessageIndex: 0,
      nodeCount: 0,
      lastObservationNodeIds: [],
    })
    vol.fromJSON({
      ...vol.toJSON(),
      [`${WORKSPACE}/.omg-state/${SESSION_KEY}.json`]: stateJson,
      [`${OMG_ROOT}/nodes/fact/fact-existing.md`]: '---\nid: omg/fact-existing\ndescription: Existing fact\ntype: fact\npriority: medium\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\nAn existing fact.',
    })

    const config = parseConfig({
      observation: { triggerMode: 'every-turn' },
      reflection: { observationTokenThreshold: 1 },
    })

    const observationXml = '<observations></observations>'
    const reflectionXml = `
      <reflection>
        <reflection-nodes></reflection-nodes>
        <archive-nodes></archive-nodes>
        <moc-updates></moc-updates>
        <node-updates></node-updates>
      </reflection>`

    const llmClient: LlmClient = {
      generate: vi.fn()
        .mockResolvedValueOnce({ content: observationXml, usage: { inputTokens: 10, outputTokens: 5 } })
        .mockResolvedValueOnce({ content: reflectionXml, usage: { inputTokens: 10, outputTokens: 5 } }),
    }

    // Run one turn — observation + reflection fires (2 LLM calls)
    await agentEnd(
      { success: true },
      { workspaceDir: WORKSPACE, sessionKey: SESSION_KEY, messages: makeMessages(2), config, llmClient }
    )
    expect(llmClient.generate).toHaveBeenCalledTimes(2)

    // After turn 1, the watermark must have advanced to match totalObservationTokens.
    const { loadSessionState } = await import('../../src/state/session-state.js')
    const state = await loadSessionState(WORKSPACE, SESSION_KEY)
    expect(state.lastReflectionTotalTokens).toBe(state.totalObservationTokens)
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
