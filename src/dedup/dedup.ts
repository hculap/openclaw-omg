/**
 * Main orchestrator for the semantic dedup subsystem.
 *
 * Runs a 3-pass dedup cycle:
 *   Pass 0 — Incremental scope (nodes updated since lastDedupAt)
 *   Pass 1 — Heuristic candidate clustering (registry-only, zero disk reads)
 *   Pass 2 — LLM confirmation of merge plans (single call, compact metadata only)
 *
 * Then applies merge plans: patch keeper, archive losers, append audit log.
 * State (lastDedupAt) is only advanced on full success — fail closed on LLM error.
 */
import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import type { DedupRunResult } from './types.js'
import { dedupLlmResponseSchema } from './types.js'
import { getRegistryEntries, getNodeFilePaths } from '../graph/registry.js'
import { generateCandidatePairs, clusterCandidates } from './candidates.js'
import { buildDedupSystemPrompt, buildDedupUserPrompt } from './prompts.js'
import { executeMerge, type MergeResult } from './merge.js'
import { appendAuditEntry } from './audit.js'
import { loadDedupState, saveDedupState } from './state.js'

/** Parameters for a dedup run. */
export interface DedupParams {
  readonly omgRoot: string
  readonly config: OmgConfig
  readonly llmClient: LlmClient
}

/** Maximum tokens for the dedup LLM call. 8192 gives headroom for verbose merge plans. */
const DEDUP_MAX_TOKENS = 8192

/** Maximum LLM attempts before giving up on a dedup run (handles truncated responses). */
const DEDUP_MAX_ATTEMPTS = 2

/**
 * Runs one full dedup cycle against the graph at `omgRoot`.
 * Never throws — errors are collected in the returned result.
 */
export async function runDedup(params: DedupParams): Promise<DedupRunResult> {
  const { omgRoot, config, llmClient } = params
  const dedupConfig = config.dedup

  const errors: string[] = []
  let clustersProcessed = 0
  let mergesExecuted = 0
  let nodesArchived = 0
  let conflictsDetected = 0
  let tokensUsed = 0

  // -------------------------------------------------------------------------
  // Pass 0 — Load state + registry
  // -------------------------------------------------------------------------

  const state = await loadDedupState(omgRoot)

  let allEntries: readonly [string, import('../graph/registry.js').RegistryNodeEntry][]
  try {
    allEntries = await getRegistryEntries(omgRoot)
  } catch (err) {
    const msg = `Failed to read registry: ${err instanceof Error ? err.message : String(err)}`
    console.error('[omg] dedup:', msg)
    errors.push(msg)
    return { clustersProcessed, mergesExecuted, nodesArchived, conflictsDetected, tokensUsed, errors }
  }

  // -------------------------------------------------------------------------
  // Pass 1 — Heuristic candidate clustering (registry-only)
  // -------------------------------------------------------------------------

  const pairs = generateCandidatePairs(allEntries, state.lastDedupAt, dedupConfig)

  if (pairs.length === 0) {
    console.warn('[omg] dedup: no candidate pairs found — skipping LLM call')
    try {
      await saveDedupState(omgRoot, {
        ...state,
        lastDedupAt: new Date().toISOString(),
        runsCompleted: state.runsCompleted + 1,
      })
    } catch (err) {
      console.error('[omg] dedup: failed to save state (no-pairs path):', err)
    }
    return { clustersProcessed, mergesExecuted, nodesArchived, conflictsDetected, tokensUsed, errors }
  }

  const clusters = clusterCandidates(pairs, dedupConfig.maxClusterSize, dedupConfig.maxClustersPerRun)
  clustersProcessed = clusters.length

  // -------------------------------------------------------------------------
  // Pass 2 — LLM confirmation (with retry on parse failure)
  // -------------------------------------------------------------------------

  let mergePlans: import('./types.js').MergePlan[] | undefined

  for (let attempt = 1; attempt <= DEDUP_MAX_ATTEMPTS; attempt++) {
    let response: { content: string; usage: { inputTokens: number; outputTokens: number } }
    try {
      response = await llmClient.generate({
        system: buildDedupSystemPrompt(),
        user: buildDedupUserPrompt(clusters),
        maxTokens: DEDUP_MAX_TOKENS,
      })
    } catch (err) {
      const msg = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`
      console.error('[omg] dedup:', msg)
      errors.push(msg)
      return { clustersProcessed, mergesExecuted, nodesArchived, conflictsDetected, tokensUsed, errors }
    }

    tokensUsed += response.usage.inputTokens + response.usage.outputTokens

    // Extract JSON from the response, stripping any markdown code fence and any
    // prose the LLM may have appended after the closing fence.
    let jsonContent = response.content.trim()
    if (jsonContent.startsWith('```')) {
      // Strip opening fence line (```json, ```JSON, ```, etc.)
      const afterOpenFence = jsonContent.replace(/^```[^\n]*\n?/, '')
      // Extract up to the FIRST closing fence — ignore any rationale prose that follows
      const closingFenceIdx = afterOpenFence.indexOf('\n```')
      jsonContent = (closingFenceIdx !== -1
        ? afterOpenFence.slice(0, closingFenceIdx)
        : afterOpenFence
      ).trim()
    }
    // Fallback: if the content doesn't start with { or [, scan for the first JSON object
    if (!jsonContent.startsWith('{') && !jsonContent.startsWith('[')) {
      const jsonStart = jsonContent.indexOf('{')
      if (jsonStart !== -1) jsonContent = jsonContent.slice(jsonStart).trim()
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(jsonContent)
    } catch {
      const msg = `LLM returned non-JSON response (attempt ${attempt}/${DEDUP_MAX_ATTEMPTS}): ${response.content.slice(0, 200)}`
      if (attempt < DEDUP_MAX_ATTEMPTS) {
        console.warn('[omg] dedup:', msg, '— retrying')
        continue
      }
      console.error('[omg] dedup:', msg)
      errors.push(msg)
      return { clustersProcessed, mergesExecuted, nodesArchived, conflictsDetected, tokensUsed, errors }
    }

    const validation = dedupLlmResponseSchema.safeParse(parsed)
    if (!validation.success) {
      const msg = `LLM response failed schema validation: ${validation.error.message}`
      console.error('[omg] dedup:', msg)
      errors.push(msg)
      return { clustersProcessed, mergesExecuted, nodesArchived, conflictsDetected, tokensUsed, errors }
    }

    mergePlans = validation.data.mergePlans as import('./types.js').MergePlan[]
    break
  }

  if (mergePlans === undefined) {
    // Unreachable: loop always returns or assigns mergePlans, but satisfies TypeScript.
    const msg = 'dedup: exhausted all LLM attempts without a valid response'
    console.error('[omg] dedup:', msg)
    errors.push(msg)
    return { clustersProcessed, mergesExecuted, nodesArchived, conflictsDetected, tokensUsed, errors }
  }

  // -------------------------------------------------------------------------
  // Merge execution
  // -------------------------------------------------------------------------

  if (mergePlans.length === 0) {
    console.warn('[omg] dedup: LLM found no true duplicates')
  }

  // Gather all node IDs referenced in merge plans
  const allNodeIds = new Set<string>()
  for (const plan of mergePlans) {
    allNodeIds.add(plan.keepNodeId)
    for (const id of plan.mergeNodeIds) allNodeIds.add(id)
  }

  let filePaths: Map<string, string>
  try {
    filePaths = await getNodeFilePaths(omgRoot, [...allNodeIds])
  } catch (err) {
    const msg = `Failed to resolve file paths for merge: ${err instanceof Error ? err.message : String(err)}`
    console.error('[omg] dedup:', msg)
    errors.push(msg)
    // Still advance state — the LLM call succeeded, error is in file resolution
    try {
      await saveDedupState(omgRoot, {
        ...state,
        lastDedupAt: new Date().toISOString(),
        runsCompleted: state.runsCompleted + 1,
      })
    } catch (saveErr) {
      console.error('[omg] dedup: failed to save state (file-paths error path):', saveErr)
    }
    return { clustersProcessed, mergesExecuted, nodesArchived, conflictsDetected, tokensUsed, errors }
  }

  for (const plan of mergePlans) {
    try {
      const result: MergeResult = await executeMerge(plan, filePaths, omgRoot)
      mergesExecuted++
      nodesArchived += result.nodesArchived
      conflictsDetected += plan.conflicts.length

      try {
        await appendAuditEntry(omgRoot, result.auditEntry)
      } catch (err) {
        console.error(`[omg] dedup: failed to append audit entry for "${plan.keepNodeId}":`, err)
      }
    } catch (err) {
      const msg = `Merge failed for keeper "${plan.keepNodeId}": ${err instanceof Error ? err.message : String(err)}`
      console.error('[omg] dedup:', msg)
      errors.push(msg)
    }
  }

  // -------------------------------------------------------------------------
  // Persist state — only on full success (LLM call succeeded)
  // -------------------------------------------------------------------------

  try {
    await saveDedupState(omgRoot, {
      lastDedupAt: new Date().toISOString(),
      runsCompleted: state.runsCompleted + 1,
      totalMerges: state.totalMerges + mergesExecuted,
    })
  } catch (err) {
    console.error('[omg] dedup: failed to save state after merge execution:', err)
  }

  console.warn(
    `[omg] dedup: completed — ${clustersProcessed} cluster(s), ` +
      `${mergesExecuted} merge(s), ${nodesArchived} archived, ` +
      `${conflictsDetected} conflict(s), ${tokensUsed} tokens`
  )

  return { clustersProcessed, mergesExecuted, nodesArchived, conflictsDetected, tokensUsed, errors }
}
