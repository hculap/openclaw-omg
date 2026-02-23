# openclaw-omg

OpenClaw plugin — Observational Memory Graph (OMG).

Builds a persistent knowledge graph from conversation history, injecting relevant context before each agent turn.

## Build & Test

```bash
pnpm install
pnpm test          # 670 tests
pnpm typecheck     # tsc --noEmit
```

## Installation

Add to `openclaw.json` — everything else is automatic:

```json
{
  "plugins": {
    "load": { "paths": ["/path/to/openclaw-omg"] },
    "entries": { "omg": { "enabled": true } }
  }
}
```

Restart the gateway. On first boot the plugin:
1. Auto-enables `gateway.http.endpoints.chatCompletions` (writes config, gateway self-restarts)
2. Scaffolds `memory/omg/` directory structure with template files
3. Registers the daily 3 AM reflection cron job
4. Fires bootstrap fire-and-forget (ingests existing memory files / logs / sqlite)

On every agent turn:
- `before_prompt_build` → injects relevant graph nodes as `<omg-context>` in the prompt
- `agent_end` → observes the conversation, creates/updates graph nodes

No API keys needed — LLM calls route through the gateway's own `/v1/chat/completions` endpoint using whatever model provider OpenClaw is already configured with.

## Multi-Agent / Multi-Workspace Setup

**How OpenClaw loads the plugin:** `register(api)` is called **once** at gateway startup, not once per agent. The plugin receives the full global config via `api.config` and must handle all agents within that single registration.

**How per-agent workspace is resolved** — the plugin uses a three-level cascade:

| Priority | Source | When it applies |
|----------|--------|-----------------|
| 1st | `ctx.workspaceDir` from hook context | OpenClaw 2026.2+ passes per-agent workspace on every hook call |
| 2nd | `api.workspaceDir` at `register()` time | Set when the gateway is started in a per-agent context (rare) |
| 3rd | `config.workspaceDir` in plugin config | Explicit override in `plugins.entries.omg.config` |
| 4th | `agents.defaults.workspace` | Global fallback from agent defaults |

For a typical setup with multiple agents sharing one workspace (e.g. `pati`, `email-triage`, `whatsapp-triage` all using `~/Secretary`) the default workspace fallback works correctly — all agents share one graph, which is intentional.

**For agents with separate workspaces** (e.g. a `coding` agent using `~/TechLead` alongside a `pati` agent using `~/Secretary`), the plugin picks up `ctx.workspaceDir` from each hook call, so each agent's sessions read/write their own graph. This requires OpenClaw to populate `ctx.workspaceDir` per hook call (confirmed in `PluginHookAgentContext` type).

**Session isolation:** Each conversation gets a unique `sessionKey` (e.g. `"session-abc123"`). Session state is stored at:
```
{workspaceDir}/.omg-state/{sessionKey}.json
```
This tracks per-session token counts and observation boundaries so sessions never interfere with each other. The shared graph under `memory/omg/nodes/` accumulates knowledge from all sessions.

**What `sessionKey` is:** An opaque string from the gateway. Could be a UUID, a Telegram message thread ID, or a timestamp-based key depending on the channel. The plugin treats it as a stable, path-safe identifier for the duration of one conversation.

**Agent name (`agentId`):** Available in hook context but not used as a graph namespace — the graph is shared across agents operating on the same workspace. The `agentId` is used only as a fallback `sessionKey` when the gateway doesn't provide one.

### Example: two agents, two workspaces

```
Gateway (single process)
├── pati agent        → workspace: ~/Secretary   → graph: ~/Secretary/memory/omg/
│   sessions: session-abc, session-def, ...
│   state:    ~/Secretary/.omg-state/session-abc.json
│
└── coding agent      → workspace: ~/TechLead    → graph: ~/TechLead/memory/omg/
    sessions: session-xyz, ...
    state:    ~/TechLead/.omg-state/session-xyz.json
```

Both graphs are independent. Bootstrap runs once per workspace. Cron reflection runs on the workspace resolved at `gateway_start` (the global default); see Known Limitations below.

### Known Limitations

1. **Cron runs on one workspace only.** The cron reflection job is registered once at `gateway_start` using the globally-resolved workspace. If you have agents with different workspaces, only the default workspace gets scheduled nightly reflection. Workaround: set `config.workspaceDir` explicitly per-agent via per-agent plugin config (not yet supported by OpenClaw — it sends one global config to the plugin).

2. **Bootstrap fires once per gateway lifetime, for the default workspace.** The `bootstrapTriggeredFromSession` flag prevents double-bootstrap within one gateway lifetime, but it's a single boolean shared across all agents. If `pati` boots first and triggers bootstrap for `~/Secretary`, the `coding` agent's workspace `~/TechLead` won't bootstrap from `gateway_start` — it bootstraps from `before_prompt_build` on the first message to the `coding` agent (the flag is per-workspaceDir check, not per-flag).

   Actually: `before_prompt_build` also guards with the `bootstrapTriggeredFromSession` flag — so if `pati` runs first and sets the flag, `coding` won't bootstrap. **This is a bug** — the flag should be per-workspace or completely removed in favour of the sentinel-only approach.

3. **`chatCompletions` auto-enable triggers a gateway restart.** On first install, `gateway_start` writes the config patch, the file watcher detects it (~500ms debounce), and the gateway restarts. The first boot's bootstrap attempt may use the direct-API fallback during that window. After restart everything routes through the gateway.

## Configuration

All fields are optional with sensible defaults. An empty `{}` config is fully valid.

```json
{
  "plugins": {
    "entries": {
      "omg": {
        "enabled": true,
        "config": {
          "storagePath": "memory/omg",
          "observation": {
            "triggerMode": "threshold",
            "messageTokenThreshold": 30000
          },
          "reflection": {
            "cronSchedule": "0 3 * * *",
            "observationTokenThreshold": 40000
          },
          "injection": {
            "maxContextTokens": 4000,
            "maxMocs": 3,
            "maxNodes": 5
          },
          "observer": { "model": null },
          "reflector": { "model": null }
        }
      }
    }
  }
}
```

`model: null` inherits the gateway's active model. Set to e.g. `"openai-codex/gpt-5.3-codex"` to use a specific model for observation/reflection.

`triggerMode` options:
- `"threshold"` — observe after `messageTokenThreshold` tokens accumulate (default, production)
- `"every-turn"` — observe after every agent turn (dev/test mode)
- `"manual"` — only when explicitly invoked

## OpenClaw Plugin API — Discovered Quirks

Critical findings from debugging against a live gateway.

### api.config is the FULL global openclaw.json

Plugin-specific config is nested at `api.config.plugins.entries.omg.config`, NOT at `api.config` directly. Extract it explicitly:

```typescript
const rawGlobal = api.config as Record<string, unknown>
const rawPluginConfig =
  (
    ((rawGlobal?.['plugins'] as Record<string, unknown>)
      ?.['entries'] as Record<string, unknown>)
    ?.['omg'] as Record<string, unknown>
  )?.['config'] ?? api.config  // fallback for backward compat
```

### api.workspaceDir is undefined at gateway level

Only populated for per-agent sessions, not global gateway plugin registration. Resolve from multiple sources:

```typescript
// Priority: ctx.workspaceDir → api.workspaceDir → config.workspaceDir → agents.defaults.workspace
const agentDefaultWorkspace = (rawGlobal?.['agents'] as any)?.['defaults']?.['workspace']
const workspaceDir = ctx.workspaceDir ?? api.workspaceDir ?? config.workspaceDir ?? agentDefaultWorkspace
```

### api.generate is NOT on the plugin API

The OpenClaw plugin API (`OpenClawPluginApi`) does not expose a `generate` method. LLM calls must go through the gateway's `/v1/chat/completions` endpoint:

```
http://127.0.0.1:{gateway.port}/v1/chat/completions
Authorization: Bearer {gateway.auth.token}
```

Requires `gateway.http.endpoints.chatCompletions.enabled: true` in config. The plugin auto-enables this on `gateway_start` via `runtime.config.writeConfigFile`.

### api.scheduleCron is not always available

Guard before using:

```typescript
if (typeof api.scheduleCron !== 'function') {
  console.warn('[omg] scheduleCron not available — cron jobs will not run')
  return
}
```

### CLI action receives positional args differently

`program.command('omg bootstrap')` in commander creates command `omg` with positional arg `bootstrap`, not a nested subcommand. Action signature is `(...positionalArgs, options, command)`:

```typescript
.action(async (...actionArgs: unknown[]) => {
  // opts is second-to-last: (bootstrapArg, opts, command)
  const opts = (actionArgs.length >= 2
    ? actionArgs[actionArgs.length - 2]
    : {}) as Record<string, unknown>
  const force = Boolean(opts['force'])
})
```

`JSON.stringify(args)` crashes because the last arg is a circular Command object.

### api.generate is not available in CLI context

`openclaw omg bootstrap` runs in a separate CLI process without LLM access. Bootstrap runs automatically from the first agent session. To force a re-run:

```bash
rm <omgRoot>/.bootstrap-done   # delete sentinel → bootstrap re-runs on next agent turn
```

## Bootstrap Flow

1. **gateway_start**: scaffold directory, register cron jobs, auto-enable chatCompletions. Fire-and-forget bootstrap if graph is empty.
2. **before_prompt_build (first call)**: check if graph is empty, trigger bootstrap fire-and-forget. LLM available here.
3. **CLI `openclaw omg bootstrap`**: fails with clear error — no LLM in CLI context.

Sentinel: `{omgRoot}/.bootstrap-done` — prevents re-ingestion. Delete to force re-run.

## Gateway config auto-enable

The plugin patches `gateway.http.endpoints.chatCompletions.enabled: true` on first boot:
- Reads current config via `runtime.config.loadConfig()`
- Merges the change immutably
- Writes back via `runtime.config.writeConfigFile()`
- The `"gateway.*"` reload rule triggers a full gateway restart within ~500ms
- On second boot, the patch is a no-op (already enabled)

Gateway config file: `~/.openclaw/openclaw.json` (NOT `~/.clawdbot/clawdbot.json`).
Auth token: `gateway.auth.token` (different from the clawdbot config!).
