/**
 * Gateway-local LLM client — calls the OpenClaw gateway's OpenAI-compatible
 * `/v1/chat/completions` endpoint instead of reaching out to external APIs.
 *
 * This routes all LLM requests through OpenClaw's own model providers and
 * auth infrastructure, so the plugin does not need its own API keys.
 *
 * Requires `gateway.http.endpoints.chatCompletions.enabled: true` in the
 * gateway config.
 */

import type { LlmGenerateParams, LlmResponse } from './client.js'

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
}

/**
 * Creates a generate function that calls the local OpenClaw gateway's
 * `/v1/chat/completions` endpoint.
 *
 * This is the preferred LLM path: requests go through the gateway's model
 * routing and auth, using the same providers configured for agent sessions.
 */
export function createGatewayCompletionsGenerateFn(
  options: GatewayCompletionsOptions = {}
): (params: LlmGenerateParams) => Promise<LlmResponse> {
  const port = options.port ?? 18789
  const url = `http://127.0.0.1:${port}/v1/chat/completions`
  const { authToken, model } = options

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

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error')
      throw new Error(
        `Gateway /v1/chat/completions error (${response.status}): ${errorText}`
      )
    }

    const rawText = await response.text()
    let data: OpenAiResponse
    try {
      data = JSON.parse(rawText) as OpenAiResponse
    } catch {
      throw new Error(`Gateway /v1/chat/completions returned non-JSON body: ${rawText.slice(0, 200)}`)
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
