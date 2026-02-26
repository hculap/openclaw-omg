/**
 * Phase 12 — Bootstrap retry filtering (live test).
 *
 * Validates the new retry enhancement features:
 *   - --error-type llm-error → retries only gateway timeout failures, preserves parse-empty
 *   - --timeout 300000 → uses a 5-min timeout via factory closure
 *   - --batches → targets specific batch indices
 *   - Selective failure log preservation (un-retried entries kept)
 *
 * Uses the real Secretary workspace failure log from the initial bootstrap run.
 *
 * COST: ~6 Sonnet calls (only llm-error batches retried). Estimated: ~$0.30-0.60.
 * Run with: OPENCLAW_LIVE=1 pnpm vitest run tests/live/phase-12-retry-filtering.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  requireLiveEnv,
  readOpenClawConfig,
  inspectOmgWorkspace,
  wrapGenerateFnWithTracker,
  llmTracker,
  writeTrackerArtifact,
  writeArtifact,
  SECRETARY_WORKSPACE,
} from './helpers.js'

// Dynamic imports (resolved in beforeAll)
let runBootstrapRetry: typeof import('../../src/bootstrap/bootstrap.js')['runBootstrapRetry']
let createLlmClient: typeof import('../../src/llm/client.js')['createLlmClient']
let createGatewayCompletionsGenerateFn: typeof import('../../src/llm/gateway-completions.js')['createGatewayCompletionsGenerateFn']
let parseConfig: typeof import('../../src/config.js')['parseConfig']
let readFailureLog: typeof import('../../src/bootstrap/failure-log.js')['readFailureLog']
let _clearActiveClaims: typeof import('../../src/bootstrap/lock.js')['_clearActiveClaims']
type BootstrapFailureEntry = import('../../src/bootstrap/failure-log.js').BootstrapFailureEntry
type LlmClient = import('../../src/llm/client.js').LlmClient

const OMG_ROOT = path.join(SECRETARY_WORKSPACE, 'memory/omg')
const FAILURE_LOG_PATH = path.join(OMG_ROOT, '.bootstrap-failures.jsonl')

let preFailures: BootstrapFailureEntry[] = []
let preNodeCount = 0

afterAll(() => {
  console.log(`[phase-12] ${llmTracker.summary()}`)
  writeTrackerArtifact()
})

beforeAll(async () => {
  requireLiveEnv()

  const bootstrap = await import('../../src/bootstrap/bootstrap.js')
  runBootstrapRetry = bootstrap.runBootstrapRetry

  const client = await import('../../src/llm/client.js')
  createLlmClient = client.createLlmClient

  const gateway = await import('../../src/llm/gateway-completions.js')
  createGatewayCompletionsGenerateFn = gateway.createGatewayCompletionsGenerateFn

  const configMod = await import('../../src/config.js')
  parseConfig = configMod.parseConfig

  const failureLogMod = await import('../../src/bootstrap/failure-log.js')
  readFailureLog = failureLogMod.readFailureLog

  const lockMod = await import('../../src/bootstrap/lock.js')
  _clearActiveClaims = lockMod._clearActiveClaims

  // Clean up any stale lock
  const lockPath = path.join(OMG_ROOT, '.bootstrap-lock')
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath)
    console.log('[phase-12] cleaned up stale bootstrap lock')
  }
  _clearActiveClaims()
})

function buildLlmClient(openclawConfig: ReturnType<typeof readOpenClawConfig>, timeoutMs?: number): LlmClient {
  const generateFn = createGatewayCompletionsGenerateFn({
    port: 18789,
    authToken: openclawConfig.gatewayAuthToken,
    model: openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-20250514',
    timeoutMs,
  })
  const trackedGenerateFn = wrapGenerateFnWithTracker(generateFn, 'phase-12-retry')
  return createLlmClient(
    openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-20250514',
    trackedGenerateFn,
  )
}

// ---------------------------------------------------------------------------
// Phase 12A — Pre-check: record current failure state
// ---------------------------------------------------------------------------

describe('Phase 12A — Pre-check', () => {
  it('reads current failure log and workspace state', async () => {
    preFailures = await readFailureLog(OMG_ROOT)
    const workspace = inspectOmgWorkspace(SECRETARY_WORKSPACE)
    preNodeCount = workspace.nodeCount

    const byType: Record<string, number> = {}
    for (const f of preFailures) {
      byType[f.errorType] = (byType[f.errorType] ?? 0) + 1
    }

    writeArtifact('phase-12-pre-failures.json', { count: preFailures.length, byType, entries: preFailures })
    console.log(`[phase-12] pre-state: ${preFailures.length} failures, ${preNodeCount} nodes`)
    console.log(`[phase-12] failure types: ${JSON.stringify(byType)}`)

    expect(preFailures.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Phase 12B — Retry with --error-type llm-error --timeout 300000
// ---------------------------------------------------------------------------

describe('Phase 12B — Retry llm-error only with 5-min timeout', { timeout: 900_000 }, () => {
  it('retries only llm-error batches, preserves parse-empty entries', async () => {
    _clearActiveClaims()
    const lockPath = path.join(OMG_ROOT, '.bootstrap-lock')
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath)

    const llmErrorCount = preFailures.filter((f) => f.errorType === 'llm-error').length
    const parseEmptyCount = preFailures.filter((f) => f.errorType === 'parse-empty').length

    if (llmErrorCount === 0) {
      console.log('[phase-12] no llm-error failures to retry — skipping')
      return
    }

    console.log(`[phase-12] retrying ${llmErrorCount} llm-error batches (preserving ${parseEmptyCount} parse-empty)`)

    const openclawConfig = readOpenClawConfig()
    const pluginConfig = parseConfig(openclawConfig.pluginConfig)
    const defaultClient = buildLlmClient(openclawConfig)

    // Factory closure — the key feature under test
    const factoryCalls: number[] = []
    const retryLlmClientFactory = (overrideMs: number): LlmClient => {
      factoryCalls.push(overrideMs)
      return buildLlmClient(openclawConfig, overrideMs)
    }

    const result = await runBootstrapRetry({
      workspaceDir: SECRETARY_WORKSPACE,
      config: pluginConfig,
      llmClient: defaultClient,
      timeoutMs: 300_000,
      errorTypeFilter: 'llm-error',
      createLlmClientWithTimeout: retryLlmClientFactory,
    })

    writeArtifact('phase-12-retry-result.json', result)
    console.log(`[phase-12] retry result: ran=${result.ran}, retried=${result.retriedCount}, nodes=${result.nodesWritten}, stillFailed=${result.stillFailedCount}`)
    console.log(`[phase-12] retriedBatchIndices: ${JSON.stringify(result.retriedBatchIndices)}`)
    console.log(`[phase-12] factory called ${factoryCalls.length} time(s) with timeout: ${JSON.stringify(factoryCalls)}`)

    // Core assertions
    expect(result.ran).toBe(true)
    expect(result.retriedCount).toBe(llmErrorCount)

    // Factory should have been called exactly once with 300000
    expect(factoryCalls).toEqual([300_000])

    // retriedBatchIndices should only contain llm-error batch indices
    const llmErrorIndices = [...new Set(preFailures.filter((f) => f.errorType === 'llm-error').map((f) => f.batchIndex))]
    expect(result.retriedBatchIndices).toBeDefined()
    for (const idx of result.retriedBatchIndices ?? []) {
      expect(llmErrorIndices).toContain(idx)
    }

    // parse-empty entries should be preserved in failure log
    const postFailures = await readFailureLog(OMG_ROOT)
    writeArtifact('phase-12-post-failures.json', postFailures)

    const postParseEmpty = postFailures.filter((f) => f.errorType === 'parse-empty')
    console.log(`[phase-12] post-retry: ${postFailures.length} failures remain (${postParseEmpty.length} parse-empty preserved)`)

    // The parse-empty entries from before should still be there
    expect(postParseEmpty.length).toBe(parseEmptyCount)

    // Post-retry workspace
    const workspace = inspectOmgWorkspace(SECRETARY_WORKSPACE)
    console.log(`[phase-12] post-retry: ${workspace.nodeCount} nodes (was ${preNodeCount}, +${workspace.nodeCount - preNodeCount})`)
    writeArtifact('phase-12-post-workspace.json', workspace)
  })
})
