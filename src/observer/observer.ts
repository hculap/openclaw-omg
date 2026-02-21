/**
 * Observer orchestrator.
 *
 * Coordinates the full observation cycle: prompt building → LLM call → parsing → validation.
 * Never throws — all error paths return an empty ObserverOutput.
 */

import type { ObserverOutput, ObservationParams } from '../types.js'
import { isNodeType } from '../types.js'
import { buildObserverSystemPrompt, buildObserverUserPrompt } from './prompts.js'
import { parseObserverOutput } from './parser.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMPTY_OUTPUT: ObserverOutput = {
  operations: [],
  nowUpdate: null,
  mocUpdates: [],
}

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
 *   2. Build system and user prompts.
 *   3. Call the LLM client.
 *   4. Parse the response into ObserverOutput.
 *   5. Post-validate operations (belt-and-suspenders type check).
 *   6. Return the validated output.
 *
 * Never throws. Returns an empty ObserverOutput on any error path.
 */
export async function runObservation(params: ObservationParams): Promise<ObserverOutput> {
  const { unobservedMessages, existingNodeIndex, nowNode, llmClient, sessionContext } = params

  if (unobservedMessages.length === 0) {
    return { ...EMPTY_OUTPUT }
  }

  const system = buildObserverSystemPrompt()
  const user = buildObserverUserPrompt({
    existingNodeIndex,
    nowNode,
    messages: unobservedMessages,
    sessionContext,
  })

  let response: Awaited<ReturnType<typeof llmClient.generate>>
  try {
    response = await llmClient.generate({ system, user, maxTokens: OBSERVER_MAX_TOKENS })
  } catch (err) {
    console.error('[omg] Observer: LLM call failed —', err instanceof Error ? err.message : String(err))
    return { ...EMPTY_OUTPUT }
  }

  console.error(
    `[omg] Observer: tokens used — input: ${response.usage.inputTokens}, output: ${response.usage.outputTokens}`,
  )

  const output = parseObserverOutput(response.content)

  // Belt-and-suspenders: filter any operations whose node type slipped through
  // the parser's own validation (e.g. due to upstream parser bugs).
  const validatedOperations = output.operations.filter((op) =>
    isNodeType(op.frontmatter.type),
  )

  return {
    ...output,
    operations: validatedOperations,
  }
}
