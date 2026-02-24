/**
 * Gateway-local LLM client — calls the OpenClaw gateway's OpenAI-compatible
 * `/v1/chat/completions` endpoint instead of reaching out to external APIs.
 *
 * This routes all LLM requests through OpenClaw's own model providers and
 * auth infrastructure, so the plugin does not need its own API keys.
 *
 * Requires `gateway.http.endpoints.chatCompletions.enabled: true` in the
 * gateway config.
 *
 * Error types thrown:
 *   - `RateLimitError`         — HTTP 429, rate-limit body, or non-JSON 200 (overloaded)
 *   - `GatewayUnreachableError` — network-level failures (ECONNREFUSED, etc.)
 *   - `Error`                  — other HTTP errors (4xx/5xx not rate-limit related)
 */

import type { LlmGenerateParams, LlmResponse } from './client.js'
import { RateLimitError, GatewayUnreachableError, classifyGatewayError } from './errors.js'

interface OpenAiMessage {
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: string
}

interface OpenAiUsage {
  readonly prompt_tokens: number
  readonly completion_tokens: number
}

interface OpenAiResponse {
  readonly choices: ReadonlyArray<{
    readonly message: { readonly content: string }
  }>
  readonly usage: OpenAiUsage
}

export interface GatewayCompletionsOptions {
  /** Gateway port (default 18789). */
  readonly port?: number
  /** Gateway auth token from gateway.auth.token config. */
  readonly authToken?: string
  /** Model override — if omitted, the gateway uses its default model. */
  readonly model?: string
  /**
   * Per-request timeout in milliseconds (default 120 000 = 2 minutes).
   * Throws GatewayUnreachableError on timeout so callers can retry or fail fast.
   */
  readonly timeoutMs?: number
}

/**
 * Creates a generate function that calls the local OpenClaw gateway's
 * `/v1/chat/completions` endpoint.
 *
 * This is the only supported LLM path: requests go through the gateway's
 * model routing and auth, using the same providers configured for agent sessions.
 */
export function createGatewayCompletionsGenerateFn(
  options: GatewayCompletionsOptions = {}
): (params: LlmGenerateParams) => Promise<LlmResponse> {
  const port = options.port ?? 18789
  const url = `http://127.0.0.1:${port}/v1/chat/completions`
  const { authToken, model, timeoutMs = 120_000 } = options

  return async (params: LlmGenerateParams): Promise<LlmResponse> => {
    const messages: OpenAiMessage[] = [
      { role: 'system', content: params.system },
      { role: 'user', content: params.user },
    ]

    const body: Record<string, unknown> = {
      messages,
      max_tokens: params.maxTokens,
    }
    if (model) {
      body['model'] = model
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`
    }

    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new GatewayUnreachableError(`Gateway /v1/chat/completions unreachable: ${msg}`)
    }

    if (response.status === 429) {
      const errorText = await response.text().catch(() => 'rate limit exceeded')
      throw new RateLimitError(`Gateway rate limit (429): ${errorText.slice(0, 200)}`)
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error')
      if (classifyGatewayError(errorText) === 'rate-limit') {
        throw new RateLimitError(
          `Gateway /v1/chat/completions rate limited (${response.status}): ${errorText.slice(0, 200)}`
        )
      }
      throw new Error(`Gateway /v1/chat/completions error (${response.status}): ${errorText}`)
    }

    const rawText = await response.text()

    // Gateway-level error responses embedded in 200 OK bodies.
    // Classify by body text so that connectivity errors (e.g. "Connection error:
    // upstream refused") throw GatewayUnreachableError, not RateLimitError.
    if (rawText.startsWith('⚠️') || rawText.startsWith('Connection error')) {
      if (classifyGatewayError(rawText) === 'unreachable') {
        throw new GatewayUnreachableError(`Gateway error response: ${rawText.slice(0, 200)}`)
      }
      throw new RateLimitError(`Gateway error response: ${rawText.slice(0, 200)}`)
    }

    let data: OpenAiResponse
    try {
      data = JSON.parse(rawText) as OpenAiResponse
    } catch {
      // Non-JSON in a 200 response usually means the gateway is overloaded
      throw new RateLimitError(
        `Gateway /v1/chat/completions returned non-JSON body: ${rawText.slice(0, 200)}`
      )
    }

    const firstChoice = data.choices[0]
    if (!firstChoice) {
      throw new Error(`Gateway /v1/chat/completions returned empty choices array`)
    }

    return {
      content: firstChoice.message.content,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
    }
  }
}
