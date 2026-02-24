/**
 * sources.ts — Bootstrap source readers.
 *
 * Three source types are supported, all with graceful degradation:
 *   1. Workspace markdown files (memory/**\/*.md, excluding OMG storage)
 *   2. OpenClaw session logs (~/.openclaw/logs/**)
 *   3. OpenClaw agent SQLite chunks (~/.openclaw/memory/{agentId}.sqlite, all agents)
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readFileOrNull } from '../utils/fs.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A raw text entry from a source, before chunking. */
export interface SourceEntry {
  /** Human-readable label for this entry (e.g. relative file path). */
  readonly label: string
  /** Raw text content. */
  readonly text: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively finds all files matching `ext` under `dir`.
 * Returns an empty array if `dir` does not exist (ENOENT).
 * Throws for unexpected filesystem errors.
 */
async function findFiles(dir: string, ext: string): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }

  const results: string[] = []
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const nested = await findFiles(fullPath, ext)
        results.push(...nested)
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        results.push(fullPath)
      }
    })
  )
  return results
}

// ---------------------------------------------------------------------------
// Source 1: Workspace markdown
// ---------------------------------------------------------------------------

/**
 * Reads all `.md` files under `{workspaceDir}/memory/`, excluding the OMG
 * storage path to avoid re-ingesting already-processed graph nodes.
 *
 * Returns a list of `SourceEntry` objects with labels as relative paths from
 * `workspaceDir`. Files that cannot be read are silently skipped.
 *
 * Graceful degradation: returns `[]` if the `memory/` directory is missing.
 */
export async function readWorkspaceMemory(
  workspaceDir: string,
  storagePath: string
): Promise<readonly SourceEntry[]> {
  const memoryDir = path.join(workspaceDir, 'memory')
  const omgStorageAbs = path.join(workspaceDir, storagePath)

  const files = await findFiles(memoryDir, '.md').catch(() => [] as string[])

  const entries: SourceEntry[] = []
  await Promise.all(
    files.map(async (filePath) => {
      // Skip files inside the OMG storage directory
      const normalizedFile = path.normalize(filePath)
      const normalizedStorage = path.normalize(omgStorageAbs)
      if (normalizedFile.startsWith(normalizedStorage + path.sep) || normalizedFile === normalizedStorage) {
        return
      }

      const text = await readFileOrNull(filePath)
      if (text === null || text.trim().length === 0) {
        return
      }

      const label = path.relative(workspaceDir, filePath)
      entries.push({ label, text })
    })
  )

  // Sort for deterministic ordering
  return entries.sort((a, b) => a.label.localeCompare(b.label))
}

// ---------------------------------------------------------------------------
// Source 2: OpenClaw logs
// ---------------------------------------------------------------------------

/**
 * Reads all files under `~/.openclaw/logs/`.
 *
 * Returns a list of `SourceEntry` objects with labels as relative paths from
 * the logs directory. Files that cannot be read are silently skipped.
 *
 * Graceful degradation: returns `[]` if the directory is missing (no warning).
 */
export async function readOpenclawLogs(): Promise<readonly SourceEntry[]> {
  const logsDir = path.join(os.homedir(), '.openclaw', 'logs')

  // No extension filter — logs may be .txt, .log, .jsonl, etc.
  const files = await findFiles(logsDir, '').catch(() => [] as string[])

  // findFiles with ext='' matches all files (endsWith('') is always true)
  // Filter to reasonable text-based extensions
  const textFiles = files.filter((f) => {
    const ext = path.extname(f).toLowerCase()
    return ext === '' || ext === '.txt' || ext === '.log' || ext === '.jsonl' || ext === '.md'
  })

  const entries: SourceEntry[] = []
  await Promise.all(
    textFiles.map(async (filePath) => {
      const text = await readFileOrNull(filePath)
      if (text === null || text.trim().length === 0) {
        return
      }
      const label = path.relative(logsDir, filePath)
      entries.push({ label, text })
    })
  )

  return entries.sort((a, b) => a.label.localeCompare(b.label))
}

// ---------------------------------------------------------------------------
// Source 3: memory-core SQLite
// ---------------------------------------------------------------------------

/**
 * Reads the openclaw config at `~/.openclaw/openclaw.json` and returns the
 * set of agent IDs whose workspace matches `workspaceDir` (resolved to the
 * same absolute path, case-insensitively on case-folded systems).
 *
 * Falls back to `null` on any read/parse error — callers treat `null` as
 * "unknown, include all agents".
 *
 * Agent workspace resolution order (mirrors plugin.ts):
 *   1. `agents.list[].workspace` per agent
 *   2. `agents.defaults.workspace` as fallback for agents without an explicit workspace
 */
function resolveWorkspaceAgentIds(workspaceDir: string): Set<string> | null {
  const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json')
  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf-8')
  } catch {
    return null
  }

  let config: unknown
  try {
    config = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof config !== 'object' || config === null) return null

  const agents = (config as Record<string, unknown>)['agents']
  if (typeof agents !== 'object' || agents === null) return null

  const defaultsObj = (agents as Record<string, unknown>)['defaults']
  const defaultWorkspace =
    typeof defaultsObj === 'object' && defaultsObj !== null
      ? ((defaultsObj as Record<string, unknown>)['workspace'] as string | undefined)
      : undefined

  const list = (agents as Record<string, unknown>)['list']
  if (!Array.isArray(list)) return null

  const normalizedTarget = path.resolve(workspaceDir)
  const matched = new Set<string>()

  for (const agent of list) {
    if (typeof agent !== 'object' || agent === null) continue
    const id = (agent as Record<string, unknown>)['id']
    if (typeof id !== 'string') continue
    const agentWorkspace =
      (agent as Record<string, unknown>)['workspace'] as string | undefined ?? defaultWorkspace
    if (typeof agentWorkspace === 'string' && path.resolve(agentWorkspace) === normalizedTarget) {
      matched.add(id)
    }
  }

  return matched.size > 0 ? matched : null
}

/**
 * Reads text chunks from OpenClaw agent SQLite memory databases at
 * `~/.openclaw/memory/{agentId}.sqlite`, table `chunks`, column `text`.
 *
 * Only databases belonging to agents whose configured workspace matches
 * `workspaceDir` are read (resolved from `~/.openclaw/openclaw.json`).
 * Falls back to reading all `.sqlite` files if the config cannot be parsed.
 *
 * Uses a dynamic import of `better-sqlite3` so the package is optional.
 * Returns `[]` with a single `console.warn` if the package is unavailable.
 *
 * Graceful degradation: returns `[]` on any error.
 */
export async function readSqliteChunks(
  workspaceDir: string
): Promise<readonly SourceEntry[]> {
  const memoryDir = path.join(os.homedir(), '.openclaw', 'memory')

  // Resolve which agent IDs belong to this workspace from the openclaw config.
  // Falls back to null (= include all agents) if the config cannot be read.
  const workspaceAgentIds = resolveWorkspaceAgentIds(workspaceDir)

  // Collect .sqlite files in the openclaw memory directory, filtered to agents
  // whose workspace matches. OpenClaw names files after agent IDs (e.g. pati.sqlite),
  // not after the workspace dirname.
  let dbPaths: string[]
  try {
    const entries = await fs.promises.readdir(memoryDir)
    dbPaths = entries
      .filter((name) => {
        if (!name.endsWith('.sqlite') || name.includes('.tmp')) return false
        if (workspaceAgentIds === null) return true // config unavailable — include all
        const agentId = name.slice(0, -'.sqlite'.length)
        return workspaceAgentIds.has(agentId)
      })
      .map((name) => path.join(memoryDir, name))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    console.warn('[omg] bootstrap: failed to list SQLite memory directory:', err)
    return []
  }

  if (dbPaths.length === 0) return []

  // Prefer node:sqlite (Node 22.5+ built-in, no ABI issues). Fall back to
  // better-sqlite3 (optional npm dependency) when node:sqlite is unavailable
  // (e.g. when running inside a Vite/Vitest context that doesn't expose it).
  type RowReader = (dbPath: string) => { text: string }[]
  let readRows: RowReader | null = null

  try {
    const nodeSqlite = await import('node:sqlite')
    const { DatabaseSync } = nodeSqlite
    readRows = (dbPath: string) => {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      try {
        return db.prepare('SELECT text FROM chunks').all() as { text: string }[]
      } finally {
        db.close()
      }
    }
  } catch {
    // node:sqlite unavailable — try better-sqlite3 as fallback
    try {
      const mod = await import('better-sqlite3')
      const Database = mod.default as typeof import('better-sqlite3')
      readRows = (dbPath: string) => {
        const db = new Database(dbPath, { readonly: true })
        try {
          return db.prepare('SELECT text FROM chunks').all() as { text: string }[]
        } finally {
          db.close()
        }
      }
    } catch {
      console.warn(
        '[omg] bootstrap: neither node:sqlite nor better-sqlite3 is available — ' +
        'SQLite memory chunks will not be ingested. ' +
        'Requires Node 22.5+ or better-sqlite3 installed with native bindings.'
      )
      return []
    }
  }

  const allEntries: SourceEntry[] = []

  for (const dbPath of dbPaths) {
    const agentId = path.basename(dbPath, '.sqlite')
    try {
      const rows = readRows(dbPath)
      let idx = 0
      for (const row of rows) {
        const text = row.text
        if (typeof text === 'string' && text.trim().length > 0) {
          allEntries.push({ label: `sqlite:${agentId}[${idx}]`, text })
        }
        idx++
      }
    } catch (err) {
      console.warn(`[omg] bootstrap: failed to read SQLite chunks from ${agentId}:`, err)
    }
  }

  return allEntries
}
