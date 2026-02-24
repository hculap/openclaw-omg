/**
 * Phase 0 — Pre-flight checks.
 *
 * Validates the environment is ready for live testing:
 *   - OPENCLAW_LIVE=1 is set
 *   - Gateway is running and healthy
 *   - Plugin config is present
 *   - Workspace memory files exist (MD source)
 *   - SQLite databases exist (SQLite source)
 *   - Node version supports node:sqlite
 *   - OMG dirs are clean (no stale data)
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import {
  requireLiveEnv,
  gatewayHealthCheck,
  gatewayCompletionsCheck,
  readOpenClawConfig,
  inspectOmgWorkspace,
  listSqliteDatabases,
  countWorkspaceMemoryFiles,
  takeSnapshot,
  SECRETARY_WORKSPACE,
  TECHLEAD_WORKSPACE,
  GATEWAY_PORT,
  BATCH_CAP,
  type OpenClawConfig,
  type WorkspaceSnapshot,
} from './helpers.js'

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

beforeAll(() => {
  requireLiveEnv()
})

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

describe('Phase 0 — Environment', () => {
  it('OPENCLAW_LIVE=1 is set', () => {
    expect(process.env['OPENCLAW_LIVE']).toBe('1')
  })

  it('Node version supports node:sqlite (>= 22.5)', () => {
    const [major, minor] = process.versions['node']!.split('.').map(Number)
    const supportsNodeSqlite = major! >= 25 || (major === 22 && minor! >= 5)
    expect(supportsNodeSqlite).toBe(true)
  })

  it('batch cap is configured', () => {
    expect(BATCH_CAP).toBeGreaterThan(0)
    expect(BATCH_CAP).toBeLessThanOrEqual(60)
    console.log(`[preflight] batch cap: ${BATCH_CAP}`)
  })
})

// ---------------------------------------------------------------------------
// Gateway health
// ---------------------------------------------------------------------------

describe('Phase 0 — Gateway', () => {
  it('gateway is reachable on configured port', async () => {
    const status = await gatewayHealthCheck()
    expect(status).not.toBeNull()
    console.log(`[preflight] gateway health: ${status} on port ${GATEWAY_PORT}`)
  })

  it('/v1/chat/completions endpoint responds', async () => {
    const config = readOpenClawConfig()
    const result = await gatewayCompletionsCheck(config.gatewayAuthToken)
    expect(result.reachable).toBe(true)
    console.log(`[preflight] completions endpoint: status=${result.status}`)
  })
})

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

describe('Phase 0 — Plugin config', () => {
  let config: OpenClawConfig

  beforeAll(() => {
    config = readOpenClawConfig()
  })

  it('openclaw.json exists and is parseable', () => {
    expect(config.raw).toBeDefined()
  })

  it('OMG plugin entry exists', () => {
    const plugins = config.raw['plugins'] as Record<string, unknown>
    const entries = plugins?.['entries'] as Record<string, unknown>
    expect(entries?.['omg']).toBeDefined()
  })

  it('OMG plugin is enabled (must flip enabled:true before running)', () => {
    expect(config.pluginEnabled).toBe(true)
  })

  it('plugin config has storagePath', () => {
    expect(config.pluginConfig['storagePath']).toBeDefined()
  })

  it('default model is configured', () => {
    expect(config.defaultModel).toBeDefined()
    console.log(`[preflight] default model: ${config.defaultModel}`)
  })
})

// ---------------------------------------------------------------------------
// Source availability
// ---------------------------------------------------------------------------

describe('Phase 0 — Source availability', () => {
  it('Secretary workspace has memory/*.md files (MD source)', () => {
    const count = countWorkspaceMemoryFiles(SECRETARY_WORKSPACE)
    expect(count).toBeGreaterThan(0)
    console.log(`[preflight] Secretary memory .md files: ${count}`)
  })

  it('SQLite databases exist (SQLite source)', () => {
    const dbs = listSqliteDatabases()
    expect(dbs.length).toBeGreaterThan(0)
    console.log(`[preflight] SQLite databases: ${dbs.join(', ')}`)
  })

  it('pati.sqlite or coding.sqlite exists for Secretary workspace', () => {
    const dbs = listSqliteDatabases()
    const hasRelevant = dbs.some(
      db => db === 'pati.sqlite' || db === 'coding.sqlite'
    )
    expect(hasRelevant).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Clean state
// ---------------------------------------------------------------------------

describe('Phase 0 — Clean state', () => {
  it('Secretary memory/omg does NOT exist (must clean before running)', () => {
    const state = inspectOmgWorkspace(SECRETARY_WORKSPACE)
    expect(state.exists).toBe(false)
    if (state.exists) {
      console.error(
        `[preflight] FAIL: Secretary memory/omg exists. Run cleanup first:\n` +
        `  rm -rf "${SECRETARY_WORKSPACE}/memory/omg"`
      )
    }
  })

  it('TechLead memory/omg does NOT exist (must clean before running)', () => {
    const state = inspectOmgWorkspace(TECHLEAD_WORKSPACE)
    expect(state.exists).toBe(false)
    if (state.exists) {
      console.error(
        `[preflight] FAIL: TechLead memory/omg exists. Run cleanup first:\n` +
        `  rm -rf "${TECHLEAD_WORKSPACE}/memory/omg"`
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Baseline snapshot
// ---------------------------------------------------------------------------

describe('Phase 0 — Baseline snapshot', () => {
  it('captures baseline snapshot', () => {
    const snapshot = takeSnapshot()

    console.log(`[preflight] === BASELINE SNAPSHOT ===`)
    console.log(`[preflight] Secretary OMG exists: ${snapshot.secretary.exists}`)
    console.log(`[preflight] TechLead OMG exists: ${snapshot.techLead.exists}`)
    console.log(`[preflight] SQLite DBs: ${snapshot.sqliteDbs.length}`)
    console.log(`[preflight] Memory .md files: ${snapshot.memoryFileCount}`)
    console.log(`[preflight] Timestamp: ${new Date(snapshot.timestamp).toISOString()}`)

    // Write snapshot to temp file for later phases to compare
    const snapshotPath = '/tmp/omg-live-test-baseline.json'
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2))
    console.log(`[preflight] Baseline written to ${snapshotPath}`)

    expect(snapshot.timestamp).toBeGreaterThan(0)
  })
})
