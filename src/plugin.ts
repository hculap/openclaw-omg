/**
 * plugin.ts — OpenClaw plugin entry point for the OMG (Observational Memory Graph) plugin.
 *
 * Exports a `register(api)` function that wires the three lifecycle hooks:
 *   - `before_agent_start` — injects relevant graph context before the agent runs
 *   - `agent_end`          — triggers observation after each agent turn
 *   - `tool_result_persist` — tags memory_search results with referenced node IDs
 *
 * OpenClaw plugins can export either a function `(api) => void` or an object
 * with `{ id, name, configSchema, register(api) { ... } }`. This module
 * exports the named `register` function for explicit wiring and a default
 * export for OpenClaw's auto-discovery.
 */

import { parseConfig } from './config.js'
import { createLlmClient } from './llm/client.js'
import { agentEnd } from './hooks/agent-end.js'
import { beforeAgentStart } from './hooks/before-agent-start.js'
import { toolResultPersist } from './hooks/tool-result-persist.js'
import { registerCronJobs } from './cron/register.js'
import type { Message } from './types.js'
import type { GenerateFn } from './llm/client.js'

// ---------------------------------------------------------------------------
// Plugin API types (OpenClaw plugin interface)
// ---------------------------------------------------------------------------

/** Context provided per hook call for session-scoped hooks. */
export interface PluginHookContext {
  /** Stable identifier for the current conversation session. */
  readonly sessionKey: string
  /**
   * Conversation messages accumulated so far in this session.
   * Only present on `agent_end` hooks.
   */
  readonly messages?: readonly Message[]
}

/**
 * Minimal OpenClaw plugin API surface used by this plugin.
 *
 * OpenClaw passes this object to `register(api)`. The actual API has
 * additional methods not used by OMG; only the relevant subset is typed here.
 */
export interface PluginApi {
  /**
   * Raw plugin configuration as supplied by the operator (parsed from
   * workspace/managed config). Corresponds to the OMG config schema.
   * Must be passed through {@link parseConfig} before use — it is unvalidated at this point.
   */
  readonly config: Record<string, unknown>

  /** Absolute path to the workspace root directory on the gateway host. */
  readonly workspaceDir: string

  /**
   * OpenClaw's LLM generation function. Used to create the observer's
   * LlmClient. Model selection and auth are handled by the host.
   */
  readonly generate: GenerateFn

  /** Register a handler for the `before_agent_start` lifecycle hook. */
  on(
    hook: 'before_agent_start',
    handler: (
      event: { prompt: string },
      ctx: PluginHookContext
    ) => Promise<{ prependContext: string } | undefined>
  ): void

  /** Register a handler for the `agent_end` lifecycle hook. */
  on(
    hook: 'agent_end',
    handler: (
      event: { success: boolean },
      ctx: Required<PluginHookContext>
    ) => Promise<void>
  ): void

  /** Register a handler for the synchronous `tool_result_persist` lifecycle hook. */
  on(
    hook: 'tool_result_persist',
    handler: (
      event: { toolName: string; result: unknown }
    ) => { referencedNodeIds: readonly string[] } | undefined
  ): void

  /** Register a handler for the `gateway_start` lifecycle hook, called once when the gateway initialises. */
  on(hook: 'gateway_start', handler: () => Promise<void>): void

  /**
   * Schedules a recurring cron job.
   * OpenClaw deduplicates jobs by `jobId` — calling this multiple times with
   * the same `jobId` replaces the previous registration.
   *
   * @param jobId     Stable identifier for this job (used for deduplication and logging).
   * @param schedule  5-field cron expression (e.g. "0 3 * * *").
   * @param handler   Async function to execute on each tick. Errors are logged by the host.
   */
  scheduleCron(jobId: string, schedule: string, handler: () => Promise<void>): void
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

/**
 * Registers all OMG lifecycle hooks with the OpenClaw plugin API.
 *
 * Call this once during plugin initialisation. The function is idempotent
 * when called on the same `api` instance.
 *
 * @param api  The OpenClaw plugin API object provided at plugin load time.
 */
export function register(api: PluginApi): void {
  const config = parseConfig(api.config)
  const { workspaceDir } = api

  // Model label used only for error-message attribution; actual model
  // selection is owned by the host via api.generate.
  const observerModel = config.observer.model ?? '(inherited)'
  const llmClient = createLlmClient(observerModel, api.generate)

  api.on('before_agent_start', (event, ctx) =>
    beforeAgentStart(event, { workspaceDir, sessionKey: ctx.sessionKey, config })
  )

  api.on('agent_end', (event, ctx) =>
    agentEnd(event, {
      workspaceDir,
      sessionKey: ctx.sessionKey,
      messages: ctx.messages,
      config,
      llmClient,
    })
  )

  api.on('tool_result_persist', (event) => toolResultPersist(event))

  const cronCtx = { workspaceDir, config, llmClient }
  api.on('gateway_start', async () => {
    try {
      registerCronJobs(api, config, cronCtx)
    } catch (err) {
      console.error('[omg] gateway_start: failed to register cron jobs — background reflection will not run:', err)
    }
  })
}

export default register
