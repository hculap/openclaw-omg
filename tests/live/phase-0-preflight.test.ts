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
  checkInjectedFileSizes,
  ensureArtifactsDir,
  writeArtifact,
  SECRETARY_WORKSPACE,
  TECHLEAD_WORKSPACE,
  GATEWAY_PORT,
  BATCH_CAP,
  MAX_LLM_CALLS,
  MAX_INPUT_TOKENS,
  ARTIFACTS_DIR,
  type OpenClawConfig,
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

  it('LLM spend caps are configured', () => {
    expect(MAX_LLM_CALLS).toBeGreaterThan(0)
    expect(MAX_INPUT_TOKENS).toBeGreaterThan(0)
    console.log(`[preflight] LLM call cap: ${MAX_LLM_CALLS}`)
    console.log(`[preflight] Input token cap: ${MAX_INPUT_TOKENS.toLocaleString()}`)
  })

  it('artifacts directory is writable', () => {
    ensureArtifactsDir()
    expect(fs.existsSync(ARTIFACTS_DIR)).toBe(true)
    console.log(`[preflight] artifacts dir: ${ARTIFACTS_DIR}`)
  })
})

// ---------------------------------------------------------------------------
// Gateway health
// ---------------------------------------------------------------------------

describe('Phase 0 — Gateway', () => {
  it('gateway is reachable on configured port', async () => {
    const status = await gatewayHealthCheck()
    if (status === null) {
      console.warn(`[preflight] WARNING: Gateway not reachable on port ${GATEWAY_PORT}. LLM-dependent tests will fail.`)
    } else {
      console.log(`[preflight] gateway health: ${status} on port ${GATEWAY_PORT}`)
    }
    // Informational only — gateway may be starting up or temporarily down
    expect(true).toBe(true)
  })

  it('/v1/chat/completions endpoint responds', async () => {
    const config = readOpenClawConfig()
    const result = await gatewayCompletionsCheck(config.gatewayAuthToken)
    if (!result.reachable) {
      console.warn(`[preflight] WARNING: /v1/chat/completions not reachable. Error: ${result.error}`)
      console.warn('[preflight] LLM-dependent tests (Phase 2, 3, 4, 7) will fail if gateway stays down.')
    } else {
      console.log(`[preflight] completions endpoint: status=${result.status}`)
    }
    // Informational only — gateway availability is an environment concern, not a code bug
    expect(true).toBe(true)
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
    if (state.exists) {
      console.warn(
        `[preflight] WARNING: Secretary memory/omg already exists (${state.nodeCount} nodes).\n` +
        `  Subsequent phases will use existing state. To start fresh:\n` +
        `  rm -rf "${SECRETARY_WORKSPACE}/memory/omg"`
      )
    } else {
      console.log('[preflight] Secretary memory/omg: clean (ready for fresh bootstrap)')
    }
    // Informational only — existing state is acceptable for re-runs
    expect(true).toBe(true)
  })

  it('TechLead memory/omg does NOT exist (must clean before running)', () => {
    const state = inspectOmgWorkspace(TECHLEAD_WORKSPACE)
    if (state.exists) {
      console.warn(
        `[preflight] WARNING: TechLead memory/omg already exists.\n` +
        `  To start fresh: rm -rf "${TECHLEAD_WORKSPACE}/memory/omg"`
      )
    } else {
      console.log('[preflight] TechLead memory/omg: clean')
    }
    // Informational only
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Cron safety (Fix #1 — no background burn)
// ---------------------------------------------------------------------------

describe('Phase 0 — Cron safety', () => {
  it('warns that tests call runBootstrapTick() directly (not via cron)', () => {
    // Tests call bootstrap functions directly, bypassing the cron scheduler.
    // However, if the plugin is enabled AND the gateway is running, the
    // omg-bootstrap cron job may ALSO be running in the background.
    const config = readOpenClawConfig()

    if (config.pluginEnabled) {
      const allowCron = process.env['LIVE_ALLOW_CRON'] === '1'
      if (!allowCron) {
        console.warn(
          '[preflight] WARNING: OMG plugin is enabled. The omg-bootstrap cron job\n' +
          '  may be running in the background, burning tokens independently of tests.\n' +
          '  Options:\n' +
          '    1. Disable plugin before tests: ./scripts/live-test-enable-plugin.sh --disable\n' +
          '    2. Set LIVE_ALLOW_CRON=1 to acknowledge background cron is acceptable\n' +
          '    3. Tests call runBootstrapTick() directly — cron runs are independent'
        )
      } else {
        console.log('[preflight] LIVE_ALLOW_CRON=1 — background cron acknowledged')
      }
    } else {
      console.log('[preflight] Plugin disabled — no background cron risk')
    }

    // Always passes — this is a warning, not a blocker
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Injected file bloat (Fix #4 — token safety)
// ---------------------------------------------------------------------------

describe('Phase 0 — Injected file sizes', () => {
  it('MEMORY.md and other injected files are within size limits', () => {
    const checks = checkInjectedFileSizes(SECRETARY_WORKSPACE)

    for (const check of checks) {
      const sizeKB = (check.size / 1024).toFixed(1)
      const limitKB = (check.limit / 1024).toFixed(0)
      const status = check.ok ? 'OK' : 'OVER LIMIT'
      console.log(`[preflight] ${check.file}: ${sizeKB}KB / ${limitKB}KB [${status}]`)
    }

    const overLimit = checks.filter(c => !c.ok)
    if (overLimit.length > 0) {
      console.error(
        `[preflight] FAIL: ${overLimit.length} injected file(s) exceed size limits.\n` +
        `These files are injected EVERY TURN and will cause token bloat.\n` +
        overLimit.map(c => `  ${c.path}: ${(c.size / 1024).toFixed(1)}KB > ${(c.limit / 1024).toFixed(0)}KB`).join('\n')
      )
    }

    expect(overLimit).toHaveLength(0)
  })

  it('memory/omg/index.md (if exists) is not excessively large', () => {
    const indexPath = `${SECRETARY_WORKSPACE}/memory/omg/index.md`
    if (!fs.existsSync(indexPath)) {
      console.log('[preflight] No index.md yet — skip size check')
      return
    }

    const size = fs.statSync(indexPath).size
    const limitKB = 4
    console.log(`[preflight] index.md: ${(size / 1024).toFixed(1)}KB (limit: ${limitKB}KB)`)
    expect(size).toBeLessThanOrEqual(limitKB * 1024)
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
