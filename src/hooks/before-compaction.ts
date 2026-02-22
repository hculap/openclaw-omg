import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import type { Message } from '../types.js'
import { loadSessionState, saveSessionState, getDefaultSessionState } from '../state/session-state.js'
import { tryRunObservation } from './agent-end.js'
import { resolveOmgRoot } from '../utils/paths.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BeforeCompactionEvent {
  readonly success?: boolean
}

export interface BeforeCompactionContext {
  readonly workspaceDir: string
  readonly sessionKey: string
  readonly messages: readonly Message[]
  readonly config: OmgConfig
  readonly llmClient: LlmClient
}

/**
 * OpenClaw `before_compaction` hook — forces a full observation pass before
 * the conversation history is compacted, preserving memory that would otherwise
 * be lost when messages are deleted.
 *
 * Unlike `agentEnd`, this hook bypasses `shouldTriggerObservation` and always
 * runs an observation regardless of pending token count.
 *
 * Never throws — all errors are caught and logged.
 */
export async function beforeCompaction(
  _event: BeforeCompactionEvent,
  ctx: BeforeCompactionContext
): Promise<void> {
  const { workspaceDir, sessionKey, messages, config, llmClient } = ctx
  const omgRoot = resolveOmgRoot(workspaceDir, config)
  const writeContext = { omgRoot, sessionKey }

  let state = getDefaultSessionState()
  try {
    state = await loadSessionState(workspaceDir, sessionKey)
  } catch (err) {
    console.error(
      `[omg] before_compaction [${sessionKey}]: failed to load session state — falling back to defaults:`,
      err
    )
  }

  const finalState = await tryRunObservation(
    messages, state, config, llmClient, omgRoot, writeContext, sessionKey
  )

  try {
    await saveSessionState(workspaceDir, sessionKey, finalState)
  } catch (err) {
    console.error(
      `[omg] before_compaction [${sessionKey}]: CRITICAL — failed to persist session state after forced observation:`,
      err
    )
  }
}
