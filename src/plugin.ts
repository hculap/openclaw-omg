/**
 * plugin.ts — OpenClaw plugin entry point for the OMG (Observational Memory Graph) plugin.
 *
 * Exports a `register(api)` function that wires the lifecycle hooks:
 *   - `before_prompt_build` — injects relevant graph context before the agent runs
 *   - `agent_end`           — triggers observation after each agent turn
 *   - `before_compaction`   — forces observation before history is compacted
 *   - `tool_result_persist` — tags memory_search results with referenced node IDs
 *
 * OpenClaw plugins can export either a function `(api) => void` or an object
 * with `{ id, name, configSchema, register(api) { ... } }`. This module
 * exports the named `register` function for explicit wiring, a `plugin` object
 * for OpenClaw's auto-discovery, and a default export for backward compatibility.
 */

import { parseConfig, omgConfigSchema } from './config.js'
import { createLlmClient } from './llm/client.js'
import { agentEnd } from './hooks/agent-end.js'
import { beforeAgentStart } from './hooks/before-agent-start.js'
import { beforeCompaction } from './hooks/before-compaction.js'
import { toolResultPersist } from './hooks/tool-result-persist.js'
import { registerCronJobs } from './cron/register.js'
import { scaffoldGraphIfNeeded } from './scaffold.js'
import { runBootstrap } from './bootstrap/bootstrap.js'
import { listAllNodes } from './graph/node-reader.js'
import { resolveOmgRoot } from './utils/paths.js'
import type { Message } from './types.js'
import type { GenerateFn } from './llm/client.js'
import type { BootstrapSource } from './bootstrap/bootstrap.js'

// ---------------------------------------------------------------------------
// Plugin API types (OpenClaw plugin interface)
// ---------------------------------------------------------------------------

/** Context provided per hook call for session-scoped hooks. */
export interface PluginHookContext {
  /** Stable identifier for the current conversation session. */
  readonly sessionKey: string
  /**
   * Conversation messages accumulated so far in this session.
   * Only present on `agent_end` and `before_compaction` hooks.
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

  /**
   * Absolute path to the workspace root directory on the gateway host.
   * May be undefined when the plugin is registered as a global gateway-level
   * plugin (not per-agent). Use the `workspaceDir` config field as a fallback.
   */
  readonly workspaceDir?: string

  /**
   * OpenClaw's LLM generation function. Used to create the observer's
   * LlmClient. Model selection and auth are handled by the host.
   */
  readonly generate: GenerateFn

  /** Register a handler for the `before_prompt_build` lifecycle hook. */
  on(
    hook: 'before_prompt_build',
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

  /** Register a handler for the `before_compaction` lifecycle hook. */
  on(
    hook: 'before_compaction',
    handler: (
      event: Record<string, never>,
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

  /**
   * Registers a CLI sub-command with OpenClaw's CLI framework.
   * Optional — not all host versions expose this method. Guard with
   * `typeof api.registerCli === 'function'` before calling.
   *
   * @param setup    Callback that configures the command using the provided
   *                 program builder context.
   * @param options  Metadata about the commands being registered.
   */
  registerCli?(
    setup: (ctx: { program: { command(name: string): unknown } }) => void,
    options: { commands: readonly string[] }
  ): void
}

// ---------------------------------------------------------------------------
// OpenClawPluginDefinition
// ---------------------------------------------------------------------------

/**
 * Structured plugin definition for OpenClaw's auto-discovery mechanism.
 * Plugins that export this interface are recognised and loaded automatically.
 */
export interface OpenClawPluginDefinition {
  readonly id: string
  readonly name: string
  readonly configSchema: typeof omgConfigSchema
  register(api: PluginApi): void
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
  // OpenClaw passes the full global config as api.config, not the plugin-specific
  // sub-config. Extract the OMG-specific config from plugins.entries.omg.config,
  // falling back to api.config directly for backward compatibility.
  const rawGlobal = api.config as Record<string, unknown>
  const rawPluginConfig =
    (
      (
        (rawGlobal?.['plugins'] as Record<string, unknown>)
          ?.['entries'] as Record<string, unknown>
      )?.['omg'] as Record<string, unknown>
    )?.['config'] ?? api.config

  const config = parseConfig(rawPluginConfig)

  // Resolve workspaceDir from (in priority order):
  //   1. Host-provided api.workspaceDir (per-agent context, may be undefined at gateway level)
  //   2. Explicitly configured workspaceDir in plugins.entries.omg.config
  //   3. Agent default workspace from agents.defaults.workspace
  const agentDefaultWorkspace = (
    (rawGlobal?.['agents'] as Record<string, unknown>)
      ?.['defaults'] as Record<string, unknown>
  )?.['workspace'] as string | undefined

  const workspaceDir = api.workspaceDir ?? config.workspaceDir ?? agentDefaultWorkspace

  // Model label used only for error-message attribution; actual model
  // selection is owned by the host via api.generate.
  // Use a lazy wrapper so we read api.generate at call time — OpenClaw may
  // populate it after registration completes (e.g. once an agent session starts).
  const observerModel = config.observer.model ?? '(inherited)'
  const llmClient = createLlmClient(observerModel, (params) => {
    const generate = api.generate as unknown
    if (typeof generate !== 'function') {
      throw new Error('[omg] api.generate is not available in this plugin context')
    }
    return (generate as typeof api.generate)(params)
  })

  // One-time flag: trigger bootstrap on first agent turn if sentinel is missing.
  // api.generate is available during agent sessions (not at gateway_start or CLI time).
  let bootstrapTriggeredFromSession = false

  api.on('before_prompt_build', (event, ctx) => {
    if (!workspaceDir) return Promise.resolve(undefined)

    // Fire-and-forget bootstrap if it hasn't been attempted this gateway lifetime.
    // Runs once: even if bootstrap succeeds in the background, subsequent turns skip this.
    if (!bootstrapTriggeredFromSession) {
      bootstrapTriggeredFromSession = true
      const omgRoot = resolveOmgRoot(workspaceDir, config)
      listAllNodes(omgRoot)
        .then((nodes) => {
          if (nodes.length === 0) {
            return runBootstrap({ workspaceDir: workspaceDir!, config, llmClient, force: false })
              .catch((err) => console.error('[omg] before_prompt_build: bootstrap failed:', err))
          }
        })
        .catch(() => { /* listAllNodes failure: skip bootstrap silently */ })
    }

    return beforeAgentStart(event, { workspaceDir, sessionKey: ctx.sessionKey, config })
  })

  api.on('agent_end', (event, ctx) => {
    if (!workspaceDir) return Promise.resolve(undefined)
    return agentEnd(event, {
      workspaceDir,
      sessionKey: ctx.sessionKey,
      messages: ctx.messages,
      config,
      llmClient,
    })
  })

  api.on('before_compaction', (_event, ctx) => {
    if (!workspaceDir) return Promise.resolve(undefined)
    return beforeCompaction(_event, {
      workspaceDir,
      sessionKey: ctx.sessionKey,
      messages: ctx.messages ?? [],
      config,
      llmClient,
    })
  })

  api.on('tool_result_persist', (event) => toolResultPersist(event))

  api.on('gateway_start', async () => {
    if (!workspaceDir) return

    await scaffoldGraphIfNeeded(workspaceDir, config).catch((err) =>
      console.error('[omg] scaffold failed:', err)
    )

    const cronCtx = { workspaceDir, config, llmClient }
    try {
      registerCronJobs(api, config, cronCtx)
    } catch (err) {
      console.error('[omg] gateway_start: failed to register cron jobs — background reflection will not run:', err)
    }

    // Fire-and-forget bootstrap on first start (graph is empty, no sentinel).
    // Requires api.generate to be callable — skip silently at gateway level if not.
    if (typeof api.generate === 'function') {
      const omgRoot = resolveOmgRoot(workspaceDir, config)
      const nodes = await listAllNodes(omgRoot).catch(() => [])
      if (nodes.length === 0) {
        runBootstrap({ workspaceDir, config, llmClient, force: false })
          .catch((err) => console.error('[omg] gateway_start: bootstrap failed:', err))
      }
    } else {
      console.warn('[omg] gateway_start: api.generate is not available — bootstrap deferred. Run `openclaw omg bootstrap` manually once the gateway is active.')
    }
  })

  // Register CLI command if the host supports it
  if (typeof api.registerCli === 'function') {
    type CliCommand = {
      option(flag: string, desc: string, defaultVal?: string): CliCommand
      action(fn: (...args: unknown[]) => Promise<void>): CliCommand
    }
    type CliProgram = { command(name: string): CliCommand }

    api.registerCli(
      (ctx) => {
        const program = ctx.program as CliProgram
        program
          .command('omg bootstrap')
          .option('--force', 'Re-run bootstrap even if sentinel exists')
          .option('--source <source>', 'Source to ingest: memory|logs|sqlite|all', 'all')
          .action(async (...actionArgs: unknown[]) => {
            // Commander calls action as (...positionalArgs, options, command).
            // 'omg bootstrap' registers 'bootstrap' as a positional arg of command 'omg',
            // so actionArgs is: (bootstrapArg, options, command).
            // Options (second-to-last) is a plain object; last is the Command (circular).
            const opts = (actionArgs.length >= 2
              ? actionArgs[actionArgs.length - 2]
              : {}) as Record<string, unknown>
            if (typeof api.generate !== 'function') {
              const omgRoot = workspaceDir ? resolveOmgRoot(workspaceDir, config) : null
              const sentinelPath = omgRoot ? `${omgRoot}/.bootstrap-done` : '<omgRoot>/.bootstrap-done'
              console.error(
                '[omg] bootstrap: api.generate is not available in the CLI context.\n' +
                'Bootstrap requires an active agent session to access the LLM.\n' +
                'It will run automatically on the next agent turn if the graph is empty.\n' +
                `To force a re-run: delete the sentinel file and start a new session:\n  rm ${sentinelPath}`
              )
              return
            }
            if (!workspaceDir) {
              console.error('[omg] bootstrap: workspaceDir is not available')
              return
            }
            const force = Boolean(opts['force'])
            const source = (opts['source'] as BootstrapSource | undefined) ?? 'all'
            const result = await runBootstrap({ workspaceDir, config, llmClient, force, source })
            if (!result.ran) {
              console.log('[omg] bootstrap: already complete — use --force to re-run')
            }
          })
      },
      { commands: ['omg bootstrap'] }
    )
  }
}

// ---------------------------------------------------------------------------
// Plugin definition object
// ---------------------------------------------------------------------------

/**
 * Structured plugin definition for OpenClaw auto-discovery.
 * Preferred export over the bare `register` function.
 */
export const plugin: OpenClawPluginDefinition = {
  id: 'omg',
  name: 'Observational Memory Graph',
  configSchema: omgConfigSchema,
  register,
}

export default register
