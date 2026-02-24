/**
 * Live test helpers — shared utilities for real gateway testing.
 *
 * All live tests are gated behind OPENCLAW_LIVE=1 env var.
 * These helpers read real filesystem state and talk to the real gateway.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GATEWAY_PORT = Number(process.env['OPENCLAW_GATEWAY_PORT'] ?? 18789)
export const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`

/** Max batches for capped bootstrap runs. Override via LIVE_TEST_BATCH_CAP. */
export const BATCH_CAP = Number(process.env['LIVE_TEST_BATCH_CAP'] ?? 10)

/** Hard cap on total LLM calls across the entire test run. */
export const MAX_LLM_CALLS = Number(process.env['LIVE_TEST_MAX_LLM_CALLS'] ?? 50)

/** Hard cap on estimated input tokens across the entire run. */
export const MAX_INPUT_TOKENS = Number(process.env['LIVE_TEST_MAX_INPUT_TOKENS'] ?? 500_000)

/** Secretary workspace (default agent workspace). */
export const SECRETARY_WORKSPACE = '/Users/szymonpaluch/Projects/Personal/Secretary'

/** TechLead workspace. */
export const TECHLEAD_WORKSPACE = '/Users/szymonpaluch/Projects/Personal/TechLead'

/** OpenClaw config path. */
export const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json')

/** OpenClaw memory dir (SQLite databases). */
export const OPENCLAW_MEMORY_DIR = path.join(os.homedir(), '.openclaw', 'memory')

/** Artifacts directory for this run. */
export const ARTIFACTS_DIR = path.join(
  process.cwd(),
  'tests/live/artifacts',
  new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
)

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/** Skip the entire test file if OPENCLAW_LIVE is not set. */
export function requireLiveEnv(): void {
  if (!process.env['OPENCLAW_LIVE']) {
    throw new Error(
      'Live tests require OPENCLAW_LIVE=1. Run: pnpm test:live'
    )
  }
}

// ---------------------------------------------------------------------------
// LLM call tracker (Fix #2 — hard spend cap)
// ---------------------------------------------------------------------------

export class LlmSpendCapExceededError extends Error {
  constructor(metric: string, current: number, limit: number) {
    super(`LLM spend cap exceeded: ${metric}=${current} >= limit=${limit}. Aborting to prevent token drain.`)
    this.name = 'LlmSpendCapExceededError'
  }
}

/** Global singleton tracking LLM calls across all phases. */
class LlmCallTracker {
  private _calls = 0
  private _inputTokens = 0
  private _outputTokens = 0
  private readonly _log: Array<{
    readonly timestamp: number
    readonly inputTokens: number
    readonly outputTokens: number
    readonly phase: string
  }> = []

  get calls(): number { return this._calls }
  get inputTokens(): number { return this._inputTokens }
  get outputTokens(): number { return this._outputTokens }
  get log(): ReadonlyArray<typeof this._log[number]> { return this._log }

  record(inputTokens: number, outputTokens: number, phase: string): void {
    this._calls++
    this._inputTokens += inputTokens
    this._outputTokens += outputTokens
    this._log.push({ timestamp: Date.now(), inputTokens, outputTokens, phase })

    if (this._calls >= MAX_LLM_CALLS) {
      throw new LlmSpendCapExceededError('calls', this._calls, MAX_LLM_CALLS)
    }
    if (this._inputTokens >= MAX_INPUT_TOKENS) {
      throw new LlmSpendCapExceededError('inputTokens', this._inputTokens, MAX_INPUT_TOKENS)
    }
  }

  summary(): string {
    return `LLM calls: ${this._calls}/${MAX_LLM_CALLS}, input tokens: ${this._inputTokens.toLocaleString()}/${MAX_INPUT_TOKENS.toLocaleString()}, output tokens: ${this._outputTokens.toLocaleString()}`
  }
}

export const llmTracker = new LlmCallTracker()

/**
 * Wraps a gateway generate function with call tracking and spend caps.
 * Throws LlmSpendCapExceededError if limits are breached.
 */
export function wrapGenerateFnWithTracker(
  generateFn: (params: { system: string; user: string; maxTokens: number }) => Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }>,
  phase: string,
): typeof generateFn {
  return async (params) => {
    const result = await generateFn(params)
    llmTracker.record(result.usage.inputTokens, result.usage.outputTokens, phase)
    return result
  }
}

// ---------------------------------------------------------------------------
// Artifacts (Fix #7 — debug artifacts)
// ---------------------------------------------------------------------------

/** Ensure artifacts directory exists. */
export function ensureArtifactsDir(): void {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true })
}

/** Write a JSON artifact for debugging. */
export function writeArtifact(name: string, data: unknown): string {
  ensureArtifactsDir()
  const filePath = path.join(ARTIFACTS_DIR, name)
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
  return filePath
}

/** Write the LLM tracker summary as an artifact. */
export function writeTrackerArtifact(): string {
  return writeArtifact('llm-tracker.json', {
    summary: llmTracker.summary(),
    calls: llmTracker.calls,
    inputTokens: llmTracker.inputTokens,
    outputTokens: llmTracker.outputTokens,
    log: llmTracker.log,
  })
}

/** Write a registry summary artifact (counts by type/kind). */
export function writeRegistrySummaryArtifact(omgRoot: string): string | null {
  const registryPath = path.join(omgRoot, 'registry.json')
  if (!fs.existsSync(registryPath)) return null

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as Record<string, Record<string, unknown>>
  const byType: Record<string, number> = {}
  let total = 0
  let archived = 0

  for (const entry of Object.values(registry)) {
    const type = String(entry['type'] ?? 'unknown')
    byType[type] = (byType[type] ?? 0) + 1
    total++
    if (entry['archived']) archived++
  }

  return writeArtifact('registry-summary.json', { total, archived, byType })
}

/** List files created/modified under omgRoot. */
export function writeFileListArtifact(omgRoot: string): string {
  const files: Array<{ path: string; size: number; mtime: string }> = []

  function walk(dir: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else {
          const stat = fs.statSync(full)
          files.push({
            path: path.relative(omgRoot, full),
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          })
        }
      }
    } catch { /* ignore */ }
  }

  if (fs.existsSync(omgRoot)) walk(omgRoot)
  return writeArtifact('file-list.json', files)
}

// ---------------------------------------------------------------------------
// File hashing (Fix #6 — idempotency detection)
// ---------------------------------------------------------------------------

/** Compute SHA-256 hash of a file's contents. Returns null if file missing. */
export function hashFile(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath)
    return crypto.createHash('sha256').update(content).digest('hex')
  } catch {
    return null
  }
}

/** Hash all .md files under a directory. Returns Map<relativePath, hash>. */
export function hashDirectory(dir: string): Map<string, string> {
  const hashes = new Map<string, string>()
  function walk(current: string): void {
    try {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name)
        if (entry.isDirectory()) {
          walk(full)
        } else if (entry.name.endsWith('.md') || entry.name.endsWith('.json')) {
          const hash = hashFile(full)
          if (hash) hashes.set(path.relative(dir, full), hash)
        }
      }
    } catch { /* ignore */ }
  }
  if (fs.existsSync(dir)) walk(dir)
  return hashes
}

// ---------------------------------------------------------------------------
// Injected file size checks (Fix #4 — token bloat prevention)
// ---------------------------------------------------------------------------

/** Max allowed size for known injected files (bytes). */
const INJECTED_FILE_LIMITS: Record<string, number> = {
  'MEMORY.md': 12 * 1024,    // 12KB limit (real agent memory typically 8-12KB)
  'SYSTEM.md': 16 * 1024,    // 16KB
  'NOW.md': 8 * 1024,        // 8KB
  'LEARNINGS.md': 16 * 1024, // 16KB
}

export interface InjectedFileSizeCheck {
  readonly file: string
  readonly path: string
  readonly size: number
  readonly limit: number
  readonly ok: boolean
}

/** Check known injected files for size bloat. */
export function checkInjectedFileSizes(workspaceDir: string): readonly InjectedFileSizeCheck[] {
  const results: InjectedFileSizeCheck[] = []

  for (const [file, limit] of Object.entries(INJECTED_FILE_LIMITS)) {
    // Check both workspace root and memory/ subdirectory
    for (const candidate of [
      path.join(workspaceDir, file),
      path.join(workspaceDir, 'memory', file),
    ]) {
      if (fs.existsSync(candidate)) {
        const size = fs.statSync(candidate).size
        results.push({ file, path: candidate, size, limit, ok: size <= limit })
      }
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Gateway health
// ---------------------------------------------------------------------------

/** Check if the gateway is reachable. Returns status code or null. */
export async function gatewayHealthCheck(): Promise<number | null> {
  try {
    const response = await fetch(`${GATEWAY_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    })
    return response.status
  } catch {
    return null
  }
}

/** Check if the gateway /v1/chat/completions endpoint responds. */
export async function gatewayCompletionsCheck(authToken?: string): Promise<{
  readonly reachable: boolean
  readonly status: number | null
  readonly error: string | null
}> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`
  }

  try {
    const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    return { reachable: true, status: response.status, error: null }
  } catch (err) {
    return {
      reachable: false,
      status: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ---------------------------------------------------------------------------
// Config reading
// ---------------------------------------------------------------------------

export interface OpenClawConfig {
  readonly raw: Record<string, unknown>
  readonly pluginEnabled: boolean
  readonly pluginConfig: Record<string, unknown>
  readonly gatewayAuthToken: string | undefined
  readonly defaultModel: string | undefined
  readonly chatCompletionsEnabled: boolean
}

export function readOpenClawConfig(): OpenClawConfig {
  const raw = JSON.parse(fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')) as Record<string, unknown>

  const plugins = raw['plugins'] as Record<string, unknown> | undefined
  const entries = plugins?.['entries'] as Record<string, unknown> | undefined
  const omg = entries?.['omg'] as Record<string, unknown> | undefined

  const gateway = raw['gateway'] as Record<string, unknown> | undefined
  const auth = gateway?.['auth'] as Record<string, unknown> | undefined
  const http = gateway?.['http'] as Record<string, unknown> | undefined
  const endpoints = http?.['endpoints'] as Record<string, unknown> | undefined
  const chatCompletions = endpoints?.['chatCompletions'] as Record<string, unknown> | undefined

  const agents = raw['agents'] as Record<string, unknown> | undefined
  const defaults = agents?.['defaults'] as Record<string, unknown> | undefined
  const model = defaults?.['model'] as Record<string, unknown> | undefined

  return {
    raw,
    pluginEnabled: omg?.['enabled'] === true,
    pluginConfig: (omg?.['config'] as Record<string, unknown>) ?? {},
    gatewayAuthToken: auth?.['token'] as string | undefined,
    defaultModel: model?.['primary'] as string | undefined,
    chatCompletionsEnabled: chatCompletions?.['enabled'] === true,
  }
}

// ---------------------------------------------------------------------------
// OMG state inspection
// ---------------------------------------------------------------------------

export interface OmgWorkspaceState {
  readonly omgRoot: string
  readonly exists: boolean
  readonly hasIndex: boolean
  readonly hasNow: boolean
  readonly hasRegistry: boolean
  readonly hasBootstrapState: boolean
  readonly hasBootstrapLock: boolean
  readonly hasBootstrapDone: boolean
  readonly nodeCount: number
  readonly mocCount: number
  readonly nodeTypes: readonly string[]
}

export function inspectOmgWorkspace(workspaceDir: string, storagePath = 'memory/omg'): OmgWorkspaceState {
  const omgRoot = path.join(workspaceDir, storagePath)

  if (!fs.existsSync(omgRoot)) {
    return {
      omgRoot,
      exists: false,
      hasIndex: false,
      hasNow: false,
      hasRegistry: false,
      hasBootstrapState: false,
      hasBootstrapLock: false,
      hasBootstrapDone: false,
      nodeCount: 0,
      mocCount: 0,
      nodeTypes: [],
    }
  }

  const nodesDir = path.join(omgRoot, 'nodes')
  const mocsDir = path.join(omgRoot, 'mocs')

  const nodeTypes: string[] = []
  let nodeCount = 0
  if (fs.existsSync(nodesDir)) {
    for (const typeDir of fs.readdirSync(nodesDir)) {
      const typePath = path.join(nodesDir, typeDir)
      if (fs.statSync(typePath).isDirectory()) {
        nodeTypes.push(typeDir)
        const countInType = countMdFiles(typePath)
        nodeCount += countInType
      }
    }
  }

  let mocCount = 0
  if (fs.existsSync(mocsDir)) {
    mocCount = countMdFiles(mocsDir)
  }

  return {
    omgRoot,
    exists: true,
    hasIndex: fs.existsSync(path.join(omgRoot, 'index.md')),
    hasNow: fs.existsSync(path.join(omgRoot, 'now.md')),
    hasRegistry: fs.existsSync(path.join(omgRoot, 'registry.json')),
    hasBootstrapState: fs.existsSync(path.join(omgRoot, '.bootstrap-state.json')),
    hasBootstrapLock: fs.existsSync(path.join(omgRoot, '.bootstrap-lock')),
    hasBootstrapDone: fs.existsSync(path.join(omgRoot, '.bootstrap-done')),
    nodeCount,
    mocCount,
    nodeTypes,
  }
}

function countMdFiles(dir: string): number {
  let count = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        count++
      } else if (entry.isDirectory()) {
        count += countMdFiles(path.join(dir, entry.name))
      }
    }
  } catch {
    // ignore
  }
  return count
}

// ---------------------------------------------------------------------------
// Bootstrap state
// ---------------------------------------------------------------------------

export interface BootstrapState {
  readonly version: number
  readonly status: string
  readonly startedAt: string
  readonly updatedAt: string
  readonly cursor: number
  readonly total: number
  readonly ok: number
  readonly fail: number
  readonly done: readonly number[]
  readonly lastError: string | null
}

export function readBootstrapState(omgRoot: string): BootstrapState | null {
  const statePath = path.join(omgRoot, '.bootstrap-state.json')
  try {
    const raw = fs.readFileSync(statePath, 'utf-8')
    return JSON.parse(raw) as BootstrapState
  } catch {
    return null
  }
}

export function readBootstrapLock(omgRoot: string): Record<string, unknown> | null {
  const lockPath = path.join(omgRoot, '.bootstrap-lock')
  try {
    const raw = fs.readFileSync(lockPath, 'utf-8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// SQLite inspection
// ---------------------------------------------------------------------------

export function listSqliteDatabases(): readonly string[] {
  try {
    return fs.readdirSync(OPENCLAW_MEMORY_DIR)
      .filter(f => f.endsWith('.sqlite') && !f.includes('.tmp'))
  } catch {
    return []
  }
}

export function sqliteDbSize(agentId: string): number {
  try {
    return fs.statSync(path.join(OPENCLAW_MEMORY_DIR, `${agentId}.sqlite`)).size
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// Workspace memory inspection
// ---------------------------------------------------------------------------

export function countWorkspaceMemoryFiles(workspaceDir: string): number {
  const memoryDir = path.join(workspaceDir, 'memory')
  if (!fs.existsSync(memoryDir)) return 0
  return countMdFilesRecursive(memoryDir, path.join(workspaceDir, 'memory/omg'))
}

function countMdFilesRecursive(dir: string, excludeDir: string): number {
  let count = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name)
      if (path.normalize(fullPath).startsWith(path.normalize(excludeDir))) continue
      if (entry.isFile() && entry.name.endsWith('.md')) {
        count++
      } else if (entry.isDirectory()) {
        count += countMdFilesRecursive(fullPath, excludeDir)
      }
    }
  } catch {
    // ignore
  }
  return count
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

export function cleanOmgDir(workspaceDir: string, storagePath = 'memory/omg'): {
  readonly removed: boolean
  readonly path: string
} {
  const omgRoot = path.join(workspaceDir, storagePath)
  if (fs.existsSync(omgRoot)) {
    fs.rmSync(omgRoot, { recursive: true, force: true })
    return { removed: true, path: omgRoot }
  }
  return { removed: false, path: omgRoot }
}

// ---------------------------------------------------------------------------
// Snapshot for before/after comparison
// ---------------------------------------------------------------------------

export interface WorkspaceSnapshot {
  readonly secretary: OmgWorkspaceState
  readonly techLead: OmgWorkspaceState
  readonly sqliteDbs: readonly string[]
  readonly memoryFileCount: number
  readonly timestamp: number
}

export function takeSnapshot(): WorkspaceSnapshot {
  return {
    secretary: inspectOmgWorkspace(SECRETARY_WORKSPACE),
    techLead: inspectOmgWorkspace(TECHLEAD_WORKSPACE),
    sqliteDbs: listSqliteDatabases(),
    memoryFileCount: countWorkspaceMemoryFiles(SECRETARY_WORKSPACE),
    timestamp: Date.now(),
  }
}
