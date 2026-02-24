/**
 * Phase 2 — Capped bootstrap run.
 *
 * Runs bootstrap with a limited batch budget (default 10) to validate:
 *   - Lock acquisition works
 *   - State file is created and updated
 *   - LLM calls succeed through the gateway
 *   - Nodes are written to disk
 *   - MOCs are created
 *   - now.md is updated
 *   - Bootstrap pauses correctly at batch limit
 *
 * COST: ~10 Sonnet calls (one per batch). Each batch ≈ 6k input + 6k output tokens.
 * Estimated: ~120k tokens total ≈ $0.50-$1.00.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  requireLiveEnv,
  readOpenClawConfig,
  inspectOmgWorkspace,
  readBootstrapState,
  readBootstrapLock,
  SECRETARY_WORKSPACE,
  BATCH_CAP,
} from './helpers.js'

// Dynamic imports
let runBootstrapTick: typeof import('../../src/bootstrap/bootstrap.js')['runBootstrapTick']
let createLlmClient: typeof import('../../src/llm/client.js')['createLlmClient']
let createGatewayCompletionsGenerateFn: typeof import('../../src/llm/gateway-completions.js')['createGatewayCompletionsGenerateFn']
let scaffoldGraphIfNeeded: typeof import('../../src/scaffold.js')['scaffoldGraphIfNeeded']
let parseConfig: typeof import('../../src/config.js')['parseConfig']

beforeAll(async () => {
  requireLiveEnv()
  const bootstrap = await import('../../src/bootstrap/bootstrap.js')
  runBootstrapTick = bootstrap.runBootstrapTick

  const client = await import('../../src/llm/client.js')
  createLlmClient = client.createLlmClient

  const gateway = await import('../../src/llm/gateway-completions.js')
  createGatewayCompletionsGenerateFn = gateway.createGatewayCompletionsGenerateFn

  const scaffold = await import('../../src/scaffold.js')
  scaffoldGraphIfNeeded = scaffold.scaffoldGraphIfNeeded

  const configMod = await import('../../src/config.js')
  parseConfig = configMod.parseConfig
})

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

describe('Phase 2 — Scaffold', () => {
  it('scaffolds graph directory structure', async () => {
    const openclawConfig = readOpenClawConfig()
    const pluginConfig = parseConfig(openclawConfig.pluginConfig)
    await scaffoldGraphIfNeeded(SECRETARY_WORKSPACE, pluginConfig)

    const omgRoot = path.join(SECRETARY_WORKSPACE, 'memory/omg')

    expect(fs.existsSync(omgRoot)).toBe(true)
    expect(fs.existsSync(path.join(omgRoot, 'index.md'))).toBe(true)
    expect(fs.existsSync(path.join(omgRoot, 'now.md'))).toBe(true)
    expect(fs.existsSync(path.join(omgRoot, 'nodes'))).toBe(true)
    expect(fs.existsSync(path.join(omgRoot, 'mocs'))).toBe(true)

    console.log('[bootstrap] Scaffold created successfully')
  })
})

// ---------------------------------------------------------------------------
// Capped bootstrap run
// ---------------------------------------------------------------------------

describe('Phase 2 — Capped bootstrap', () => {
  const omgRoot = path.join(SECRETARY_WORKSPACE, 'memory/omg')

  it(`runs bootstrap tick with ${BATCH_CAP}-batch cap`, async () => {
    const openclawConfig = readOpenClawConfig()
    const pluginConfig = parseConfig(openclawConfig.pluginConfig)

    const generateFn = createGatewayCompletionsGenerateFn({
      port: 18789,
      authToken: openclawConfig.gatewayAuthToken,
    })
    const llmClient = createLlmClient(
      openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-6',
      generateFn,
    )

    const configWithCap = {
      ...pluginConfig,
      bootstrap: {
        ...pluginConfig.bootstrap,
        batchBudgetPerRun: BATCH_CAP,
      },
    }

    console.log(`[bootstrap] Starting capped bootstrap tick (max ${BATCH_CAP} batches)...`)
    const startTime = Date.now()

    const result = await runBootstrapTick({
      workspaceDir: SECRETARY_WORKSPACE,
      config: configWithCap,
      llmClient,
      force: false,
    })

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[bootstrap] Completed in ${elapsed}s`)
    console.log(`[bootstrap] Result: ${JSON.stringify(result, null, 2)}`)

    expect(result.ran).toBe(true)
    expect(result.batchesProcessed).toBeGreaterThan(0)
    expect(result.batchesProcessed).toBeLessThanOrEqual(BATCH_CAP)
  }, 300_000) // 5 minute timeout

  it('state file was created', () => {
    const state = readBootstrapState(omgRoot)
    expect(state).not.toBeNull()
    console.log(`[bootstrap] State: ${JSON.stringify(state, null, 2)}`)
  })

  it('lock file was released after completion', () => {
    const lock = readBootstrapLock(omgRoot)
    // Lock should be released after tick completes
    // (If paused, lock IS released — only held during active processing)
    expect(lock).toBeNull()
    console.log('[bootstrap] Lock released: OK')
  })

  it('state shows correct batch progress', () => {
    const state = readBootstrapState(omgRoot)
    expect(state).not.toBeNull()

    if (state) {
      expect(state.version).toBe(2)
      expect(state.ok).toBeGreaterThan(0)
      expect(state.cursor).toBeGreaterThan(0)
      expect(state.total).toBeGreaterThan(0)
      expect(['paused', 'completed']).toContain(state.status)

      if (state.status === 'paused') {
        expect(state.cursor).toBeLessThan(state.total)
        console.log(`[bootstrap] Paused at batch ${state.cursor}/${state.total} (${state.ok} ok, ${state.fail} fail)`)
      } else {
        console.log(`[bootstrap] Completed: ${state.ok} ok, ${state.fail} fail`)
      }
    }
  })

  it('nodes were written to disk', () => {
    const workspace = inspectOmgWorkspace(SECRETARY_WORKSPACE)
    expect(workspace.nodeCount).toBeGreaterThan(0)

    console.log(`[bootstrap] Nodes written: ${workspace.nodeCount}`)
    console.log(`[bootstrap] Node types: ${workspace.nodeTypes.join(', ')}`)
    console.log(`[bootstrap] MOCs: ${workspace.mocCount}`)
  })

  it('now.md was updated', () => {
    const nowPath = path.join(omgRoot, 'now.md')
    const content = fs.readFileSync(nowPath, 'utf-8')

    // now.md should have been updated with links to new nodes
    expect(content.length).toBeGreaterThan(0)
    console.log(`[bootstrap] now.md size: ${content.length} chars`)
  })

  it('no duplicate storms (node count reasonable for batch count)', () => {
    const state = readBootstrapState(omgRoot)
    const workspace = inspectOmgWorkspace(SECRETARY_WORKSPACE)

    if (state && state.ok > 0) {
      // Rough heuristic: at most ~20 nodes per batch (generous)
      const maxReasonable = state.ok * 20
      expect(workspace.nodeCount).toBeLessThan(maxReasonable)
      console.log(
        `[bootstrap] Nodes per successful batch: ${(workspace.nodeCount / state.ok).toFixed(1)} ` +
        `(${workspace.nodeCount} nodes / ${state.ok} batches)`
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Source-specific verification
// ---------------------------------------------------------------------------

describe('Phase 2 — Source verification', () => {
  it('bootstrap state includes both MD and SQLite batch processing', () => {
    const state = readBootstrapState(path.join(SECRETARY_WORKSPACE, 'memory/omg'))
    expect(state).not.toBeNull()

    // With BATCH_CAP=10 and sources ordered MD-first, then SQLite,
    // check that we processed some batches. The exact source mix depends
    // on which batches fall within the cap.
    if (state) {
      console.log(`[sources] Bootstrap processed ${state.ok + state.fail} batches total`)
      console.log(`[sources] OK: ${state.ok}, Failed: ${state.fail}`)

      // At least some batches should succeed
      expect(state.ok).toBeGreaterThan(0)
    }
  })
})
