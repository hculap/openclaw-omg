import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import type { Message, OmgSessionState, ObserverOutput } from '../types.js'
import { createOmgSessionState } from '../types.js'
import { loadSessionState, saveSessionState, getDefaultSessionState } from '../state/session-state.js'
import { accumulateTokens, shouldTriggerObservation, shouldTriggerReflection } from '../state/token-tracker.js'
import { runObservation } from '../observer/observer.js'
import { writeObservationNode, writeNowNode } from '../graph/node-writer.js'
import { applyMocUpdate, regenerateMoc } from '../graph/moc-manager.js'
import { listAllNodes } from '../graph/node-reader.js'
import { resolveOmgRoot, resolveMocPath } from '../utils/paths.js'
import { readFileOrNull } from '../utils/fs.js'
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
}

/**
 * OpenClaw `agent_end` hook — triggers observation (and optionally reflection)
 * after each agent turn.
 *
 * Never throws — all errors are caught and logged. State is always persisted
 * even on partial failure.
 */
export async function agentEnd(event: AgentEndEvent, ctx: AgentEndContext): Promise<void> {
  const { workspaceDir, sessionKey, messages, config, llmClient } = ctx
  const omgRoot = resolveOmgRoot(workspaceDir, config)
  const writeContext = { omgRoot, sessionKey }

  const initialState = await loadSessionStateOrDefault(workspaceDir, sessionKey)
  const accumulatedState = accumulateTokens(messages, initialState)

  if (!shouldTriggerObservation(accumulatedState, config)) {
    await persistState(workspaceDir, sessionKey, accumulatedState)
    return
  }

  const finalState = await tryRunObservation(
    messages, accumulatedState, config, llmClient, omgRoot, writeContext, sessionKey
  )

  await persistState(workspaceDir, sessionKey, finalState)
}

// ---------------------------------------------------------------------------
// Observation cycle
// ---------------------------------------------------------------------------

/**
 * Runs the full observation cycle, returning the updated session state on
 * success or the pre-observation state on any failure.
 *
 * Each phase logs a specific error message before returning early, so the
 * outer caller does not need to re-log.
 *
 * Never throws.
 */
async function tryRunObservation(
  messages: readonly Message[],
  state: OmgSessionState,
  config: OmgConfig,
  llmClient: LlmClient,
  omgRoot: string,
  writeContext: { readonly omgRoot: string; readonly sessionKey: string },
  sessionKey: string
): Promise<OmgSessionState> {
  // Phase 1: gather inputs and run LLM observation
  // Do NOT advance observationBoundaryMessageIndex or reset pendingMessageTokens
  // on failure — keeping them intact ensures the next turn re-attempts.
  let observerOutput!: ObserverOutput
  try {
    const unobservedMessages = Array.from(messages.slice(state.observationBoundaryMessageIndex))
    const allNodes = await listAllNodes(omgRoot)
    const existingNodeIndex = allNodes.map((n) => ({
      id: n.frontmatter.id,
      description: n.frontmatter.description,
    }))
    const nowContent = await readFileOrNull(path.join(omgRoot, 'now.md'))
    observerOutput = await runObservation({
      unobservedMessages,
      existingNodeIndex,
      nowNode: nowContent,
      config,
      llmClient,
      sessionContext: { sessionKey },
    })
  } catch (err) {
    console.error(`[omg] agent_end [${sessionKey}]: LLM observation phase failed — state preserved for retry:`, err)
    return state
  }

  // Phase 2: write observation nodes — partial failure is tolerated.
  // Promise.allSettled prevents already-written nodes from being orphaned when a
  // later write fails; only a total write failure returns the pre-observation state.
  const writeResults = await Promise.allSettled(
    observerOutput.operations.map((op) => writeObservationNode(op, writeContext))
  )
  const writtenNodes = writeResults
    .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof writeObservationNode>>> =>
      r.status === 'fulfilled'
    )
    .map((r) => r.value)
  const failedWrites = writeResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failedWrites.length > 0) {
    console.error(
      `[omg] agent_end [${sessionKey}]: ${failedWrites.length}/${writeResults.length} node write(s) failed:`,
      failedWrites.map((f) => f.reason)
    )
  }
  const writtenIds = writtenNodes.map((n) => n.frontmatter.id)
  if (writtenIds.length === 0 && observerOutput.operations.length > 0) {
    console.error(`[omg] agent_end [${sessionKey}]: all node writes failed — state preserved for retry`)
    return state
  }

  // Phase 3: update MOCs
  try {
    // Apply MOC updates — read the graph once after all writes, not once per domain
    const updatedNodes = await listAllNodes(omgRoot)
    for (const domain of observerOutput.mocUpdates) {
      const domainNodes = updatedNodes.filter((n) => n.frontmatter.tags?.includes(domain))
      if (domainNodes.length > 0) {
        await regenerateMoc(domain, domainNodes, omgRoot)
      } else {
        // No nodes tagged with this domain exist yet — add only written nodes that belong here
        const mocPath = resolveMocPath(omgRoot, domain)
        const domainWrittenIds = writtenNodes
          .filter((n) => n.frontmatter.tags?.includes(domain))
          .map((n) => n.frontmatter.id)
        for (const id of domainWrittenIds) {
          await applyMocUpdate(mocPath, { action: 'add', nodeId: id })
        }
      }
    }
  } catch (err) {
    console.error(`[omg] agent_end [${sessionKey}]: MOC update phase failed — state preserved for retry:`, err)
    return state
  }

  // Phase 4: update now node
  if (observerOutput.nowUpdate !== null) {
    try {
      await writeNowNode(observerOutput.nowUpdate, writtenIds, writeContext)
    } catch (err) {
      console.error(`[omg] agent_end [${sessionKey}]: now-node write failed — state preserved for retry:`, err)
      return state
    }
  }

  // All phases succeeded — build updated state through the factory.
  // createOmgSessionState validates invariants and can throw OmgSessionStateError;
  // catching here preserves the "never throws" contract of tryRunObservation.
  const tokensUsed = writtenIds.length > 0 ? state.pendingMessageTokens : 0
  let updatedState: OmgSessionState
  try {
    updatedState = createOmgSessionState(
      {
        lastObservedAtMs: Date.now(),
        pendingMessageTokens: 0,
        totalObservationTokens: state.totalObservationTokens + tokensUsed,
        observationBoundaryMessageIndex: messages.length,
        nodeCount: state.nodeCount + writtenIds.length,
        lastObservationNodeIds: writtenIds,
      },
      state.totalObservationTokens
    )
  } catch (err) {
    console.error(`[omg] agent_end [${sessionKey}]: state factory threw after successful observation — state preserved:`, err)
    return state
  }

  // Check for reflection (Phase 5 placeholder)
  if (shouldTriggerReflection(updatedState, config)) {
    console.error(
      `[omg] agent_end [${sessionKey}]: reflection threshold reached but not yet implemented (Phase 5). ` +
      `totalObservationTokens=${updatedState.totalObservationTokens}. Graph compression is being skipped.`
    )
  }

  return updatedState
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
