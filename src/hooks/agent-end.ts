import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import type { Message, OmgSessionState, ExtractOutput } from '../types.js'
import { createOmgSessionState, candidateToUpsertOperation } from '../types.js'
import { loadSessionState, saveSessionState, getDefaultSessionState } from '../state/session-state.js'
import { accumulateTokens, shouldTriggerObservation, shouldTriggerReflection } from '../state/token-tracker.js'
import { runExtract, runMerge } from '../observer/observer.js'
import { runReflection } from '../reflector/reflector.js'
import { writeObservationNode, writeNowNode, appendToExistingNode, addAliasToNode } from '../graph/node-writer.js'
import { applyMocUpdate, regenerateMoc } from '../graph/moc-manager.js'
import { readGraphNode } from '../graph/node-reader.js'
import { getRegistryEntries, getNodeFilePaths } from '../graph/registry.js'
import { resolveOmgRoot, resolveMocPath } from '../utils/paths.js'
import { readFileOrNull } from '../utils/fs.js'
import { findMergeTargets, shouldMerge, DEFAULT_MERGE_RETRIEVAL_CONFIG } from '../observer/retrieval.js'
import type { MergeRetrievalConfig } from '../observer/retrieval.js'
import { renderNowPatch, shouldUpdateNow } from '../observer/now-renderer.js'
import type { MemoryTools } from '../context/memory-search.js'
import { checkSourceOverlap, suppressDuplicateCandidates, updateRecentFingerprints } from '../observer/extraction-guardrails.js'
import { buildFingerprint, type SourceFingerprint } from '../observer/source-fingerprint.js'
import { emitMetric } from '../metrics/index.js'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface AgentEndEvent {
  readonly success: boolean
}

export interface AgentEndContext {
  readonly workspaceDir: string
  readonly sessionKey: string
  readonly messages: readonly Message[]
  readonly config: OmgConfig
  readonly llmClient: LlmClient
  /** Optional memory tools for semantic retrieval during merge targeting. */
  readonly memoryTools?: MemoryTools | null
}

/**
 * OpenClaw `agent_end` hook — triggers observation (and optionally reflection)
 * after each agent turn.
 *
 * Never throws — all errors are caught and logged. State is always persisted
 * even on partial failure.
 */
export async function agentEnd(event: AgentEndEvent, ctx: AgentEndContext): Promise<void> {
  const { workspaceDir, sessionKey, messages, config, llmClient, memoryTools } = ctx
  const omgRoot = resolveOmgRoot(workspaceDir, config)
  const scope = config.scope ?? workspaceDir
  const writeContext = { omgRoot, sessionKey, scope }

  const initialState = await loadSessionStateOrDefault(workspaceDir, sessionKey)
  const accumulatedState = accumulateTokens(messages, initialState)

  if (!shouldTriggerObservation(accumulatedState, config)) {
    await persistState(workspaceDir, sessionKey, accumulatedState)
    return
  }

  const finalState = await tryRunObservation(
    messages, accumulatedState, config, llmClient, omgRoot, writeContext, sessionKey,
    memoryTools ?? null
  )

  await persistState(workspaceDir, sessionKey, finalState)
}

// ---------------------------------------------------------------------------
// Observation cycle
// ---------------------------------------------------------------------------

/**
 * Runs the full observation cycle (3-step Extract → Merge → Write flow),
 * returning the updated session state on success or the pre-observation
 * state on any failure.
 *
 * Steps:
 *   A. Extract — LLM reads messages → ExtractOutput (candidates + nowPatch)
 *   B. Merge   — For each candidate: find nearby nodes → optionally LLM merge decision
 *   C. Write   — Execute merge actions, update MOCs, update now node
 *
 * Each phase logs before returning early. Never throws.
 */
export async function tryRunObservation(
  messages: readonly Message[],
  state: OmgSessionState,
  config: OmgConfig,
  llmClient: LlmClient,
  omgRoot: string,
  writeContext: { readonly omgRoot: string; readonly sessionKey: string; readonly scope: string },
  sessionKey: string,
  memoryTools: MemoryTools | null = null
): Promise<OmgSessionState> {
  // ── Pre-Extract: Guardrail overlap check ────────────────────────────────
  const unobservedMessages = Array.from(messages.slice(state.observationBoundaryMessageIndex))

  if (config.extractionGuardrails.enabled) {
    const recentFingerprints = state.recentSourceFingerprints ?? []
    const decision = checkSourceOverlap(unobservedMessages, recentFingerprints, config)

    if (decision.action === 'skip') {
      console.warn(
        `[omg] agent_end [${sessionKey}]: guardrail SKIP — overlap ${(decision.overlapScore * 100).toFixed(1)}% ` +
        `exceeds threshold (${unobservedMessages.length} messages)`
      )
      emitMetric({
        stage: 'guardrail',
        timestamp: new Date().toISOString(),
        data: {
          stage: 'guardrail',
          overlapScore: decision.overlapScore,
          action: 'skip',
          candidatesSuppressed: 0,
          candidatesSurvived: 0,
        },
      })
      return state
    }

    if (decision.action === 'truncate' && decision.filteredMessageCount < unobservedMessages.length) {
      const truncated = unobservedMessages.length - decision.filteredMessageCount
      console.warn(
        `[omg] agent_end [${sessionKey}]: guardrail TRUNCATE — overlap ${(decision.overlapScore * 100).toFixed(1)}%, ` +
        `keeping ${decision.filteredMessageCount}/${unobservedMessages.length} messages (${truncated} dropped)`
      )
      unobservedMessages.splice(0, unobservedMessages.length - decision.filteredMessageCount)
    }
  }

  // ── Step A: Extract ───────────────────────────────────────────────────────
  // Do NOT advance boundary/reset tokens on failure — preserves retry semantics.
  let extractOutput!: ExtractOutput
  try {
    const nowContent = await readFileOrNull(path.join(omgRoot, 'now.md'))
    extractOutput = await runExtract({
      unobservedMessages,
      nowNode: nowContent,
      config,
      llmClient,
      sessionContext: { sessionKey },
    })
  } catch (err) {
    console.error(`[omg] agent_end [${sessionKey}]: Extract phase failed — state preserved for retry:`, err)
    return state
  }

  // ── Post-Extract: Guardrail candidate suppression ────────────────────────
  let allRegistryEntries: readonly [string, import('../graph/registry.js').RegistryNodeEntry][]
  try {
    allRegistryEntries = await getRegistryEntries(omgRoot)
  } catch (err) {
    console.error(
      `[omg] agent_end [${sessionKey}]: registry read failed for guardrail suppression — proceeding with all candidates:`,
      err,
    )
    allRegistryEntries = []
  }
  let filteredCandidates = extractOutput.candidates

  if (config.extractionGuardrails.enabled && state.lastObservationNodeIds.length > 0) {
    const { survivors, suppressed } = suppressDuplicateCandidates(
      extractOutput.candidates,
      state.lastObservationNodeIds,
      allRegistryEntries,
      config,
    )
    if (suppressed.length > 0) {
      console.warn(
        `[omg] agent_end [${sessionKey}]: guardrail suppressed ${suppressed.length} candidate(s): ${suppressed.join(', ')}`
      )
    }
    filteredCandidates = survivors
    emitMetric({
      stage: 'guardrail',
      timestamp: new Date().toISOString(),
      data: {
        stage: 'guardrail',
        overlapScore: 0,
        action: 'proceed',
        candidatesSuppressed: suppressed.length,
        candidatesSurvived: survivors.length,
      },
    })
  }

  // ── Step B+C: Merge decision + Write ─────────────────────────────────────
  // For each candidate, find merge targets → decide → apply action.
  // Partial failures are tolerated via Promise.allSettled pattern.
  const writtenIds: string[] = []
  let writeFailureCount = 0

  const mergeConfig = buildMergeRetrievalConfig(config)

  for (const candidate of filteredCandidates) {
    try {
      // Find merge targets (local + optional semantic)
      const targets = await findMergeTargets(candidate, allRegistryEntries, memoryTools, mergeConfig)

      // Only invoke merge LLM when retrieval found close neighbors
      let mergeAction: { action: string; targetNodeId?: string; bodyAppend?: string; aliasKey?: string }
      if (shouldMerge(targets, mergeConfig.mergeThreshold)) {
        try {
          mergeAction = await runMerge(candidate, targets, llmClient)
        } catch (err) {
          console.error(
            `[omg] agent_end [${sessionKey}]: Merge LLM call failed for candidate "${candidate.canonicalKey}" — falling back to keep_separate:`,
            err
          )
          mergeAction = { action: 'keep_separate' }
        }
      } else {
        mergeAction = { action: 'keep_separate' }
      }

      // Apply the merge action
      if (mergeAction.action === 'merge' && mergeAction.targetNodeId) {
        const result = await appendToExistingNode(
          omgRoot,
          mergeAction.targetNodeId,
          mergeAction.bodyAppend ?? ''
        )
        if (result) {
          writtenIds.push(result.frontmatter.id)
          console.log(`[omg] merge: appended to existing node ${mergeAction.targetNodeId} (candidate: ${candidate.canonicalKey})`)
        } else {
          console.error(
            `[omg] agent_end [${sessionKey}]: merge target "${mergeAction.targetNodeId}" not found in registry ` +
            `for candidate "${candidate.canonicalKey}" — falling back to keep_separate`
          )
          const op = candidateToUpsertOperation(candidate)
          try {
            const written = await writeObservationNode(op, writeContext)
            writtenIds.push(written.frontmatter.id)
          } catch (writeErr) {
            console.error(
              `[omg] agent_end [${sessionKey}]: keep_separate fallback write failed for candidate "${candidate.canonicalKey}":`,
              writeErr
            )
            writeFailureCount++
          }
        }
      } else if (mergeAction.action === 'alias' && mergeAction.targetNodeId && (mergeAction as { aliasKey?: string }).aliasKey) {
        const aliasKey = (mergeAction as { aliasKey: string }).aliasKey
        const result = await addAliasToNode(omgRoot, mergeAction.targetNodeId, aliasKey)
        if (result) {
          writtenIds.push(result.frontmatter.id)
          console.log(`[omg] merge: added alias "${aliasKey}" to node ${mergeAction.targetNodeId}`)
        } else {
          console.error(
            `[omg] agent_end [${sessionKey}]: alias target "${mergeAction.targetNodeId}" not found in registry ` +
            `for candidate "${candidate.canonicalKey}" — falling back to keep_separate`
          )
          const op = candidateToUpsertOperation(candidate)
          try {
            const written = await writeObservationNode(op, writeContext)
            writtenIds.push(written.frontmatter.id)
          } catch (writeErr) {
            console.error(
              `[omg] agent_end [${sessionKey}]: keep_separate fallback write failed for candidate "${candidate.canonicalKey}":`,
              writeErr
            )
            writeFailureCount++
          }
        }
      } else {
        // keep_separate — write as new node
        const op = candidateToUpsertOperation(candidate)
        try {
          const written = await writeObservationNode(op, writeContext)
          writtenIds.push(written.frontmatter.id)
        } catch (writeErr) {
          console.error(
            `[omg] agent_end [${sessionKey}]: write failed for candidate "${candidate.canonicalKey}":`,
            writeErr
          )
          writeFailureCount++
        }
      }
    } catch (candidateErr) {
      console.error(
        `[omg] agent_end [${sessionKey}]: error processing candidate "${candidate.canonicalKey}":`,
        candidateErr
      )
      writeFailureCount++
    }
  }

  // If no nodes were written and there were candidates, fail-safe: preserve state for retry.
  if (writtenIds.length === 0 && filteredCandidates.length > 0 && writeFailureCount === filteredCandidates.length) {
    console.error(`[omg] agent_end [${sessionKey}]: all candidate writes/merges failed — state preserved for retry`)
    return state
  }

  // ── Phase 3: MOC updates ──────────────────────────────────────────────────
  // Derived from candidates' mocHints — unchanged from original flow.
  try {
    const freshEntries = await getRegistryEntries(omgRoot)
    for (const domain of extractOutput.mocUpdates) {
      const mocId = `omg/moc-${domain}`
      const domainEntries = freshEntries.filter(([, e]) => e.links?.includes(mocId))
      if (domainEntries.length > 0) {
        const nodeIds = domainEntries.map(([id]) => id)
        const filePaths = await getNodeFilePaths(omgRoot, nodeIds)
        const domainNodes = (await Promise.all(
          [...filePaths.values()].map((fp) => readGraphNode(fp))
        )).filter((n): n is NonNullable<typeof n> => n !== null)
        if (domainNodes.length > 0) {
          await regenerateMoc(domain, domainNodes, omgRoot)
        }
      } else {
        const mocPath = resolveMocPath(omgRoot, domain)
        for (const id of writtenIds) {
          const entry = freshEntries.find(([nid]) => nid === id)?.[1]
          if (entry?.links?.includes(mocId)) {
            await applyMocUpdate(mocPath, { action: 'add', nodeId: id })
          }
        }
      }
    }
  } catch (err) {
    console.error(`[omg] agent_end [${sessionKey}]: MOC update phase failed — state preserved for retry:`, err)
    return state
  }

  // ── Phase 4: Now update via renderNowPatch ────────────────────────────────
  if (extractOutput.nowPatch !== null) {
    try {
      const currentNowContent = await readFileOrNull(path.join(omgRoot, 'now.md'))
      const nodesChanged = writtenIds.length > 0
      const openLoopsChanged = extractOutput.nowPatch.openLoops.length > 0

      if (nodesChanged || openLoopsChanged || shouldUpdateNow(currentNowContent, extractOutput.nowPatch)) {
        const rendered = renderNowPatch(extractOutput.nowPatch, writtenIds)
        await writeNowNode(rendered, writtenIds, writeContext)
      }
    } catch (err) {
      console.error(`[omg] agent_end [${sessionKey}]: now-node write failed — state preserved for retry:`, err)
      return state
    }
  }

  // All phases succeeded — build updated state through the factory.
  // createOmgSessionState validates invariants and can throw OmgSessionStateError;
  // catching here preserves the "never throws" contract of tryRunObservation.
  const tokensUsed = writtenIds.length > 0 ? state.pendingMessageTokens : 0
  // Update fingerprints for guardrail overlap detection
  const updatedFingerprints = config.extractionGuardrails.enabled
    ? updateRecentFingerprints(
        state.recentSourceFingerprints ?? [],
        buildFingerprint(unobservedMessages),
        config.extractionGuardrails.recentWindowSize,
      )
    : state.recentSourceFingerprints

  let updatedState: OmgSessionState
  try {
    updatedState = createOmgSessionState(
      {
        lastObservedAtMs: Date.now(),
        pendingMessageTokens: 0,
        totalObservationTokens: state.totalObservationTokens + tokensUsed,
        lastReflectionTotalTokens: state.lastReflectionTotalTokens,
        observationBoundaryMessageIndex: messages.length,
        nodeCount: state.nodeCount + writtenIds.length,
        lastObservationNodeIds: writtenIds,
        ...(updatedFingerprints ? { recentSourceFingerprints: updatedFingerprints } : {}),
      },
      state.totalObservationTokens
    )
  } catch (err) {
    console.error(`[omg] agent_end [${sessionKey}]: state factory threw after successful observation — state preserved:`, err)
    return state
  }

  // Trigger reflection if enough new observation tokens have accumulated since
  // the last reflection pass. After the pass (successful or not) we advance the
  // watermark so reflection does not re-fire on the very next turn.
  if (shouldTriggerReflection(updatedState, config)) {
    try {
      // Use registry for metadata-only filter, then hydrate qualifying nodes
      const eligibleEntries = await getRegistryEntries(omgRoot, { archived: false })
      const nonReflectionEntries = eligibleEntries.filter(([, e]) => e.type !== 'reflection')
      const nodeIds = nonReflectionEntries.map(([id]) => id)
      const filePaths = await getNodeFilePaths(omgRoot, nodeIds)
      const observationNodes = (await Promise.all(
        [...filePaths.values()].map((fp) => readGraphNode(fp))
      )).filter((n): n is NonNullable<typeof n> => n !== null)
      await runReflection({ observationNodes, config, llmClient, omgRoot, sessionKey })
        .catch((err) => console.error(`[omg] agent_end [${sessionKey}]: reflection failed:`, err))
    } catch (err) {
      console.error(`[omg] agent_end [${sessionKey}]: reflection setup failed — watermark not advanced:`, err)
      return updatedState
    }
    // Advance the watermark regardless of outcome — prevents infinite re-triggering.
    updatedState = { ...updatedState, lastReflectionTotalTokens: updatedState.totalObservationTokens }
  }

  return updatedState
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a MergeRetrievalConfig from the plugin config, using defaults
 * from DEFAULT_MERGE_RETRIEVAL_CONFIG when no merge config is present.
 */
function buildMergeRetrievalConfig(config: OmgConfig): MergeRetrievalConfig {
  const { merge } = config as OmgConfig & { merge?: Partial<MergeRetrievalConfig> }
  return {
    ...DEFAULT_MERGE_RETRIEVAL_CONFIG,
    ...(merge ?? {}),
  }
}

/**
 * Loads session state, falling back to the default state if the file is
 * missing or unreadable. Never throws.
 *
 * Note: ENOENT is handled inside `loadSessionState` itself; errors reaching
 * this catch are system-level (permissions, disk failure) and may be permanent.
 */
async function loadSessionStateOrDefault(
  workspaceDir: string,
  sessionKey: string
): Promise<OmgSessionState> {
  try {
    return await loadSessionState(workspaceDir, sessionKey)
  } catch (err) {
    console.error(
      `[omg] agent_end [${sessionKey}]: failed to load session state — system error detected, ` +
      `check permissions on ${workspaceDir}. Falling back to defaults.`,
      err
    )
    return getDefaultSessionState()
  }
}

/**
 * Persists session state. Never throws — logs on failure but does not
 * propagate, preserving the "never throws" contract of `agentEnd`.
 */
async function persistState(
  workspaceDir: string,
  sessionKey: string,
  state: OmgSessionState
): Promise<void> {
  try {
    await saveSessionState(workspaceDir, sessionKey, state)
  } catch (err) {
    console.error(
      `[omg] agent_end [${sessionKey}]: CRITICAL — failed to persist session state. ` +
      'The completed observation will be re-run on the next turn, which may create duplicate graph nodes.',
      err
    )
  }
}
