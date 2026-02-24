/**
 * Persistent workspace registry for multi-workspace cron support.
 *
 * Records all workspaces ever seen by the plugin so that at gateway_start,
 * cron jobs can be re-registered for every known workspace — not just the
 * one resolved from the global config.
 *
 * Registry file location: ~/.openclaw/omg-workspaces.json
 */

import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import type { OmgConfig } from '../config.js'
import { resolveOmgRoot } from '../utils/paths.js'
import { atomicWrite, readFileOrNull } from '../utils/fs.js'

// ---------------------------------------------------------------------------
// Types & schema
// ---------------------------------------------------------------------------

const workspaceEntrySchema = z.object({
  path: z.string(),
  addedAt: z.string(),
})

const workspaceRegistrySchema = z.object({
  version: z.literal(1),
  workspaces: z.record(workspaceEntrySchema),
})

export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>
export type WorkspaceRegistry = z.infer<typeof workspaceRegistrySchema>

// ---------------------------------------------------------------------------
// Registry path
// ---------------------------------------------------------------------------

export function resolveRegistryPath(): string {
  return path.join(os.homedir(), '.openclaw', 'omg-workspaces.json')
}

// ---------------------------------------------------------------------------
// Registry I/O
// ---------------------------------------------------------------------------

/**
 * Reads the workspace registry from disk.
 * Returns an empty registry on ENOENT or parse error (never throws).
 * Logs a warning on bad/corrupted data.
 */
export async function readWorkspaceRegistry(): Promise<WorkspaceRegistry> {
  const registryPath = resolveRegistryPath()
  const raw = await readFileOrNull(registryPath)
  if (raw === null) {
    return { version: 1, workspaces: {} }
  }
  try {
    const parsed = JSON.parse(raw)
    return workspaceRegistrySchema.parse(parsed)
  } catch (err) {
    console.warn('[omg] workspace-registry: failed to parse registry — starting fresh:', err)
    return { version: 1, workspaces: {} }
  }
}

// Serializes concurrent writes to prevent interleaved disk writes.
let _pendingWrite: Promise<void> = Promise.resolve()

/**
 * Writes the workspace registry to disk atomically.
 * Concurrent calls are serialized (queued) to prevent interleaved writes.
 * The internal chain is always reset to a resolved state on failure so a
 * single I/O error does not permanently block future writes.
 */
export async function writeWorkspaceRegistry(registry: WorkspaceRegistry): Promise<void> {
  const next = _pendingWrite.then(async () => {
    const registryPath = resolveRegistryPath()
    const dir = path.dirname(registryPath)
    await fsp.mkdir(dir, { recursive: true })
    await atomicWrite(registryPath, JSON.stringify(registry, null, 2))
  })
  // Reset to resolved on failure so subsequent writes are not permanently blocked.
  _pendingWrite = next.catch(() => {})
  return next
}

/**
 * Atomically adds a workspace to the persistent registry.
 * The entire read-modify-write runs inside the serialization queue so
 * concurrent callers each see the previous caller's write (no lost-update).
 * No-ops if the workspace is already present.
 */
export async function addWorkspaceToRegistry(workspacePath: string): Promise<void> {
  const next = _pendingWrite.then(async () => {
    const registry = await readWorkspaceRegistry()
    const updated = addWorkspace(registry, workspacePath)
    if (updated === registry) return // already present — skip write
    const registryPath = resolveRegistryPath()
    const dir = path.dirname(registryPath)
    await fsp.mkdir(dir, { recursive: true })
    await atomicWrite(registryPath, JSON.stringify(updated, null, 2))
  })
  _pendingWrite = next.catch(() => {})
  return next
}

// ---------------------------------------------------------------------------
// Registry mutations (pure)
// ---------------------------------------------------------------------------

/**
 * Returns a new registry with the given workspace path added (if not already present).
 * Pure and idempotent — returns the same registry object if the path is already known.
 */
export function addWorkspace(registry: WorkspaceRegistry, workspacePath: string): WorkspaceRegistry {
  if (registry.workspaces[workspacePath] !== undefined) {
    return registry
  }
  return {
    ...registry,
    workspaces: {
      ...registry.workspaces,
      [workspacePath]: { path: workspacePath, addedAt: new Date().toISOString() },
    },
  }
}

/**
 * Returns a new registry with stale entries removed.
 * An entry is stale if its resolved omgRoot directory does not exist on disk.
 *
 * Uses synchronous `fs.existsSync` — only call this at `gateway_start` where
 * blocking I/O is acceptable.
 */
export function pruneStaleWorkspaces(registry: WorkspaceRegistry, config: OmgConfig): WorkspaceRegistry {
  const validEntries: Record<string, WorkspaceEntry> = {}
  for (const [wsPath, entry] of Object.entries(registry.workspaces)) {
    const omgRoot = resolveOmgRoot(wsPath, config)
    if (fs.existsSync(omgRoot)) {
      validEntries[wsPath] = entry
    }
  }
  return { ...registry, workspaces: validEntries }
}

/**
 * Returns all workspace paths currently in the registry.
 */
export function listWorkspacePaths(registry: WorkspaceRegistry): string[] {
  return Object.keys(registry.workspaces)
}
