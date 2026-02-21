import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runObservation } from '../../src/observer/observer.js'
import type { ObservationParams, Message, NodeIndexEntry } from '../../src/types.js'
import type { LlmClient, LlmResponse } from '../../src/llm/client.js'
import { parseConfig } from '../../src/config.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const config = parseConfig({})

const MESSAGES: readonly Message[] = [
  { role: 'user', content: 'I prefer dark mode in all my editors.' },
  { role: 'assistant', content: 'Got it! I will remember that preference.' },
]

const INDEX: readonly NodeIndexEntry[] = [
  { id: 'omg/project/my-app', description: 'Main web application' },
]

const VALID_XML = `
<observations>
  <operations>
    <operation action="create" type="preference" priority="high">
      <id>omg/preference/dark-mode</id>
      <description>User prefers dark mode</description>
      <content>The user prefers dark mode in all editors.</content>
    </operation>
  </operations>
  <now-update>## Focus\nPreference setting session.</now-update>
</observations>
`.trim()

const VALID_LLM_RESPONSE: LlmResponse = {
  content: VALID_XML,
  usage: { inputTokens: 100, outputTokens: 50 },
}

function makeMockClient(response: LlmResponse = VALID_LLM_RESPONSE): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue(response),
  }
}

function makeParams(overrides: Partial<ObservationParams> = {}): ObservationParams {
  return {
    unobservedMessages: MESSAGES,
    existingNodeIndex: INDEX,
    nowNode: null,
    config,
    llmClient: makeMockClient(),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runObservation', () => {
  describe('short-circuit', () => {
    it('returns empty output without calling the LLM when messages is empty', async () => {
      const client = makeMockClient()
      const params = makeParams({ unobservedMessages: [], llmClient: client })

      const output = await runObservation(params)

      expect(output.operations).toHaveLength(0)
      expect(output.nowUpdate).toBeNull()
      expect(output.mocUpdates).toHaveLength(0)
      expect(client.generate).not.toHaveBeenCalled()
    })
  })

  describe('successful LLM call', () => {
    it('returns parsed operations from valid LLM XML response', async () => {
      const output = await runObservation(makeParams())

      expect(output.operations).toHaveLength(1)
      expect(output.operations[0]!.kind).toBe('create')
      expect(output.operations[0]!.frontmatter.id).toBe('omg/preference/dark-mode')
    })

    it('returns nowUpdate from valid LLM XML response', async () => {
      const output = await runObservation(makeParams())
      expect(output.nowUpdate).toContain('## Focus')
    })

    it('calls the LLM client with system and user prompts', async () => {
      const client = makeMockClient()
      await runObservation(makeParams({ llmClient: client }))

      expect(client.generate).toHaveBeenCalledOnce()
      const call = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      expect(typeof call.system).toBe('string')
      expect(call.system.length).toBeGreaterThan(0)
      expect(typeof call.user).toBe('string')
      expect(call.user.length).toBeGreaterThan(0)
    })

    it('calls the LLM client with maxTokens: 4096', async () => {
      const client = makeMockClient()
      await runObservation(makeParams({ llmClient: client }))

      const call = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0]
      expect(call.maxTokens).toBe(4096)
    })

    it('filters out operations with invalid node types (belt-and-suspenders)', async () => {
      // Inject a response that contains an operation with an invalid type
      const badXml = `
<observations>
  <operations>
    <operation action="create" type="not-a-valid-type" priority="high">
      <id>omg/fake/node</id>
      <description>desc</description>
      <content>body</content>
    </operation>
    <operation action="create" type="preference" priority="high">
      <id>omg/preference/vim</id>
      <description>Uses vim</description>
      <content>body</content>
    </operation>
  </operations>
</observations>`.trim()

      const client = makeMockClient({ content: badXml, usage: { inputTokens: 10, outputTokens: 10 } })
      const output = await runObservation(makeParams({ llmClient: client }))

      // The invalid type should be filtered out before reaching the output
      // (parser skips unknown types; observer post-validates). Only the valid
      // preference operation should survive.
      expect(output.operations.every((op) => op.frontmatter.type === 'preference')).toBe(true)
    })
  })

  describe('error handling', () => {
    it('does not throw when the LLM client throws', async () => {
      const client: LlmClient = {
        generate: vi.fn().mockRejectedValue(new Error('Network error')),
      }

      await expect(runObservation(makeParams({ llmClient: client }))).resolves.toBeDefined()
    })

    it('returns empty output when the LLM client throws', async () => {
      const client: LlmClient = {
        generate: vi.fn().mockRejectedValue(new Error('timeout')),
      }

      const output = await runObservation(makeParams({ llmClient: client }))

      expect(output.operations).toHaveLength(0)
      expect(output.nowUpdate).toBeNull()
      expect(output.mocUpdates).toHaveLength(0)
    })

    it('does not throw when the LLM returns garbage text', async () => {
      const client = makeMockClient({
        content: 'this is not xml at all',
        usage: { inputTokens: 5, outputTokens: 3 },
      })

      await expect(runObservation(makeParams({ llmClient: client }))).resolves.toBeDefined()
    })

    it('returns a valid ObserverOutput shape when LLM returns garbage', async () => {
      const client = makeMockClient({
        content: '<<< total garbage >>>',
        usage: { inputTokens: 5, outputTokens: 3 },
      })

      const output = await runObservation(makeParams({ llmClient: client }))
      expect(Array.isArray(output.operations)).toBe(true)
      expect(output.nowUpdate === null || typeof output.nowUpdate === 'string').toBe(true)
      expect(Array.isArray(output.mocUpdates)).toBe(true)
    })
  })

  describe('token logging', () => {
    it('logs token usage via console.error', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await runObservation(makeParams())
        const calls = spy.mock.calls
        const tokenLog = calls.find((args) =>
          typeof args[0] === 'string' && args[0].includes('tokens used'),
        )
        expect(tokenLog).toBeDefined()
      } finally {
        spy.mockRestore()
      }
    })
  })
})
