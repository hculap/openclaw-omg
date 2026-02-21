import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runObservation } from '../../src/observer/observer.js'
import type { ObservationParams, Message, NodeIndexEntry, ObserverOutput } from '../../src/types.js'
import type { LlmClient, LlmResponse } from '../../src/llm/client.js'
import { parseConfig } from '../../src/config.js'

vi.mock('../../src/observer/parser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/observer/parser.js')>()
  return { ...actual }
})

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

    it('passes nowNode content into the LLM user prompt', async () => {
      const client = makeMockClient()
      await runObservation(makeParams({
        llmClient: client,
        nowNode: '## Current Focus\nWorking on auth module',
      }))

      const userPrompt = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0].user
      expect(userPrompt).toContain('Working on auth module')
    })

    it('includes (none) in user prompt when nowNode is null', async () => {
      const client = makeMockClient()
      await runObservation(makeParams({ llmClient: client, nowNode: null }))

      const userPrompt = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0].user
      expect(userPrompt).toContain('(none)')
    })

    it('passes sessionContext into the LLM user prompt', async () => {
      const client = makeMockClient()
      await runObservation(makeParams({
        llmClient: client,
        sessionContext: { workspaceId: 'ws-123' },
      }))

      const userPrompt = (client.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0].user
      expect(userPrompt).toContain('ws-123')
    })

    it('filters out operations whose node type slipped through the parser (post-validation)', async () => {
      // Simulate a parser bug: inject an operation with an invalid type that the
      // parser should have rejected. The post-validator in the observer must catch it.
      const parserModule = await import('../../src/observer/parser.js')
      const badOutput: ObserverOutput = {
        operations: [
          {
            kind: 'create',
            frontmatter: {
              id: 'omg/unknown/test',
              description: 'Test',
              type: 'not-a-valid-type' as never,
              priority: 'medium',
              created: new Date().toISOString(),
              updated: new Date().toISOString(),
            },
            body: 'Test body',
          },
        ],
        nowUpdate: null,
        mocUpdates: [],
      }
      const parseSpy = vi.spyOn(parserModule, 'parseObserverOutput').mockReturnValue(badOutput)
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      try {
        const output = await runObservation(makeParams())

        // Post-validator must filter out the bad operation
        expect(output.operations).toHaveLength(0)

        // Must log the rejection with the invalid type and id
        const rejectionLog = errorSpy.mock.calls.find((args) =>
          typeof args[0] === 'string' && args[0].includes('not-a-valid-type'),
        )
        expect(rejectionLog).toBeDefined()
      } finally {
        parseSpy.mockRestore()
        errorSpy.mockRestore()
      }
    })
  })

  describe('error handling', () => {
    it('throws when the LLM client throws', async () => {
      const client: LlmClient = {
        generate: vi.fn().mockRejectedValue(new Error('Network error')),
      }

      await expect(runObservation(makeParams({ llmClient: client }))).rejects.toThrow('Network error')
    })

    it('wraps the LLM error and preserves the original as cause', async () => {
      const originalError = new Error('timeout')
      const client: LlmClient = {
        generate: vi.fn().mockRejectedValue(originalError),
      }

      const err = await runObservation(makeParams({ llmClient: client })).catch((e) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err.cause).toBe(originalError)
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
    it('logs token usage via console.log (not console.warn or console.error)', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await runObservation(makeParams())

        const tokenLog = logSpy.mock.calls.find((args) =>
          typeof args[0] === 'string' && args[0].includes('[omg] Observer: tokens used'),
        )
        expect(tokenLog).toBeDefined()

        // Must NOT appear on warn or error
        const tokenWarn = warnSpy.mock.calls.find((args) =>
          typeof args[0] === 'string' && (args[0] as string).includes('tokens used'),
        )
        expect(tokenWarn).toBeUndefined()

        const tokenError = errorSpy.mock.calls.find((args) =>
          typeof args[0] === 'string' && (args[0] as string).includes('tokens used'),
        )
        expect(tokenError).toBeUndefined()
      } finally {
        logSpy.mockRestore()
        warnSpy.mockRestore()
        errorSpy.mockRestore()
      }
    })
  })

  describe('LLM error context', () => {
    it('includes messageCount and nodeIndexSize in the error message', async () => {
      const client: LlmClient = {
        generate: vi.fn().mockRejectedValue(new Error('timeout')),
      }

      const messages = [
        { role: 'user' as const, content: 'msg 1' },
        { role: 'assistant' as const, content: 'msg 2' },
      ]
      const index = [{ id: 'omg/project/x', description: 'X' }]

      const err = await runObservation(
        makeParams({ llmClient: client, unobservedMessages: messages, existingNodeIndex: index }),
      ).catch((e) => e)

      expect(err.message).toContain('messageCount: 2')
      expect(err.message).toContain('nodeIndexSize: 1')
    })
  })
})
