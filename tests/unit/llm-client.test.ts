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

  describe('maxTokens validation', () => {
    it('throws before calling generateFn when maxTokens is zero', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue(RESPONSE)
      const client = createLlmClient('test-model', generateFn)

      await expect(client.generate({ ...PARAMS, maxTokens: 0 })).rejects.toThrow(
        'maxTokens must be a positive integer',
      )
      expect(generateFn).not.toHaveBeenCalled()
    })

    it('throws before calling generateFn when maxTokens is negative', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue(RESPONSE)
      const client = createLlmClient('test-model', generateFn)

      await expect(client.generate({ ...PARAMS, maxTokens: -1 })).rejects.toThrow(
        'maxTokens must be a positive integer',
      )
    })

    it('throws before calling generateFn when maxTokens is a float', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue(RESPONSE)
      const client = createLlmClient('test-model', generateFn)

      await expect(client.generate({ ...PARAMS, maxTokens: 1.5 })).rejects.toThrow(
        'maxTokens must be a positive integer',
      )
    })

    it('includes the model name in the maxTokens validation error', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue(RESPONSE)
      const client = createLlmClient('openai/gpt-4o', generateFn)

      await expect(client.generate({ ...PARAMS, maxTokens: 0 })).rejects.toThrow(
        '(model: openai/gpt-4o)',
      )
    })
  })

  describe('token count validation', () => {
    it('throws when generateFn returns negative inputTokens', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue({
        content: 'ok',
        usage: { inputTokens: -1, outputTokens: 5 },
      })
      const client = createLlmClient('test-model', generateFn)

      await expect(client.generate(PARAMS)).rejects.toThrow('negative token counts')
    })

    it('throws when generateFn returns negative outputTokens', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue({
        content: 'ok',
        usage: { inputTokens: 10, outputTokens: -1 },
      })
      const client = createLlmClient('test-model', generateFn)

      await expect(client.generate(PARAMS)).rejects.toThrow('negative token counts')
    })

    it('accepts zero token counts (e.g. cached responses)', async () => {
      const generateFn = vi.fn<GenerateFn>().mockResolvedValue({
        content: 'ok',
        usage: { inputTokens: 0, outputTokens: 0 },
      })
      const client = createLlmClient('test-model', generateFn)

      await expect(client.generate(PARAMS)).resolves.toMatchObject({ content: 'ok' })
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

    it('wraps a null throwable without throwing itself', async () => {
      const generateFn = vi.fn<GenerateFn>().mockRejectedValue(null)
      const client = createLlmClient('test-model', generateFn)

      await expect(client.generate(PARAMS)).rejects.toThrow(
        'LLM call failed (model: test-model): null',
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
