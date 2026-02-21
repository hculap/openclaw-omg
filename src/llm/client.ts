/**
 * LLM client interface and factory for the OMG plugin.
 *
 * Uses an injected callback pattern so that the host application's model
 * resolution (auth profiles, provider selection) remains under its control.
 * The plugin entry point injects the host's generation function; for tests
 * a mock generateFn is passed directly — no SDK required.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Token usage reported by an LLM call. Both values must be >= 0. */
export interface LlmUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/** The resolved response from a single LLM generation call. */
export interface LlmResponse {
  readonly content: string
  readonly usage: LlmUsage
}

/** Parameters accepted by a generation call. */
export interface LlmGenerateParams {
  readonly system: string
  readonly user: string
  /** Must be a positive integer. Validated by {@link createLlmClient} before the call. */
  readonly maxTokens: number
}

/**
 * Injectable generation callback.
 * In production, wraps the host application's generation function which handles
 * auth, model selection, and provider routing. In tests, use a simple mock.
 */
export type GenerateFn = (params: LlmGenerateParams) => Promise<LlmResponse>

/** Client handle returned by {@link createLlmClient}. */
export interface LlmClient {
  generate(params: LlmGenerateParams): Promise<LlmResponse>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an {@link LlmClient} backed by `generateFn`.
 *
 * Validates `maxTokens` (must be a positive integer) and `LlmUsage` token
 * counts (must be >= 0) before accepting results, so callers receive a clear
 * error rather than an opaque provider rejection or a corrupted accumulator.
 *
 * Errors thrown by `generateFn` are caught and re-thrown as a new `Error`
 * whose message includes the model name, making log entries actionable.
 *
 * @param model  Model identifier, used only for error messages and logging.
 * @param generateFn  The underlying generation callback.
 */
export function createLlmClient(model: string, generateFn: GenerateFn): LlmClient {
  return {
    async generate(params: LlmGenerateParams): Promise<LlmResponse> {
      const { maxTokens } = params
      if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
        throw new Error(
          `LLM call failed (model: ${model}): maxTokens must be a positive integer, got ${maxTokens}`,
        )
      }

      let raw: LlmResponse
      try {
        raw = await generateFn(params)
      } catch (err) {
        throw new Error(
          `LLM call failed (model: ${model}): ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }

      if (raw.usage.inputTokens < 0 || raw.usage.outputTokens < 0) {
        throw new Error(
          `LLM response validation failed (model: ${model}): negative token counts (inputTokens: ${raw.usage.inputTokens}, outputTokens: ${raw.usage.outputTokens})`,
        )
      }

      return { content: raw.content, usage: raw.usage }
    },
  }
}
