# openclaw-omg

OpenClaw plugin — Observational Memory Graph (OMG).

Builds a persistent knowledge graph from conversation history, injecting relevant context before each agent turn.

## Build & Test

```bash
pnpm install
pnpm test          # 670 tests
pnpm typecheck     # tsc --noEmit
```

## OpenClaw Plugin API — Discovered Quirks

Critical findings from debugging against a live gateway. Future development must account for all of these.

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
// Priority: api.workspaceDir → config.workspaceDir → agents.defaults.workspace
const agentDefaultWorkspace = (rawGlobal?.['agents'] as any)?.['defaults']?.['workspace']
const workspaceDir = api.workspaceDir ?? config.workspaceDir ?? agentDefaultWorkspace
```

### api.generate is NOT available at gateway_start or CLI time

Only available during active agent sessions (before_prompt_build, agent_end, before_compaction). Use a lazy wrapper so it's read at call time:

```typescript
const llmClient = createLlmClient(model, (params) => {
  const generate = api.generate as unknown
  if (typeof generate !== 'function') {
    throw new Error('[omg] api.generate is not available in this plugin context')
  }
  return (generate as GenerateFn)(params)
})
```

Bootstrap trigger: fire-and-forget from `before_prompt_build` (first call only), since that's where `api.generate` is available.

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

`openclaw omg bootstrap` runs in a separate CLI process without `api.generate`. Bootstrap cannot run from CLI — it runs automatically from the first agent session. Tell users:

```
rm <omgRoot>/.bootstrap-done  # delete sentinel → bootstrap re-runs on next agent turn
```

## Bootstrap Flow

1. **gateway_start**: scaffold directory, register cron jobs. If `api.generate` is available (rare), trigger bootstrap fire-and-forget.
2. **before_prompt_build (first call)**: check if graph is empty, trigger bootstrap fire-and-forget. `api.generate` IS available here.
3. **CLI `openclaw omg bootstrap`**: fails with clear error if `api.generate` unavailable. Works if openclaw provides `api.generate` in CLI context in the future.

Sentinel: `{omgRoot}/.bootstrap-done` — prevents re-ingestion. Delete to force re-run.

## Configuration

In `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "omg": {
        "enabled": true,
        "config": {
          "workspaceDir": "/path/to/workspace",
          "storagePath": "memory/omg",
          "observation": { "triggerMode": "threshold", "messageTokenThreshold": 30000 },
          "reflection": { "cronSchedule": "0 3 * * *", "observationTokenThreshold": 40000 },
          "injection": { "maxContextTokens": 4000, "maxMocs": 3, "maxNodes": 5 },
          "observer": { "model": null },
          "reflector": { "model": null }
        }
      }
    }
  }
}
```

`model: null` inherits the active agent's model via `api.generate`.

## Gateway Restart

The gateway takes ~25 seconds to start. `launchctl kickstart` may not work — use:

```bash
kill -TERM <pid>
sleep 25
# gateway restarts automatically via LaunchAgent
```
