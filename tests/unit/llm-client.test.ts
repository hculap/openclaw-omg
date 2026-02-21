import { describe, it, expect, vi } from 'vitest'
import { createLlmClient } from '../../src/llm/client.js'
import type { LlmGenerateParams, LlmResponse, GenerateFn } from '../../src/llm/client.js'

const PARAMS: LlmGenerateParams = {
  system: 'You are a helpful assistant.',
  user: 'Say hello.',
  maxTokens: 512,
}

const RESPONSE: LlmResponse = {
  content: 'Hello!',
  usage: { inputTokens: 10, outputTokens: 5 },
}

describe('createLlmClient', () => {
  describe('successful generation', () => {
    it('calls generateFn with the exact params provided', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue(RESPONSE)
      const client = createLlmClient('test-model', generateFn)

      await client.generate(PARAMS)

      expect(generateFn).toHaveBeenCalledOnce()
      expect(generateFn).toHaveBeenCalledWith(PARAMS)
    })

    it('returns the content from generateFn unchanged', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue(RESPONSE)
      const client = createLlmClient('test-model', generateFn)

      const result = await client.generate(PARAMS)

      expect(result.content).toBe('Hello!')
    })

    it('preserves token usage from generateFn response', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue(RESPONSE)
      const client = createLlmClient('test-model', generateFn)

      const result = await client.generate(PARAMS)

      expect(result.usage.inputTokens).toBe(10)
      expect(result.usage.outputTokens).toBe(5)
    })

    it('works with different model names', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue(RESPONSE)
      const client = createLlmClient('anthropic/claude-3-5-haiku', generateFn)

      const result = await client.generate(PARAMS)
      expect(result.content).toBe('Hello!')
    })

    it('forwards all three params (system, user, maxTokens) to generateFn', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue(RESPONSE)
      const client = createLlmClient('test-model', generateFn)

      const customParams: LlmGenerateParams = {
        system: 'SYSTEM',
        user: 'USER',
        maxTokens: 4096,
      }
      await client.generate(customParams)

      expect(generateFn).toHaveBeenCalledWith(customParams)
    })
  })

  describe('error wrapping', () => {
    it('wraps an Error thrown by generateFn with the model name in the message', async () => {
      const originalError = new Error('Network timeout')
      const generateFn = vi.fn<GenerateFn>().mockRejectedValue(originalError)
      const client = createLlmClient('openai/gpt-4o', generateFn)

      await expect(client.generate(PARAMS)).rejects.toThrow(
        'LLM call failed (model: openai/gpt-4o): Network timeout',
      )
    })

    it('wraps a non-Error thrown by generateFn (string) with the model name', async () => {
      const generateFn = vi.fn<GenerateFn>().mockRejectedValue('raw string error')
      const client = createLlmClient('test-model', generateFn)

      await expect(client.generate(PARAMS)).rejects.toThrow(
        'LLM call failed (model: test-model): raw string error',
      )
    })

    it('preserves the original error as cause', async () => {
      const originalError = new Error('upstream failure')
      const generateFn = vi.fn<GenerateFn>().mockRejectedValue(originalError)
      const client = createLlmClient('test-model', generateFn)

      let caught: unknown
      try {
        await client.generate(PARAMS)
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).cause).toBe(originalError)
    })

    it('includes the model name exactly as provided in the error message', async () => {
      const generateFn = vi.fn<GenerateFn>().mockRejectedValue(new Error('fail'))
      const client = createLlmClient('anthropic/claude-sonnet-4-6', generateFn)

      await expect(client.generate(PARAMS)).rejects.toThrow(
        '(model: anthropic/claude-sonnet-4-6)',
      )
    })
  })
})
