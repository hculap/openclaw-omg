/**
 * Direct OpenAI Chat Completions API client using Node's built-in fetch.
 *
 * Used as a fallback when the host's `api.generate` is not available
 * and no Anthropic API key is found.
 * No external SDK dependency — relies on Node 22+ built-in fetch.
 */

import type { LlmGenerateParams, LlmResponse } from './client.js'

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions'
const DEFAULT_MODEL = 'gpt-4o-mini'

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

export interface DirectOpenAiOptions {
  readonly apiKey: string
  readonly model?: string
}

/**
 * Creates a generate function that calls the OpenAI Chat Completions API directly.
 */
export function createDirectOpenAiGenerateFn(
  options: DirectOpenAiOptions
): (params: LlmGenerateParams) => Promise<LlmResponse> {
  const { apiKey, model = DEFAULT_MODEL } = options

  return async (params: LlmGenerateParams): Promise<LlmResponse> => {
    const messages: OpenAiMessage[] = [
      { role: 'system', content: params.system },
      { role: 'user', content: params.user },
    ]

    const body = JSON.stringify({
      model,
      max_tokens: params.maxTokens,
      messages,
    })

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body,
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error')
      throw new Error(
        `OpenAI API error (${response.status}): ${errorText}`
      )
    }

    const data = (await response.json()) as OpenAiResponse

    const firstChoice = data.choices[0]
    if (!firstChoice) {
      throw new Error(`OpenAI API returned empty choices array`)
    }

    return {
      content: firstChoice.message.content,
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    }
  }
}
