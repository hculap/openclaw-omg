/**
 * Direct Anthropic Messages API client using Node's built-in fetch.
 *
 * Used as a fallback when the host's `api.generate` is not available.
 * No external SDK dependency — relies on Node 22+ built-in fetch.
 */

import type { LlmGenerateParams, LlmResponse } from './client.js'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-sonnet-4-20250514'

interface AnthropicMessage {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

interface AnthropicUsage {
  readonly input_tokens: number
  readonly output_tokens: number
}

interface AnthropicResponse {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly usage: AnthropicUsage
}

export interface DirectAnthropicOptions {
  readonly apiKey: string
  readonly model?: string
}

/**
 * Creates a generate function that calls the Anthropic Messages API directly.
 */
export function createDirectAnthropicGenerateFn(
  options: DirectAnthropicOptions
): (params: LlmGenerateParams) => Promise<LlmResponse> {
  const { apiKey, model = DEFAULT_MODEL } = options

  return async (params: LlmGenerateParams): Promise<LlmResponse> => {
    const messages: AnthropicMessage[] = [
      { role: 'user', content: params.user },
    ]

    const body = JSON.stringify({
      model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages,
    })

    // OAuth tokens (sk-ant-oat*) use Bearer auth; regular API keys use x-api-key header
    const isOAuthToken = apiKey.startsWith('sk-ant-oat')
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    }
    if (isOAuthToken) {
      headers['Authorization'] = `Bearer ${apiKey}`
    } else {
      headers['x-api-key'] = apiKey
    }

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers,
      body,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error')
      throw new Error(
        `Anthropic API error (${response.status}): ${errorText}`
      )
    }

    const data = (await response.json()) as AnthropicResponse

    const content = data.content
      .filter((block) => block.type === 'text' && block.text !== undefined)
      .map((block) => block.text!)
      .join('')

    return {
      content,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
    }
  }
}
