/**
 * Live test helpers — shared utilities for real gateway testing.
 *
 * All live tests are gated behind OPENCLAW_LIVE=1 env var.
 * These helpers read real filesystem state and talk to the real gateway.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GATEWAY_PORT = Number(process.env['OPENCLAW_GATEWAY_PORT'] ?? 18789)
export const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`

/** Max batches for capped bootstrap runs. Override via LIVE_TEST_BATCH_CAP. */
export const BATCH_CAP = Number(process.env['LIVE_TEST_BATCH_CAP'] ?? 10)

/** Secretary workspace (default agent workspace). */
export const SECRETARY_WORKSPACE = '/Users/szymonpaluch/Projects/Personal/Secretary'

/** TechLead workspace. */
export const TECHLEAD_WORKSPACE = '/Users/szymonpaluch/Projects/Personal/TechLead'

/** OpenClaw config path. */
export const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json')

/** OpenClaw memory dir (SQLite databases). */
export const OPENCLAW_MEMORY_DIR = path.join(os.homedir(), '.openclaw', 'memory')

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
