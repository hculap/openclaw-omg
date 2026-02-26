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
import { createGatewayCompletionsGenerateFn } from './llm/gateway-completions.js'
import { agentEnd } from './hooks/agent-end.js'
import { beforeAgentStart } from './hooks/before-agent-start.js'
import { createMemoryTools } from './context/memory-search.js'
import { beforeCompaction } from './hooks/before-compaction.js'
import { toolResultPersist } from './hooks/tool-result-persist.js'
import { registerCronJobs } from './cron/register.js'
import { graphMaintenanceCronHandler } from './cron/definitions.js'
import {
  readWorkspaceRegistry,
  writeWorkspaceRegistry,
  addWorkspaceToRegistry,
  pruneStaleWorkspaces,
  listWorkspacePaths,
} from './cron/workspace-registry.js'
import { scaffoldGraphIfNeeded } from './scaffold.js'
import { runBootstrap, runBootstrapTick, runBootstrapRetry } from './bootstrap/bootstrap.js'
import { readBootstrapState, writeBootstrapState, markMaintenanceDone } from './bootstrap/state.js'
import { resolveOmgRoot } from './utils/paths.js'
import type { Message } from './types.js'
import type { GenerateFn } from './llm/client.js'
import type { BootstrapSource } from './bootstrap/bootstrap.js'
import { FAILURE_ERROR_TYPES, type FailureErrorType } from './bootstrap/failure-log.js'

// ---------------------------------------------------------------------------
// Plugin API types (OpenClaw plugin interface)
// ---------------------------------------------------------------------------

/** Context provided per hook call for session-scoped hooks. */
export interface PluginHookContext {
  /** Agent identifier (e.g. "main", "email-triage"). May be undefined. */
  readonly agentId?: string
  /** Stable identifier for the current conversation session. May be undefined for CLI sessions. */
  readonly sessionKey?: string
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
      ctx: PluginHookContext
    ) => Promise<void>
  ): void

  /** Register a handler for the `before_compaction` lifecycle hook. */
  on(
    hook: 'before_compaction',
    handler: (
      event: Record<string, never>,
      ctx: PluginHookContext
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
   * Optional runtime extension API provided by newer OpenClaw host versions.
   * Guards: `typeof api.runtime?.tools?.createMemorySearchTool === 'function'`
   */
  readonly runtime?: {
    readonly tools?: {
      createMemorySearchTool?: () => { execute(input: unknown): Promise<unknown> } | null
      createMemoryGetTool?: () => { execute(input: unknown): Promise<unknown> } | null
    }
    readonly config?: {
      loadConfig?: () => unknown
      writeConfigFile?: (cfg: unknown) => Promise<void>
    }
  }

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
// Message normalization
// ---------------------------------------------------------------------------

/**
 * Content block as used by the Anthropic Messages API.
 * Gateway messages may use this format instead of plain strings.
 */
interface ContentBlock {
  readonly type: string
  readonly text?: string
}

/**
 * Normalizes raw gateway messages into the OMG `Message` format.
 *
 * The OpenClaw gateway passes messages in Anthropic API format where `content`
 * is an array of content blocks (`[{type: "text", text: "..."}]`), but OMG's
 * `Message` type expects `content` to be a plain string.
 *
 * This function handles both formats gracefully:
 *   - Plain string content → passed through unchanged
 *   - Array of content blocks → text blocks are extracted and joined
 *   - Any other shape → converted to string via JSON.stringify
 */
function normalizeMessages(raw: readonly unknown[]): readonly Message[] {
  return raw.map((msg) => {
    const m = msg as { role?: string; content?: unknown }
    const role = m.role === 'assistant' ? 'assistant' : 'user'
    const content = normalizeContent(m.content)
    return { role, content } as Message
  })
}

function normalizeContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as readonly ContentBlock[])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text!)
      .join('\n')
  }
  return typeof content === 'undefined' ? '' : JSON.stringify(content)
}

// ---------------------------------------------------------------------------
// LLM generation resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the gateway port from config or environment, defaulting to 18789.
 */
function resolveGatewayPort(rawConfig: Record<string, unknown>): number {
  const gatewayConfig = rawConfig?.['gateway'] as Record<string, unknown> | undefined
  const configPort = gatewayConfig?.['port'] as number | undefined
  const envPort = process.env['CLAWDBOT_GATEWAY_PORT']
  return configPort ?? (envPort ? Number(envPort) : 18789)
}

/**
 * Resolves the gateway auth token from config.
 */
function resolveGatewayAuthToken(rawConfig: Record<string, unknown>): string | undefined {
  const gatewayConfig = rawConfig?.['gateway'] as Record<string, unknown> | undefined
  const authConfig = gatewayConfig?.['auth'] as Record<string, unknown> | undefined
  return authConfig?.['token'] as string | undefined
}

/**
 * Ensures the gateway's `/v1/chat/completions` endpoint is enabled in the config.
 *
 * The OMG plugin routes LLM calls through this endpoint to use OpenClaw's own
 * model providers. If the endpoint is not enabled, this function patches the
 * config and writes it back. The gateway will pick up the change on next reload.
 */
async function ensureChatCompletionsEnabled(api: PluginApi): Promise<void> {
  const rawConfig = api.config as Record<string, unknown>
  const gateway = rawConfig?.['gateway'] as Record<string, unknown> | undefined
  const http = gateway?.['http'] as Record<string, unknown> | undefined
  const endpoints = http?.['endpoints'] as Record<string, unknown> | undefined
  const chatCompletions = endpoints?.['chatCompletions'] as Record<string, unknown> | undefined

  if (chatCompletions?.['enabled'] === true) return // already enabled

  // Use runtime.config.writeConfigFile to patch the config
  const runtime = api.runtime
  if (typeof runtime?.config?.loadConfig !== 'function' || typeof runtime?.config?.writeConfigFile !== 'function') {
    console.warn('[omg] gateway_start: cannot auto-enable chatCompletions — runtime.config not available')
    return
  }

  const currentConfig = runtime.config.loadConfig() as Record<string, unknown>
  const currentGateway = (currentConfig['gateway'] ?? {}) as Record<string, unknown>
  const currentHttp = (currentGateway['http'] ?? {}) as Record<string, unknown>
  const currentEndpoints = (currentHttp['endpoints'] ?? {}) as Record<string, unknown>
  const currentChatCompletions = (currentEndpoints['chatCompletions'] ?? {}) as Record<string, unknown>

  const patchedConfig = {
    ...currentConfig,
    gateway: {
      ...currentGateway,
      http: {
        ...currentHttp,
        endpoints: {
          ...currentEndpoints,
          chatCompletions: { ...currentChatCompletions, enabled: true },
        },
      },
    },
  }

  await runtime.config.writeConfigFile(patchedConfig)
  console.error('[omg] gateway_start: auto-enabled gateway.http.endpoints.chatCompletions — LLM calls will route through OpenClaw')
}

/**
 * Builds the LLM generate function for the observer/reflector.
 *
 * Resolution order:
 *   1. `api.generate` if the host provides it (future-proofing)
 *   2. Gateway's `/v1/chat/completions` endpoint — the only supported LLM path.
 *      If the gateway is unreachable, a `GatewayUnreachableError` is thrown loudly;
 *      rate limit responses throw `RateLimitError` so callers can retry with backoff.
 */
function resolveGenerateFn(api: PluginApi, model: string, timeoutMs?: number): GenerateFn {
  const rawGlobal = api.config as Record<string, unknown>

  // 1. Host's api.generate (future-proofing)
  const hostGenerate = (api as unknown as { generate?: unknown }).generate
  if (typeof hostGenerate === 'function') {
    console.error('[omg] Using api.generate from host for LLM calls')
    return (params) => (hostGenerate as GenerateFn)(params)
  }

  // 2. Gateway /v1/chat/completions — the only supported path.
  //    Gateway unreachable → GatewayUnreachableError propagates loudly.
  return createGatewayCompletionsGenerateFn({
    port: resolveGatewayPort(rawGlobal),
    authToken: resolveGatewayAuthToken(rawGlobal),
    model,
    timeoutMs,
  })
}

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

/**
 * Parses a comma-separated string of batch indices into a validated array.
 * Rejects non-integer, negative, or NaN values.
 *
 * @example parseBatchIndices('6,12,25') // [6, 12, 25]
 * @example parseBatchIndices(' 6 , 12 ') // [6, 12]
 */
export function parseBatchIndices(raw: string): readonly number[] {
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
  const indices: number[] = []
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`Invalid batch index "${part}" — must be a non-negative integer`)
    }
    indices.push(n)
  }
  return indices
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
  // Resolve plugin-specific config. The gateway provides it via api.pluginConfig
  // (validated against the manifest JSON Schema). Fall back to navigating
  // api.config.plugins.entries.omg.config for backward compatibility.
  const rawGlobal = api.config as Record<string, unknown>
  const apiPluginConfig = (api as unknown as { pluginConfig?: Record<string, unknown> }).pluginConfig
  const rawPluginConfig =
    apiPluginConfig ??
    (
      (
        (rawGlobal?.['plugins'] as Record<string, unknown>)
          ?.['entries'] as Record<string, unknown>
      )?.['omg'] as Record<string, unknown>
    )?.['config'] ?? api.config

  const config = parseConfig(rawPluginConfig)
  console.error(`[omg] register: threshold=${config.observation.messageTokenThreshold}, triggerMode=${config.observation.triggerMode}`)

  // Probe for OpenClaw memory tools (optional — degrades gracefully to registry-only)
  const memoryTools = createMemoryTools(api)
  console.error(`[omg] register: ${memoryTools ? 'memory_search/memory_get tools available — hybrid scoring enabled' : 'registry-only scoring'}`)

  // Resolve workspaceDir from (in priority order):
  //   1. Host-provided api.workspaceDir (per-agent context, may be undefined at gateway level)
  //   2. Explicitly configured workspaceDir in plugins.entries.omg.config
  //   3. Agent default workspace from agents.defaults.workspace
  const agentDefaultWorkspace = (
    (rawGlobal?.['agents'] as Record<string, unknown>)
      ?.['defaults'] as Record<string, unknown>
  )?.['workspace'] as string | undefined

  const workspaceDir = api.workspaceDir ?? config.workspaceDir ?? agentDefaultWorkspace

  // Build the LLM generate function. The current OpenClaw plugin API does not
  // expose a `generate` method, so we create a direct Anthropic client using
  // the auth token from the gateway's auth-profiles store.
  const observerModel = config.observer.model ?? 'claude-sonnet-4-20250514'
  const generateFn = resolveGenerateFn(api, observerModel, config.observer.timeoutMs)
  const llmClient = createLlmClient(observerModel, generateFn)

  // Per-workspace bootstrap flag: tracks which workspaceDirs have already had
  // bootstrap triggered this gateway lifetime. Using a Set keyed by resolved
  // workspaceDir prevents double-bootstrap when multiple agents share the same
  // workspace, and correctly bootstraps each distinct workspace independently.
  const bootstrappedWorkspaces = new Set<string>()

  // Tracks workspaces for which cron jobs have been registered this gateway lifetime.
  // New workspaces encountered in before_prompt_build get cron jobs registered immediately
  // and are persisted to the registry for future gateway restarts.
  const registeredCronWorkspaces = new Set<string>()

  // Background bootstrap service — runs continuously, independent of agent turns.
  // Uses api.registerService (OpenClaw 2026.2.21+) when available, falls back to
  // a per-turn tick inside before_prompt_build for older hosts.
  const serviceAvailable = typeof (api as unknown as { registerService?: unknown }).registerService === 'function'
  if (serviceAvailable) {
    const registerService = (api as unknown as { registerService: (s: unknown) => void }).registerService
    registerService({
      id: 'omg-bootstrap',
      start: async () => {
        // Collect all known workspaces: registry + globally-resolved default.
        const registry = await readWorkspaceRegistry().catch(() => ({ version: 1 as const, workspaces: {} }))
        const pruned = pruneStaleWorkspaces(registry, config)
        const known = listWorkspacePaths(pruned)
        const all = workspaceDir ? [...new Set([...known, workspaceDir])] : known
        if (all.length === 0) return

        console.error(`[omg] service: bootstrap loop started for ${all.length} workspace(s): ${all.join(', ')}`)

        const tick = async () => {
          // Re-read registry each tick to pick up newly registered workspaces
          const current = await readWorkspaceRegistry().catch(() => ({ version: 1 as const, workspaces: {} }))
          const currentPruned = pruneStaleWorkspaces(current, config)
          const currentAll = workspaceDir
            ? [...new Set([...listWorkspacePaths(currentPruned), workspaceDir])]
            : listWorkspacePaths(currentPruned)

          for (const wsDir of currentAll) {
            try {
              await scaffoldGraphIfNeeded(wsDir, config)
              const omgRoot = resolveOmgRoot(wsDir, config)
              const result = await runBootstrapTick({ workspaceDir: wsDir, config, llmClient })

              // Run maintenance when bootstrap just completed on this tick
              const needsMaintenance = result.completed

              // Also run maintenance if bootstrap completed on a prior tick but
              // maintenance was interrupted (e.g. gateway restart)
              const pendingMaintenance = !needsMaintenance && !result.ran
                && await readBootstrapState(omgRoot).then(
                    (s) => s?.status === 'completed' && !s.maintenanceDone,
                    () => false,
                  )

              if (needsMaintenance || pendingMaintenance) {
                await graphMaintenanceCronHandler({ workspaceDir: wsDir, config, llmClient }, 0)  // ageCutoffMs=0: all nodes eligible post-bootstrap
                const state = await readBootstrapState(omgRoot)
                if (state) await writeBootstrapState(omgRoot, markMaintenanceDone(state))
              }
            } catch (err) {
              console.error(`[omg] service: bootstrap tick failed for ${wsDir}:`, err)
            }
          }
        }

        await tick()
        setInterval(tick, 5 * 60 * 1000) // retry every 5 min
      },
    })
  }

  api.on('before_prompt_build', async (event, ctx) => {
    // ctx.workspaceDir is populated per-agent by OpenClaw (PluginHookAgentContext).
    // It takes priority over the globally-resolved workspaceDir so that agents with
    // separate workspaces (e.g. "coding" → ~/TechLead, "pati" → ~/Secretary) each
    // get their own graph rather than sharing the default workspace.
    const effectiveWorkspaceDir = (ctx as unknown as { workspaceDir?: string }).workspaceDir ?? workspaceDir
    if (!effectiveWorkspaceDir) return Promise.resolve(undefined)

    // Scaffold once per workspace per gateway lifetime (cheap, idempotent).
    if (!bootstrappedWorkspaces.has(effectiveWorkspaceDir)) {
      bootstrappedWorkspaces.add(effectiveWorkspaceDir)
      scaffoldGraphIfNeeded(effectiveWorkspaceDir, config)
        .catch((err) => console.error('[omg] before_prompt_build: scaffold failed:', err))
        .then(() => {
          // Fallback: service API unavailable (old host) → run one bounded tick per turn
          if (!serviceAvailable) {
            const omgRoot = resolveOmgRoot(effectiveWorkspaceDir, config)
            return runBootstrapTick({ workspaceDir: effectiveWorkspaceDir, config, llmClient })
              .then(async (result) => {
                const needsMaintenance = result.completed
                const pendingMaintenance = !needsMaintenance && !result.ran
                  && await readBootstrapState(omgRoot).then(
                      (s) => s?.status === 'completed' && !s.maintenanceDone,
                      () => false,
                    )
                if (needsMaintenance || pendingMaintenance) {
                  await graphMaintenanceCronHandler({ workspaceDir: effectiveWorkspaceDir, config, llmClient }, 0)
                  const state = await readBootstrapState(omgRoot)
                  if (state) await writeBootstrapState(omgRoot, markMaintenanceDone(state))
                }
              })
              .catch((err) => console.error('[omg] before_prompt_build: bootstrap tick failed:', err))
          }
        })
        .catch((err) => console.error('[omg] before_prompt_build: scaffold failed:', err))
    }

    if (!registeredCronWorkspaces.has(effectiveWorkspaceDir)) {
      registeredCronWorkspaces.add(effectiveWorkspaceDir)

      // Persist new workspace to registry — fire-and-forget.
      addWorkspaceToRegistry(effectiveWorkspaceDir)
        .catch(err => console.error('[omg] before_prompt_build: registry write failed:', err))

      // Register crons if host supports scheduleCron (legacy path)
      if (typeof api.scheduleCron === 'function') {
        const cronCtx = {
          workspaceDir: effectiveWorkspaceDir,
          config,
          llmClient,
          jobIdNamespace: effectiveWorkspaceDir,
        }
        try {
          registerCronJobs(api, config, cronCtx)
        } catch (err) {
          console.error(`[omg] before_prompt_build: cron registration failed for ${effectiveWorkspaceDir}:`, err)
        }
      }
    }

    const sessionKey = ctx.sessionKey ?? 'default'
    const result = await beforeAgentStart(event, { workspaceDir: effectiveWorkspaceDir, sessionKey, config, memoryTools })
    if (result) {
      const chars = result.prependContext.length
      const estTokens = Math.ceil(chars / 4)
      const nodeIds = [...result.prependContext.matchAll(/<!-- (omg\/[^ ]+)/g)].map(m => m[1])
      console.error(`[omg] context-injection [${sessionKey}]: ${estTokens} tokens (~${chars} chars), ${nodeIds.length} nodes: ${nodeIds.join(', ')}`)
    }
    return result
  })

  api.on('agent_end', (event, ctx) => {
    const effectiveWorkspaceDir = (ctx as unknown as { workspaceDir?: string }).workspaceDir ?? workspaceDir
    if (!effectiveWorkspaceDir) return Promise.resolve(undefined)
    // sessionKey may be undefined for CLI-initiated sessions. Use a stable fallback
    // so session state is still persisted (keyed by agentId or a default label).
    const sessionKey = ctx.sessionKey ?? ctx.agentId ?? 'default'
    // Messages are passed in the event object by the gateway, not in ctx.
    // ctx only contains agentId, sessionKey, workspaceDir.
    // Gateway messages use Anthropic API format (content as array of blocks),
    // so we normalize them to our Message type (content as plain string).
    const rawMessages = (event as unknown as { messages?: readonly unknown[] }).messages ?? ctx.messages ?? []
    const messages = normalizeMessages(rawMessages)
    console.error(`[omg] agent_end [${sessionKey}]: messages=${messages.length}, threshold=${config.observation.messageTokenThreshold}, triggerMode=${config.observation.triggerMode}`)
    return agentEnd(event, {
      workspaceDir: effectiveWorkspaceDir,
      sessionKey,
      messages,
      config,
      llmClient,
    })
  })

  api.on('before_compaction', (_event, ctx) => {
    const effectiveWorkspaceDir = (ctx as unknown as { workspaceDir?: string }).workspaceDir ?? workspaceDir
    if (!effectiveWorkspaceDir) return Promise.resolve(undefined)
    const sessionKey = ctx.sessionKey ?? 'default'
    const rawMessages = (ctx.messages ?? []) as readonly unknown[]
    return beforeCompaction(_event, {
      workspaceDir: effectiveWorkspaceDir,
      sessionKey,
      messages: normalizeMessages(rawMessages),
      config,
      llmClient,
    })
  })

  api.on('tool_result_persist', (event) => toolResultPersist(event))

  api.on('gateway_start', async () => {
    // Auto-enable the gateway's /v1/chat/completions endpoint if not already on.
    // The OMG plugin needs this to route LLM calls through OpenClaw's model providers.
    await ensureChatCompletionsEnabled(api).catch((err) =>
      console.error('[omg] gateway_start: failed to auto-enable chatCompletions endpoint:', err)
    )

    // Load the persistent workspace registry; prune entries whose omgRoot no longer exists.
    const registry = await readWorkspaceRegistry()
      .catch(() => ({ version: 1 as const, workspaces: {} }))
    const pruned = pruneStaleWorkspaces(registry, config)

    // Merge registry workspaces with the globally-resolved workspace (if any).
    const known = listWorkspacePaths(pruned)
    const all = workspaceDir ? [...new Set([...known, workspaceDir])] : known

    if (all.length > 20) {
      console.warn(`[omg] gateway_start: ${all.length} workspaces — check ~/.openclaw/omg-workspaces.json`)
    }

    for (const wsDir of all) {
      await scaffoldGraphIfNeeded(wsDir, config).catch((err) =>
        console.error(`[omg] gateway_start: scaffold failed for ${wsDir}:`, err)
      )
      const cronCtx = { workspaceDir: wsDir, config, llmClient, jobIdNamespace: wsDir }
      try {
        registerCronJobs(api, config, cronCtx)
        registeredCronWorkspaces.add(wsDir)
      } catch (err) {
        console.error(`[omg] gateway_start: cron registration failed for ${wsDir}:`, err)
      }
    }

    await writeWorkspaceRegistry(pruned).catch((err) =>
      console.error('[omg] gateway_start: registry write failed:', err)
    )
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
          .option('--force', 'Re-run bootstrap from scratch, ignoring previous state')
          .option('--source <source>', 'Source to ingest: memory|logs|sqlite|all', 'all')
          .option('--retry-failed', 'Retry only batches that failed in a previous run')
          .option('--timeout <ms>', 'Override LLM timeout for retry (5000-600000)')
          .option('--error-type <type>', 'Filter retry by error type: llm-error|parse-empty|zero-operations|write-all-failed')
          .option('--batches <indices>', 'Comma-separated batch indices to retry (e.g. "6,12,25")')
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
              const stateFile = omgRoot ? `${omgRoot}/.bootstrap-state.json` : '<omgRoot>/.bootstrap-state.json'
              console.error(
                '[omg] bootstrap: api.generate is not available in the CLI context.\n' +
                'Bootstrap requires an active agent session to access the LLM.\n' +
                'It will run automatically on the next agent turn if the graph is empty.\n' +
                `To force a re-run: delete the state file and start a new session:\n  rm ${stateFile}`
              )
              return
            }
            if (!workspaceDir) {
              console.error('[omg] bootstrap: workspaceDir is not available')
              return
            }
            if (Boolean(opts['retryFailed'])) {
              // Validate --timeout
              let retryTimeoutMs: number | undefined
              if (opts['timeout'] !== undefined) {
                retryTimeoutMs = Number(opts['timeout'])
                if (!Number.isInteger(retryTimeoutMs) || retryTimeoutMs < 5_000 || retryTimeoutMs > 600_000) {
                  console.error('[omg] bootstrap retry: --timeout must be an integer between 5000 and 600000')
                  return
                }
              }

              // Validate --error-type
              let errorTypeFilter: FailureErrorType | undefined
              if (opts['errorType'] !== undefined) {
                const raw = String(opts['errorType'])
                if (!(FAILURE_ERROR_TYPES as readonly string[]).includes(raw)) {
                  console.error(`[omg] bootstrap retry: --error-type must be one of: ${FAILURE_ERROR_TYPES.join(', ')}`)
                  return
                }
                errorTypeFilter = raw as FailureErrorType
              }

              // Validate --batches
              let retryBatchIndices: readonly number[] | undefined
              if (opts['batches'] !== undefined) {
                try {
                  retryBatchIndices = parseBatchIndices(String(opts['batches']))
                } catch (err) {
                  console.error(`[omg] bootstrap retry: ${err instanceof Error ? err.message : String(err)}`)
                  return
                }
                if (retryBatchIndices.length === 0) {
                  console.error('[omg] bootstrap retry: --batches must specify at least one batch index')
                  return
                }
              }

              // Build factory closure for timeout override
              const rawGlobal = api.config as Record<string, unknown>
              const port = resolveGatewayPort(rawGlobal)
              const authToken = resolveGatewayAuthToken(rawGlobal)
              const retryLlmClientFactory = (overrideMs: number): ReturnType<typeof createLlmClient> => {
                const fn = createGatewayCompletionsGenerateFn({ port, authToken, model: observerModel, timeoutMs: overrideMs })
                return createLlmClient(observerModel, fn)
              }

              const result = await runBootstrapRetry({
                workspaceDir,
                config,
                llmClient,
                timeoutMs: retryTimeoutMs,
                errorTypeFilter,
                batchIndices: retryBatchIndices,
                createLlmClientWithTimeout: retryLlmClientFactory,
              })
              if (!result.ran) {
                console.log('[omg] bootstrap retry: no failures to retry')
              }
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
