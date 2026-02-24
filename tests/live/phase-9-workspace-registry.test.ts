/**
 * Phase 9 — Workspace registry live tests.
 *
 * Tests `addWorkspaceToRegistry`, `readWorkspaceRegistry`, `pruneStaleWorkspaces`,
 * and `listWorkspacePaths` against real filesystem I/O (no memfs).
 *
 * Key scenarios tested:
 *   - Read/write round-trip
 *   - Idempotency: adding the same workspace twice produces one entry
 *   - Concurrent writes: N workspaces added in parallel — all must survive
 *     (validates the lost-update fix from the multi-workspace-cron PR)
 *   - Pruning: stale entries (omgRoot absent on disk) are removed; valid entries remain
 *
 * The real ~/.openclaw/omg-workspaces.json is backed up before tests and
 * restored after, so this test is safe to run on a developer machine.
 *
 * COST: $0 — no LLM calls.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  requireLiveEnv,
  readOpenClawConfig,
  writeArtifact,
  SECRETARY_WORKSPACE,
  TECHLEAD_WORKSPACE,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Lazily-imported module refs
// ---------------------------------------------------------------------------

let readWorkspaceRegistry: typeof import('../../src/cron/workspace-registry.js')['readWorkspaceRegistry']
let addWorkspaceToRegistry: typeof import('../../src/cron/workspace-registry.js')['addWorkspaceToRegistry']
let pruneStaleWorkspaces: typeof import('../../src/cron/workspace-registry.js')['pruneStaleWorkspaces']
let listWorkspacePaths: typeof import('../../src/cron/workspace-registry.js')['listWorkspacePaths']

// ---------------------------------------------------------------------------
// Backup / restore helpers
// ---------------------------------------------------------------------------

const REGISTRY_PATH = path.join(os.homedir(), '.openclaw', 'omg-workspaces.json')
let originalRegistryContent: string | null = null

function deleteRegistry(): void {
  try { fs.unlinkSync(REGISTRY_PATH) } catch { /* ok if absent */ }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

beforeAll(async () => {
  requireLiveEnv()

  const mod = await import('../../src/cron/workspace-registry.js')
  readWorkspaceRegistry = mod.readWorkspaceRegistry
  addWorkspaceToRegistry = mod.addWorkspaceToRegistry
  pruneStaleWorkspaces = mod.pruneStaleWorkspaces
  listWorkspacePaths = mod.listWorkspacePaths

  // Back up and clear existing registry so tests start from a clean slate.
  try {
    originalRegistryContent = fs.readFileSync(REGISTRY_PATH, 'utf-8')
    const count = Object.keys(JSON.parse(originalRegistryContent)['workspaces'] ?? {}).length
    console.log(`[registry] Backed up existing registry (${count} entries)`)
  } catch {
    originalRegistryContent = null
    console.log('[registry] No existing registry — starting clean')
  }

  deleteRegistry()
})

afterAll(() => {
  if (originalRegistryContent !== null) {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true })
    fs.writeFileSync(REGISTRY_PATH, originalRegistryContent)
    console.log('[registry] Original registry restored')
  } else {
    deleteRegistry()
    console.log('[registry] No original registry — test file cleaned up')
  }
})

// ---------------------------------------------------------------------------
// Phase 9A — Read/write round-trip
// ---------------------------------------------------------------------------

describe('Phase 9A — Read/write round-trip', () => {
  it('reads an empty registry when file does not exist', async () => {
    const registry = await readWorkspaceRegistry()
    expect(registry.version).toBe(1)
    expect(listWorkspacePaths(registry)).toHaveLength(0)
    console.log('[registry] empty registry confirmed (no file)')
  })

  it('addWorkspaceToRegistry creates the registry file on disk', async () => {
    await addWorkspaceToRegistry(SECRETARY_WORKSPACE)
    expect(fs.existsSync(REGISTRY_PATH)).toBe(true)
    console.log(`[registry] registry file created: ${REGISTRY_PATH}`)
  })

  it('persists the workspace path and is readable', async () => {
    const registry = await readWorkspaceRegistry()
    expect(listWorkspacePaths(registry)).toContain(SECRETARY_WORKSPACE)
    console.log(`[registry] Secretary workspace confirmed: ${SECRETARY_WORKSPACE}`)
  })

  it('addWorkspaceToRegistry is idempotent — duplicate add produces one entry', async () => {
    await addWorkspaceToRegistry(SECRETARY_WORKSPACE)
    const registry = await readWorkspaceRegistry()
    const count = listWorkspacePaths(registry).filter(p => p === SECRETARY_WORKSPACE).length
    expect(count).toBe(1)
    console.log('[registry] idempotency confirmed: no duplicate entry')
  })

  it('adding a second workspace preserves the first', async () => {
    await addWorkspaceToRegistry(TECHLEAD_WORKSPACE)
    const registry = await readWorkspaceRegistry()
    const paths = listWorkspacePaths(registry)
    expect(paths).toContain(SECRETARY_WORKSPACE)
    expect(paths).toContain(TECHLEAD_WORKSPACE)
    expect(paths).toHaveLength(2)
    console.log(`[registry] both workspaces present: ${paths.length} entries`)
  })

  it('each entry has a valid ISO 8601 addedAt timestamp', async () => {
    const registry = await readWorkspaceRegistry()
    for (const [wsPath, entry] of Object.entries(registry.workspaces)) {
      const ms = new Date(entry.addedAt).getTime()
      expect(ms).toBeGreaterThan(0)
      console.log(`[registry] ${path.basename(wsPath)}: addedAt=${entry.addedAt}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 9B — Concurrent writes (lost-update fix)
// ---------------------------------------------------------------------------

describe('Phase 9B — Concurrent writes', () => {
  const CONCURRENT_WORKSPACES = [
    '/tmp/omg-live-ws-concurrent-A',
    '/tmp/omg-live-ws-concurrent-B',
    '/tmp/omg-live-ws-concurrent-C',
    '/tmp/omg-live-ws-concurrent-D',
    '/tmp/omg-live-ws-concurrent-E',
  ]

  it('all N workspaces added in parallel are present — no lost updates', async () => {
    deleteRegistry()

    // Fire all calls concurrently in the same event-loop tick.
    // Without the fix (read outside queue), 4 of 5 writes would be silently lost.
    await Promise.all(CONCURRENT_WORKSPACES.map(ws => addWorkspaceToRegistry(ws)))

    const registry = await readWorkspaceRegistry()
    const paths = listWorkspacePaths(registry)

    for (const ws of CONCURRENT_WORKSPACES) {
      expect(paths, `expected ${ws} to be in registry`).toContain(ws)
    }
    expect(paths).toHaveLength(CONCURRENT_WORKSPACES.length)

    console.log(`[registry] concurrent write: ${paths.length}/${CONCURRENT_WORKSPACES.length} entries present ✓`)
  })

  it('concurrent duplicate adds remain idempotent', async () => {
    // Add the same workspace many times concurrently — should still produce 1 entry.
    await Promise.all(Array.from({ length: 5 }, () => addWorkspaceToRegistry(CONCURRENT_WORKSPACES[0]!)))

    const registry = await readWorkspaceRegistry()
    const count = listWorkspacePaths(registry).filter(p => p === CONCURRENT_WORKSPACES[0]).length
    expect(count).toBe(1)
    console.log('[registry] concurrent duplicate adds: still 1 entry ✓')
  })
})

// ---------------------------------------------------------------------------
// Phase 9C — Pruning
// ---------------------------------------------------------------------------

describe('Phase 9C — Pruning', () => {
  const GHOST_WORKSPACES = [
    '/tmp/omg-live-ghost-ws-1',
    '/tmp/omg-live-ghost-ws-2',
  ]

  it('pruneStaleWorkspaces removes entries whose omgRoot does not exist', async () => {
    deleteRegistry()

    const { pluginConfig } = readOpenClawConfig()
    const { parseConfig } = await import('../../src/config.js')
    const config = parseConfig(pluginConfig)

    // Ensure Secretary's omgRoot exists so it survives pruning.
    const secretaryOmgRoot = path.join(SECRETARY_WORKSPACE, config.storagePath)
    const createdOmgRoot = !fs.existsSync(secretaryOmgRoot)
    if (createdOmgRoot) {
      fs.mkdirSync(secretaryOmgRoot, { recursive: true })
    }

    try {
      // 1 real workspace + 2 ghost workspaces (no dirs on disk)
      await Promise.all([
        addWorkspaceToRegistry(SECRETARY_WORKSPACE),
        ...GHOST_WORKSPACES.map(ws => addWorkspaceToRegistry(ws)),
      ])

      const before = await readWorkspaceRegistry()
      expect(listWorkspacePaths(before)).toHaveLength(3)
      console.log(`[registry] before pruning: ${listWorkspacePaths(before).length} entries`)

      const pruned = pruneStaleWorkspaces(before, config)
      const afterPaths = listWorkspacePaths(pruned)

      expect(afterPaths).toContain(SECRETARY_WORKSPACE)
      for (const ghost of GHOST_WORKSPACES) {
        expect(afterPaths).not.toContain(ghost)
      }
      expect(afterPaths).toHaveLength(1)

      console.log(`[registry] after pruning: ${afterPaths.length} entry (ghosts removed ✓)`)
    } finally {
      if (createdOmgRoot) {
        fs.rmSync(secretaryOmgRoot, { recursive: true, force: true })
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 9D — Artifact
// ---------------------------------------------------------------------------

describe('Phase 9D — Artifact', () => {
  it('writes phase-9 summary artifact', async () => {
    const registry = await readWorkspaceRegistry()
    const artifactPath = writeArtifact('phase-9-workspace-registry.json', {
      phase: 9,
      description: 'Workspace registry live tests — round-trip, concurrent writes, pruning',
      registryPath: REGISTRY_PATH,
      workspacesInRegistry: listWorkspacePaths(registry),
      zeroLlmCost: true,
    })
    console.log(`[registry] artifact written to ${artifactPath}`)
    expect(true).toBe(true)
  })
})
