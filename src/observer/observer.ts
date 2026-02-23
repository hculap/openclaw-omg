/**
 * Observer orchestrator.
 *
 * Coordinates the full observation cycle: prompt building → LLM call → parsing → validation.
 * LLM errors propagate to the caller; parse errors return an empty ObserverOutput.
 */

import type { ObserverOutput, ObservationParams } from '../types.js'
import { isNodeType } from '../types.js'
import { buildObserverSystemPrompt, buildObserverUserPrompt } from './prompts.js'
import { parseObserverOutput, EMPTY_OUTPUT } from './parser.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum tokens to request from the LLM for the observation response. */
const OBSERVER_MAX_TOKENS = 4096

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs a single observation cycle against the provided messages.
 *
 * Flow:
 *   1. Short-circuit if there are no unobserved messages.
 *   2. Build system and user prompts (no node index — dedup is deterministic).
 *   3. Call the LLM client (errors propagate to the caller).
 *   4. Parse the response into ObserverOutput.
 *   5. Post-validate operations: re-filter any whose node type fails `isNodeType`,
 *      defending against parser bugs that might slip an invalid type through.
 *   6. Return the validated output.
 *
 * Returns an empty ObserverOutput when messages is empty.
 * Throws if the LLM call fails — the error is a plain {@link Error} whose message is
 * prefixed with the model name (e.g. `"LLM call failed (model: …): …"`) and whose
 * `cause` property holds the original error. Callers must catch and handle LLM errors.
 */
export async function runObservation(params: ObservationParams): Promise<ObserverOutput> {
  const { unobservedMessages, nowNode, llmClient, sessionContext } = params

  if (unobservedMessages.length === 0) {
    return { ...EMPTY_OUTPUT }
  }

  const system = buildObserverSystemPrompt()
  const user = buildObserverUserPrompt({
    nowNode,
    messages: unobservedMessages,
    sessionContext,
  })

  let response: Awaited<ReturnType<typeof llmClient.generate>>
  try {
    response = await llmClient.generate({ system, user, maxTokens: OBSERVER_MAX_TOKENS })
  } catch (err) {
    throw new Error(
      `[omg] Observer: LLM call failed (messageCount: ${unobservedMessages.length}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  console.log(
    `[omg] Observer: tokens used — input: ${response.usage.inputTokens}, output: ${response.usage.outputTokens}`,
  )
  console.error(`[omg] Observer: raw response (first 1000 chars): ${response.content.slice(0, 1000)}`)

  const output = parseObserverOutput(response.content)
  console.error(`[omg] Observer: parsed operations=${output.operations.length}, nowUpdate=${output.nowUpdate ? 'yes' : 'no'}`)

  // Belt-and-suspenders: re-filter any operation whose node type slipped through
  // the parser's own validation (e.g. due to a parser bug). Logs at error level
  // because triggering this path indicates a bug that must be investigated.
  const validatedOperations = output.operations.filter((op) => {
    const type = op.kind === 'upsert' ? op.type : op.frontmatter.type
    if (isNodeType(type)) return true
    console.error(
      `[omg] Observer: post-validation rejected operation with unknown type "${String(type)}" — this indicates a parser bug`,
    )
    return false
  })

  return {
    ...output,
    operations: validatedOperations,
  }
}
