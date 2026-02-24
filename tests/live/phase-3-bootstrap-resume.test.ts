/**
 * Phase 3 — Bootstrap resume/restart validation.
 *
 * Verifies the resume mechanism by:
 *   1. Reading state from Phase 2 (should be paused if BATCH_CAP < total)
 *   2. Running another tick — should resume from cursor
 *   3. Verifying no batch reprocessing (done set grows, cursor advances)
 *   4. Verifying node count growth is incremental (no duplicates)
 *
 * PREREQUISITE: Phase 2 must have run and left a paused state.
 * If Phase 2 completed all batches, this phase verifies skip behavior.
 *
 * COST: Another ~10 Sonnet calls ≈ $0.50-$1.00.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  requireLiveEnv,
  readOpenClawConfig,
  readBootstrapState,
  readBootstrapLock,
  inspectOmgWorkspace,
  wrapGenerateFnWithTracker,
  llmTracker,
  writeArtifact,
  SECRETARY_WORKSPACE,
  BATCH_CAP,
} from './helpers.js'

let runBootstrapTick: typeof import('../../src/bootstrap/bootstrap.js')['runBootstrapTick']
let createLlmClient: typeof import('../../src/llm/client.js')['createLlmClient']
let createGatewayCompletionsGenerateFn: typeof import('../../src/llm/gateway-completions.js')['createGatewayCompletionsGenerateFn']
let parseConfig: typeof import('../../src/config.js')['parseConfig']

const omgRoot = path.join(SECRETARY_WORKSPACE, 'memory/omg')

beforeAll(async () => {
  requireLiveEnv()
  const bootstrap = await import('../../src/bootstrap/bootstrap.js')
  runBootstrapTick = bootstrap.runBootstrapTick

  const client = await import('../../src/llm/client.js')
  createLlmClient = client.createLlmClient

  const gateway = await import('../../src/llm/gateway-completions.js')
  createGatewayCompletionsGenerateFn = gateway.createGatewayCompletionsGenerateFn

  const configMod = await import('../../src/config.js')
  parseConfig = configMod.parseConfig
})

// ---------------------------------------------------------------------------
// State from Phase 2
// ---------------------------------------------------------------------------

describe('Phase 3 — Pre-resume state', () => {
  it('bootstrap state exists from Phase 2', () => {
    const state = readBootstrapState(omgRoot)
    expect(state).not.toBeNull()

    if (state) {
      console.log(`[resume] Phase 2 state: status=${state.status}, cursor=${state.cursor}/${state.total}, ok=${state.ok}, fail=${state.fail}`)
    }
  })

  it('state is paused or completed', () => {
    const state = readBootstrapState(omgRoot)
    expect(state).not.toBeNull()
    expect(['paused', 'completed']).toContain(state!.status)
  })
})

// ---------------------------------------------------------------------------
// Resume tick
// ---------------------------------------------------------------------------

describe('Phase 3 — Resume bootstrap tick', () => {
  let stateBefore: ReturnType<typeof readBootstrapState>
  let nodeCountBefore: number

  beforeAll(() => {
    stateBefore = readBootstrapState(omgRoot)
    nodeCountBefore = inspectOmgWorkspace(SECRETARY_WORKSPACE).nodeCount
  })

  it('resumes from cursor position (no reprocessing)', async () => {
    if (stateBefore?.status === 'completed') {
      console.log('[resume] Phase 2 completed all batches — testing skip behavior')
    }

    const openclawConfig = readOpenClawConfig()
    const pluginConfig = parseConfig(openclawConfig.pluginConfig)

    const rawGenerateFn = createGatewayCompletionsGenerateFn({
      port: 18789,
      authToken: openclawConfig.gatewayAuthToken,
    })
    const generateFn = wrapGenerateFnWithTracker(rawGenerateFn, 'phase-3-resume')
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

    console.log(`[resume] Starting resume tick (max ${BATCH_CAP} batches from cursor ${stateBefore?.cursor ?? 0})...`)
    const startTime = Date.now()

    const result = await runBootstrapTick({
      workspaceDir: SECRETARY_WORKSPACE,
      config: configWithCap,
      llmClient,
      force: false,
    })

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    console.log(`[resume] Completed in ${elapsed}s`)
    console.log(`[resume] Result: ${JSON.stringify(result, null, 2)}`)

    if (stateBefore?.status === 'completed') {
      // Should skip (already done)
      expect(result.ran).toBe(false)
      console.log('[resume] Correctly skipped (already completed)')
    } else {
      // Should resume from cursor
      expect(result.ran).toBe(true)
    }
  }, 300_000)

  it('cursor advanced beyond Phase 2 position', () => {
    if (stateBefore?.status === 'completed') {
      return // Skip: Phase 2 already completed
    }

    const stateAfter = readBootstrapState(omgRoot)
    expect(stateAfter).not.toBeNull()

    if (stateAfter && stateBefore) {
      expect(stateAfter.cursor).toBeGreaterThan(stateBefore.cursor)
      console.log(`[resume] Cursor advanced: ${stateBefore.cursor} → ${stateAfter.cursor}`)
    }
  })

  it('ok count grew (new batches processed)', () => {
    if (stateBefore?.status === 'completed') {
      return // Skip: Phase 2 already completed
    }

    const stateAfter = readBootstrapState(omgRoot)
    if (stateAfter && stateBefore) {
      expect(stateAfter.ok).toBeGreaterThanOrEqual(stateBefore.ok)
      console.log(`[resume] OK count: ${stateBefore.ok} → ${stateAfter.ok} (+${stateAfter.ok - stateBefore.ok})`)
    }
  })

  it('node count grew incrementally (no duplicate storms)', () => {
    if (stateBefore?.status === 'completed') {
      return
    }

    const nodeCountAfter = inspectOmgWorkspace(SECRETARY_WORKSPACE).nodeCount
    expect(nodeCountAfter).toBeGreaterThanOrEqual(nodeCountBefore)

    const growth = nodeCountAfter - nodeCountBefore
    const stateAfter = readBootstrapState(omgRoot)
    const batchesProcessed = (stateAfter?.ok ?? 0) - (stateBefore?.ok ?? 0)

    if (batchesProcessed > 0) {
      const nodesPerBatch = growth / batchesProcessed
      console.log(
        `[resume] Node growth: ${nodeCountBefore} → ${nodeCountAfter} (+${growth}), ` +
        `${nodesPerBatch.toFixed(1)} nodes/batch`
      )

      // Sanity: no explosion (max ~20 nodes/batch)
      expect(nodesPerBatch).toBeLessThan(20)
    }
  })
})

// ---------------------------------------------------------------------------
// Stale lock theft (Fix #5)
// ---------------------------------------------------------------------------

describe('Phase 3 — Stale lock theft', () => {
  it('steals a lock with a dead PID immediately', async () => {
    const stateBefore = readBootstrapState(omgRoot)
    const cursorBefore = stateBefore?.cursor ?? 0

    // Write a fake lock with a bogus PID and old timestamp
    const fakeLock = {
      pid: 999999,
      token: 'fake-token-dead-pid',
      startedAt: new Date(Date.now() - 600_000).toISOString(), // 10 minutes ago
      updatedAt: new Date(Date.now() - 600_000).toISOString(),
    }
    fs.writeFileSync(path.join(omgRoot, '.bootstrap-lock'), JSON.stringify(fakeLock))
    console.log('[resume] Wrote fake lock with PID 999999')

    const openclawConfig = readOpenClawConfig()
    const pluginConfig = parseConfig(openclawConfig.pluginConfig)
    const rawGenerateFn = createGatewayCompletionsGenerateFn({
      port: 18789,
      authToken: openclawConfig.gatewayAuthToken,
    })
    const generateFn = wrapGenerateFnWithTracker(rawGenerateFn, 'phase-3-stale-lock')
    const llmClient = createLlmClient(
      openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-6',
      generateFn,
    )

    // Bootstrap should steal the lock (PID 999999 is dead) and resume
    const result = await runBootstrapTick({
      workspaceDir: SECRETARY_WORKSPACE,
      config: { ...pluginConfig, bootstrap: { ...pluginConfig.bootstrap, batchBudgetPerRun: 1 } },
      llmClient,
      force: false,
    })

    // Verify lock was stolen (bootstrap ran or skipped if already completed)
    const lockAfter = readBootstrapLock(omgRoot)
    expect(lockAfter).toBeNull() // Released after tick

    // Verify cursor did NOT rewind
    const stateAfter = readBootstrapState(omgRoot)
    if (stateAfter && stateBefore) {
      expect(stateAfter.cursor).toBeGreaterThanOrEqual(cursorBefore)
      console.log(`[resume] After stale lock theft: cursor ${cursorBefore} → ${stateAfter.cursor} (no rewind)`)
    }

    console.log(`[resume] Stale lock theft result: ran=${result.ran}`)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('Phase 3 — Idempotency', () => {
  it('running tick again after completion is a no-op', async () => {
    const state = readBootstrapState(omgRoot)
    if (state?.status !== 'completed') {
      console.log('[resume] Skipping idempotency test — bootstrap not yet completed')
      return
    }

    const nodeCountBefore = inspectOmgWorkspace(SECRETARY_WORKSPACE).nodeCount

    const openclawConfig = readOpenClawConfig()
    const pluginConfig = parseConfig(openclawConfig.pluginConfig)
    const rawGenerateFn = createGatewayCompletionsGenerateFn({
      port: 18789,
      authToken: openclawConfig.gatewayAuthToken,
    })
    const generateFn = wrapGenerateFnWithTracker(rawGenerateFn, 'phase-3-idempotency')
    const llmClient = createLlmClient(
      openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-6',
      generateFn,
    )

    const result = await runBootstrapTick({
      workspaceDir: SECRETARY_WORKSPACE,
      config: { ...pluginConfig, bootstrap: { ...pluginConfig.bootstrap, batchBudgetPerRun: BATCH_CAP } },
      llmClient,
      force: false,
    })

    expect(result.ran).toBe(false)

    const nodeCountAfter = inspectOmgWorkspace(SECRETARY_WORKSPACE).nodeCount
    expect(nodeCountAfter).toBe(nodeCountBefore)

    console.log(`[resume] Idempotency confirmed: no new nodes written on re-run`)
    console.log(`[resume] ${llmTracker.summary()}`)
  }, 60_000)
})
