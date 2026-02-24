import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createGatewayCompletionsGenerateFn } from '../../../src/llm/gateway-completions.js'
import { RateLimitError, GatewayUnreachableError } from '../../../src/llm/errors.js'

const DEFAULT_PARAMS = { system: 'You are helpful.', user: 'Hello', maxTokens: 1000 }

function makeOkResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

function makeErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: () => Promise.resolve(body),
  } as unknown as Response
}

function makeSuccessBody(content: string): unknown {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createGatewayCompletionsGenerateFn — happy path', () => {
  it('returns LlmResponse with content and usage on success', async () => {
    vi.mocked(fetch).mockResolvedValue(makeOkResponse(makeSuccessBody('Hello!')))

    const generate = createGatewayCompletionsGenerateFn({ port: 18789, authToken: 'tok' })
    const result = await generate(DEFAULT_PARAMS)

    expect(result.content).toBe('Hello!')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)
  })

  it('sends Authorization header when authToken is provided', async () => {
    vi.mocked(fetch).mockResolvedValue(makeOkResponse(makeSuccessBody('ok')))

    const generate = createGatewayCompletionsGenerateFn({ port: 18789, authToken: 'my-token' })
    await generate(DEFAULT_PARAMS)

    const callArgs = vi.mocked(fetch).mock.calls[0]!
    const headers = callArgs[1]?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer my-token')
  })
})

describe('createGatewayCompletionsGenerateFn — rate limit errors', () => {
  it('throws RateLimitError on HTTP 429', async () => {
    vi.mocked(fetch).mockResolvedValue(makeErrorResponse(429, 'Rate limit exceeded'))

    const generate = createGatewayCompletionsGenerateFn({ port: 18789 })
    await expect(generate(DEFAULT_PARAMS)).rejects.toBeInstanceOf(RateLimitError)
  })

  it('throws RateLimitError when non-OK body contains rate limit pattern', async () => {
    vi.mocked(fetch).mockResolvedValue(makeErrorResponse(503, 'too many requests, please retry'))

    const generate = createGatewayCompletionsGenerateFn({ port: 18789 })
    await expect(generate(DEFAULT_PARAMS)).rejects.toBeInstanceOf(RateLimitError)
  })

  it('throws RateLimitError for body starting with ⚠️ (200 OK gateway error)', async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeOkResponse('⚠️ API rate limit reached. Please try again later.')
    )

    const generate = createGatewayCompletionsGenerateFn({ port: 18789 })
    await expect(generate(DEFAULT_PARAMS)).rejects.toBeInstanceOf(RateLimitError)
  })

  it('throws RateLimitError for body starting with "Connection error"', async () => {
    vi.mocked(fetch).mockResolvedValue(makeOkResponse('Connection error: upstream timeout'))

    const generate = createGatewayCompletionsGenerateFn({ port: 18789 })
    await expect(generate(DEFAULT_PARAMS)).rejects.toBeInstanceOf(RateLimitError)
  })

  it('throws RateLimitError when response is 200 but body is non-JSON (overloaded gateway)', async () => {
    vi.mocked(fetch).mockResolvedValue(makeOkResponse('Internal server error'))

    const generate = createGatewayCompletionsGenerateFn({ port: 18789 })
    await expect(generate(DEFAULT_PARAMS)).rejects.toBeInstanceOf(RateLimitError)
  })
})

describe('createGatewayCompletionsGenerateFn — unreachable errors', () => {
  it('throws GatewayUnreachableError on ECONNREFUSED', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:18789'))

    const generate = createGatewayCompletionsGenerateFn({ port: 18789 })
    await expect(generate(DEFAULT_PARAMS)).rejects.toBeInstanceOf(GatewayUnreachableError)
  })

  it('throws GatewayUnreachableError on fetch failed', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('fetch failed'))

    const generate = createGatewayCompletionsGenerateFn({ port: 18789 })
    await expect(generate(DEFAULT_PARAMS)).rejects.toBeInstanceOf(GatewayUnreachableError)
  })

  it('throws GatewayUnreachableError on ETIMEDOUT', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ETIMEDOUT'))

    const generate = createGatewayCompletionsGenerateFn({ port: 18789 })
    await expect(generate(DEFAULT_PARAMS)).rejects.toBeInstanceOf(GatewayUnreachableError)
  })
})

describe('createGatewayCompletionsGenerateFn — other HTTP errors', () => {
  it('throws generic Error on non-rate-limit non-OK response', async () => {
    vi.mocked(fetch).mockResolvedValue(makeErrorResponse(500, 'Internal server error'))

    const generate = createGatewayCompletionsGenerateFn({ port: 18789 })
    await expect(generate(DEFAULT_PARAMS)).rejects.toThrow('Gateway /v1/chat/completions error (500)')
    await expect(generate(DEFAULT_PARAMS)).rejects.not.toBeInstanceOf(RateLimitError)
  })

  it('throws generic Error when choices array is empty', async () => {
    vi.mocked(fetch).mockResolvedValue(
      makeOkResponse({ choices: [], usage: { prompt_tokens: 0, completion_tokens: 0 } })
    )

    const generate = createGatewayCompletionsGenerateFn({ port: 18789 })
    await expect(generate(DEFAULT_PARAMS)).rejects.toThrow('empty choices array')
  })
})
