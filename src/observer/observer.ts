/**
 * Observer orchestrator.
 *
 * Exports two functions:
 *  - `runExtract`     — the new stateless extract phase (always runs)
 *  - `runMerge`       — the conditional merge decision (only when neighbors found)
 *  - `runObservation` — backward-compat wrapper calling runExtract internally
 *
 * LLM errors propagate to the caller; parse errors return an empty output.
 */

import type { ObserverOutput, ObservationParams, ExtractOutput, ExtractParams, MergeAction } from '../types.js'
import { emitMetric } from '../metrics/index.js'
import { isNodeType, candidateToUpsertOperation } from '../types.js'
import { buildObserverSystemPrompt, buildObserverUserPrompt, buildExtractSystemPrompt, buildExtractUserPrompt } from './prompts.js'
import { parseObserverOutput, EMPTY_OUTPUT, parseExtractOutput, parseExtractOutputWithDiagnostics } from './parser.js'
import type { ParserDiagnostics } from './parser.js'
import { buildMergeSystemPrompt, buildMergeUserPrompt, parseMergeOutput } from './merge-prompt.js'
import type { ScoredMergeTarget } from '../types.js'
import type { ExtractCandidate } from '../types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum tokens to request from the LLM for the extract response. */
export const EXTRACT_MAX_TOKENS = 4096

/** Maximum tokens to request from the LLM for the merge decision response. */
const MERGE_MAX_TOKENS = 1024

/** @deprecated Kept for backward compat — use EXTRACT_MAX_TOKENS. */
const OBSERVER_MAX_TOKENS = EXTRACT_MAX_TOKENS

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Extract result with full parser diagnostics and truncation flag. */
export interface ExtractResultWithDiagnostics {
  readonly output: ExtractOutput
  readonly diagnostics: ParserDiagnostics
  readonly truncated: boolean
}

// ---------------------------------------------------------------------------
// runExtractWithDiagnostics
// ---------------------------------------------------------------------------

/**
 * Runs the Extract phase and returns full parser diagnostics alongside the output.
 * Used by callers (e.g. bootstrap) that need programmatic access to rejection details.
 *
 * Throws if the LLM call fails.
 */
export async function runExtractWithDiagnostics(params: ExtractParams): Promise<ExtractResultWithDiagnostics> {
  const { unobservedMessages, nowNode, llmClient, sessionContext, maxOutputTokens } = params

  if (unobservedMessages.length === 0) {
    return {
      output: { candidates: [], nowPatch: null, mocUpdates: [] },
      diagnostics: { totalCandidates: 0, accepted: 0, rejected: [] },
      truncated: false,
    }
  }

  const system = buildExtractSystemPrompt()
  const user = buildExtractUserPrompt({
    nowNode,
    messages: unobservedMessages,
    sessionContext,
  })

  const effectiveMaxTokens = maxOutputTokens ?? EXTRACT_MAX_TOKENS

  let response: Awaited<ReturnType<typeof llmClient.generate>>
  try {
    response = await llmClient.generate({ system, user, maxTokens: effectiveMaxTokens })
  } catch (err) {
    throw new Error(
      `[omg] Extract: LLM call failed (messageCount: ${unobservedMessages.length}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  console.log(
    `[omg] Extract: tokens used — input: ${response.usage.inputTokens}, output: ${response.usage.outputTokens}`,
  )

  const truncated = effectiveMaxTokens > 0 && response.usage.outputTokens >= Math.floor(effectiveMaxTokens * 0.95)
  if (truncated) {
    console.warn(
      `[omg] Extract: response may be truncated — used ${response.usage.outputTokens}/${effectiveMaxTokens} output tokens (${Math.round((response.usage.outputTokens / effectiveMaxTokens) * 100)}%). Consider reducing batchCharBudget if bootstrap chunks are being lost.`,
    )
  }

  const { output, diagnostics } = parseExtractOutputWithDiagnostics(response.content)

  if (diagnostics.rejected.length > 0) {
    console.warn(
      `[omg] Extract: ${diagnostics.accepted}/${diagnostics.totalCandidates} candidates survived parsing. ` +
      `Rejected: ${diagnostics.rejected.map((r) => r.reason).join('; ')}`,
    )
  }

  // Belt-and-suspenders: re-filter candidates with invalid types
  const validatedCandidates = output.candidates.filter((c) => {
    if (isNodeType(c.type)) return true
    console.error(
      `[omg] Extract: post-validation rejected candidate with unknown type "${String(c.type)}" — this indicates a parser bug`,
    )
    return false
  })

  // Emit extract metrics
  emitMetric({
    stage: 'extract',
    timestamp: new Date().toISOString(),
    data: {
      stage: 'extract',
      candidatesCount: diagnostics.totalCandidates,
      parserRejectCount: diagnostics.rejected.length,
      parserRejectReasons: diagnostics.rejected.map((r) => r.reason),
      writtenNodesCount: validatedCandidates.length,
    },
  })

  return {
    output: { ...output, candidates: validatedCandidates },
    diagnostics,
    truncated,
  }
}

// ---------------------------------------------------------------------------
// runExtract
// ---------------------------------------------------------------------------

/**
 * Runs the Extract phase: reads messages and extracts knowledge candidates.
 *
 * Flow:
 *   1. Short-circuit if there are no unobserved messages.
 *   2. Build extract system and user prompts.
 *   3. Call the LLM client (errors propagate to the caller).
 *   4. Parse the response into ExtractOutput.
 *   5. Post-validate candidate types via isNodeType.
 *   6. Return the validated output.
 *
 * Returns an empty ExtractOutput when messages is empty.
 * Throws if the LLM call fails.
 */
export async function runExtract(params: ExtractParams): Promise<ExtractOutput> {
  const { unobservedMessages, nowNode, llmClient, sessionContext, maxOutputTokens } = params

  if (unobservedMessages.length === 0) {
    return {
      candidates: [],
      nowPatch: null,
      mocUpdates: [],
    }
  }

  const system = buildExtractSystemPrompt()
  const user = buildExtractUserPrompt({
    nowNode,
    messages: unobservedMessages,
    sessionContext,
  })

  const effectiveMaxTokens = maxOutputTokens ?? EXTRACT_MAX_TOKENS

  let response: Awaited<ReturnType<typeof llmClient.generate>>
  try {
    response = await llmClient.generate({ system, user, maxTokens: effectiveMaxTokens })
  } catch (err) {
    throw new Error(
      `[omg] Extract: LLM call failed (messageCount: ${unobservedMessages.length}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  console.log(
    `[omg] Extract: tokens used — input: ${response.usage.inputTokens}, output: ${response.usage.outputTokens}`,
  )

  if (effectiveMaxTokens > 0 && response.usage.outputTokens >= Math.floor(effectiveMaxTokens * 0.95)) {
    console.warn(
      `[omg] Extract: response may be truncated — used ${response.usage.outputTokens}/${effectiveMaxTokens} output tokens (${Math.round((response.usage.outputTokens / effectiveMaxTokens) * 100)}%). Consider reducing batchCharBudget if bootstrap chunks are being lost.`,
    )
  }

  const { output, diagnostics } = parseExtractOutputWithDiagnostics(response.content)

  if (diagnostics.rejected.length > 0) {
    console.warn(
      `[omg] Extract: ${diagnostics.accepted}/${diagnostics.totalCandidates} candidates survived parsing. ` +
      `Rejected: ${diagnostics.rejected.map((r) => r.reason).join('; ')}`,
    )
  }

  // Belt-and-suspenders: re-filter candidates with invalid types
  const validatedCandidates = output.candidates.filter((c) => {
    if (isNodeType(c.type)) return true
    console.error(
      `[omg] Extract: post-validation rejected candidate with unknown type "${String(c.type)}" — this indicates a parser bug`,
    )
    return false
  })

  return {
    ...output,
    candidates: validatedCandidates,
  }
}

// ---------------------------------------------------------------------------
// runMerge
// ---------------------------------------------------------------------------

/**
 * Runs the Merge phase for a single candidate against its scored neighbors.
 *
 * - If no neighbors → return keep_separate immediately (no LLM call)
 * - Otherwise call the LLM to decide merge/alias/keep_separate
 * - Defaults to keep_separate on any parse failure
 *
 * Throws if the LLM call fails.
 */
export async function runMerge(
  candidate: ExtractCandidate,
  neighbors: readonly ScoredMergeTarget[],
  llmClient: { generate: (p: { system: string; user: string; maxTokens: number }) => Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }> }
): Promise<MergeAction> {
  if (neighbors.length === 0) {
    return { action: 'keep_separate' }
  }

  const system = buildMergeSystemPrompt()
  const user = buildMergeUserPrompt(candidate, neighbors)

  let response: { content: string; usage: { inputTokens: number; outputTokens: number } }
  try {
    response = await llmClient.generate({ system, user, maxTokens: MERGE_MAX_TOKENS })
  } catch (err) {
    throw new Error(
      `[omg] Merge: LLM call failed (candidate: ${candidate.canonicalKey}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  }

  console.log(
    `[omg] Merge: tokens used — input: ${response.usage.inputTokens}, output: ${response.usage.outputTokens}`,
  )

  return parseMergeOutput(response.content)
}

// ---------------------------------------------------------------------------
// runObservation (backward compat wrapper)
// ---------------------------------------------------------------------------

/**
 * Compat wrapper: runs the Extract phase and converts the output to
 * the legacy ObserverOutput format.
 *
 * @deprecated Use `runExtract` directly in new code. This wrapper is kept
 *   for bootstrap and other callers that depend on `ObserverOutput`.
 */
export async function runObservation(params: ObservationParams): Promise<ObserverOutput> {
  const { unobservedMessages, nowNode, config, llmClient, sessionContext, maxOutputTokens } = params

  if (unobservedMessages.length === 0) {
    return { ...EMPTY_OUTPUT }
  }

  // Prefer the new extract path — same system/user prompt logic, new parser
  const extractParams: ExtractParams = {
    unobservedMessages,
    nowNode,
    config,
    llmClient,
    sessionContext,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  }

  let extractResult: ExtractResultWithDiagnostics
  try {
    extractResult = await runExtractWithDiagnostics(extractParams)
  } catch (err) {
    // Re-throw with the legacy error prefix so callers can detect format
    throw new Error(
      `[omg] Observer: LLM call failed (messageCount: ${unobservedMessages.length}): ${err instanceof Error ? err.message : String(err)}`,
      { cause: err instanceof Error && err.cause ? err.cause : err },
    )
  }

  const extractOutput = extractResult.output

  // Convert ExtractCandidates → ObserverOperations
  const operations = extractOutput.candidates.map(candidateToUpsertOperation)

  // Post-validate types (belt-and-suspenders, same as original runObservation)
  const validatedOperations = operations.filter((op) => {
    const type = op.kind === 'upsert' ? op.type : op.frontmatter.type
    if (isNodeType(type)) return true
    console.error(
      `[omg] Observer: post-validation rejected operation with unknown type "${String(type)}" — this indicates a parser bug`,
    )
    return false
  })

  // Convert NowPatch → legacy now-update string
  const nowUpdate = extractOutput.nowPatch !== null
    ? renderNowPatchAsLegacy(extractOutput.nowPatch)
    : null

  return {
    operations: validatedOperations,
    nowUpdate,
    mocUpdates: extractOutput.mocUpdates,
    diagnostics: {
      totalCandidates: extractResult.diagnostics.totalCandidates,
      accepted: extractResult.diagnostics.accepted,
      rejectedReasons: extractResult.diagnostics.rejected.map((r) => r.reason),
    },
    truncated: extractResult.truncated,
  }
}

// ---------------------------------------------------------------------------
// Legacy compat: render NowPatch as free-form markdown string
// ---------------------------------------------------------------------------

/**
 * Converts a structured NowPatch into a legacy markdown string
 * for backward compatibility with the ObserverOutput.nowUpdate field.
 */
function renderNowPatchAsLegacy(patch: { focus: string; openLoops: readonly string[]; suggestedLinks: readonly string[] }): string {
  const parts: string[] = []

  parts.push(`## Current Focus\n${patch.focus}`)

  if (patch.openLoops.length > 0) {
    parts.push(`## Open Loops\n${patch.openLoops.map((l) => `- ${l}`).join('\n')}`)
  }

  if (patch.suggestedLinks.length > 0) {
    parts.push(`## Related\n${patch.suggestedLinks.map((l) => `- ${l}`).join('\n')}`)
  }

  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Legacy runObservation implementation (kept for reference, not used)
// ---------------------------------------------------------------------------

/**
 * @internal Original implementation preserved for reference during the
 * transition. Not exported.
 */
async function _legacyRunObservation(params: ObservationParams): Promise<ObserverOutput> {
  const { unobservedMessages, nowNode, llmClient, sessionContext } = params

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

  const output = parseObserverOutput(response.content)

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

// Suppress "declared but never used" — this is an intentional reference copy
void _legacyRunObservation
