/**
 * sources.ts — Bootstrap source readers.
 *
 * Three source types are supported, all with graceful degradation:
 *   1. Workspace markdown files (memory/**\/*.md, excluding OMG storage)
 *   2. OpenClaw session logs (~/.openclaw/logs/**)
 *   3. memory-core SQLite chunks (~/.openclaw/memory/{workspace}.sqlite)
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
 * Reads text chunks from the memory-core SQLite database at
 * `~/.openclaw/memory/{basename(workspaceDir)}.sqlite`, table `chunks`,
 * column `text`.
 *
 * Uses a dynamic import of `better-sqlite3` so the package is optional.
 * Returns `[]` with a single `console.warn` if the package is unavailable
 * or the database file does not exist.
 *
 * Graceful degradation: returns `[]` on any error.
 */
export async function readSqliteChunks(
  workspaceDir: string
): Promise<readonly SourceEntry[]> {
  const dbName = `${path.basename(workspaceDir)}.sqlite`
  const dbPath = path.join(os.homedir(), '.openclaw', 'memory', dbName)

  // Check if the database file exists before attempting to load the driver
  try {
    await fs.promises.access(dbPath)
  } catch {
    return []
  }

  type SqliteDb = {
    prepare(sql: string): { all(): unknown[] }
    close(): void
  }
  type SqliteConstructor = new (path: string, options?: { readonly: boolean }) => SqliteDb

  let Database: SqliteConstructor

  try {
    // better-sqlite3 is an optional dependency — TypeScript may not find its types.
    // We cast the module at runtime using our own local SqliteConstructor type.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const mod: { default: SqliteConstructor } = await (Function('id', 'return import(id)') as (id: string) => Promise<{ default: SqliteConstructor }>)('better-sqlite3')
    Database = mod.default
  } catch {
    console.warn(
      '[omg] bootstrap: better-sqlite3 is not available — SQLite memory chunks will not be ingested. ' +
      'Install it as an optional dependency to enable this source.'
    )
    return []
  }

  try {
    const db = new Database(dbPath, { readonly: true })
    let rows: unknown[]
    try {
      rows = db.prepare('SELECT text FROM chunks').all()
    } finally {
      db.close()
    }

    const entries: SourceEntry[] = []
    let idx = 0
    for (const row of rows) {
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as Record<string, unknown>)['text'] === 'string'
      ) {
        const text = (row as Record<string, unknown>)['text'] as string
        if (text.trim().length > 0) {
          entries.push({ label: `sqlite:chunks[${idx}]`, text })
        }
      }
      idx++
    }
    return entries
  } catch (err) {
    console.warn('[omg] bootstrap: failed to read SQLite memory chunks:', err)
    return []
  }
}
