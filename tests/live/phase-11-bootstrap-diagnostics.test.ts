/**
 * Phase 11 — Bootstrap diagnostics & failure recovery.
 *
 * Validates the new bootstrap diagnostics features (Issue #86):
 *   - Markdown fence stripping parses previously-failing LLM output
 *   - Failure log is populated for batches that produce 0 nodes
 *   - Quality metrics compute correctly from registry
 *   - --retry-failed re-processes failed batches
 *   - Parse-empty failures are eliminated (all failures should be LLM errors)
 *
 * Uses runBootstrapTick with a small batch cap to limit cost and time.
 *
 * COST: ~10 Sonnet calls. Estimated: ~$0.50-1.00.
 * Run with: OPENCLAW_LIVE=1 pnpm vitest run tests/live/phase-11-bootstrap-diagnostics.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  requireLiveEnv,
  readOpenClawConfig,
  inspectOmgWorkspace,
  readBootstrapState,
  wrapGenerateFnWithTracker,
  llmTracker,
  writeTrackerArtifact,
  writeRegistrySummaryArtifact,
  writeFileListArtifact,
  writeArtifact,
  SECRETARY_WORKSPACE,
  BATCH_CAP,
} from './helpers.js'

// Dynamic imports (resolved in beforeAll)
let runBootstrapTick: typeof import('../../src/bootstrap/bootstrap.js')['runBootstrapTick']
let runBootstrapRetry: typeof import('../../src/bootstrap/bootstrap.js')['runBootstrapRetry']
let createLlmClient: typeof import('../../src/llm/client.js')['createLlmClient']
let createGatewayCompletionsGenerateFn: typeof import('../../src/llm/gateway-completions.js')['createGatewayCompletionsGenerateFn']
let scaffoldGraphIfNeeded: typeof import('../../src/scaffold.js')['scaffoldGraphIfNeeded']
let parseConfig: typeof import('../../src/config.js')['parseConfig']
let readFailureLog: typeof import('../../src/bootstrap/failure-log.js')['readFailureLog']
let clearFailureLog: typeof import('../../src/bootstrap/failure-log.js')['clearFailureLog']
let computeBootstrapQuality: typeof import('../../src/bootstrap/quality-metrics.js')['computeBootstrapQuality']
let getRegistryEntries: typeof import('../../src/graph/registry.js')['getRegistryEntries']
let stripMarkdownFences: typeof import('../../src/observer/parser.js')['stripMarkdownFences']
let _clearActiveClaims: typeof import('../../src/bootstrap/lock.js')['_clearActiveClaims']

const OMG_ROOT = path.join(SECRETARY_WORKSPACE, 'memory/omg')

afterAll(() => {
  console.log(`[phase-11] ${llmTracker.summary()}`)
  writeTrackerArtifact()
  writeRegistrySummaryArtifact(OMG_ROOT)
  writeFileListArtifact(OMG_ROOT)
})

beforeAll(async () => {
  requireLiveEnv()

  const bootstrap = await import('../../src/bootstrap/bootstrap.js')
  runBootstrapTick = bootstrap.runBootstrapTick
  runBootstrapRetry = bootstrap.runBootstrapRetry

  const client = await import('../../src/llm/client.js')
  createLlmClient = client.createLlmClient

  const gateway = await import('../../src/llm/gateway-completions.js')
  createGatewayCompletionsGenerateFn = gateway.createGatewayCompletionsGenerateFn

  const scaffold = await import('../../src/scaffold.js')
  scaffoldGraphIfNeeded = scaffold.scaffoldGraphIfNeeded

  const configMod = await import('../../src/config.js')
  parseConfig = configMod.parseConfig

  const failureLogMod = await import('../../src/bootstrap/failure-log.js')
  readFailureLog = failureLogMod.readFailureLog
  clearFailureLog = failureLogMod.clearFailureLog

  const qualityMod = await import('../../src/bootstrap/quality-metrics.js')
  computeBootstrapQuality = qualityMod.computeBootstrapQuality

  const registryMod = await import('../../src/graph/registry.js')
  getRegistryEntries = registryMod.getRegistryEntries

  const parserMod = await import('../../src/observer/parser.js')
  stripMarkdownFences = parserMod.stripMarkdownFences

  const lockMod = await import('../../src/bootstrap/lock.js')
  _clearActiveClaims = lockMod._clearActiveClaims

  // Clean up any stale lock from previous test runs
  const lockPath = path.join(OMG_ROOT, '.bootstrap-lock')
  if (fs.existsSync(lockPath)) {
    fs.unlinkSync(lockPath)
    console.log('[phase-11] cleaned up stale bootstrap lock')
  }
  _clearActiveClaims()
})

// ---------------------------------------------------------------------------
// Phase 11A — Fence stripping unit validation against real LLM responses
// ---------------------------------------------------------------------------

describe('Phase 11A — Fence stripping', () => {
  it('strips xml fences from real-world LLM patterns', () => {
    const patterns = [
      // Full fence with xml tag
      '```xml\n<observations><operations></operations></observations>\n```',
      // Preamble + fence (common LLM pattern)
      'Here is the extracted XML:\n\n```xml\n<observations><operations></operations></observations>\n```',
      // Fence without language tag
      '```\n<observations><operations></operations></observations>\n```',
      // No fence (passthrough)
      '<observations><operations></operations></observations>',
    ]

    for (const input of patterns) {
      const result = stripMarkdownFences(input)
      expect(result).toContain('<observations>')
      expect(result).not.toContain('```')
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 11B — Capped bootstrap with failure logging
// ---------------------------------------------------------------------------

describe('Phase 11B — Bootstrap tick with failure logging', { timeout: 600_000 }, () => {
  it('scaffolds graph before bootstrap', async () => {
    const openclawConfig = readOpenClawConfig()
    const pluginConfig = parseConfig(openclawConfig.pluginConfig)
    await scaffoldGraphIfNeeded(SECRETARY_WORKSPACE, pluginConfig)
    expect(fs.existsSync(OMG_ROOT)).toBe(true)
  })

  it('clears failure log before test run', async () => {
    await clearFailureLog(OMG_ROOT)
    const entries = await readFailureLog(OMG_ROOT)
    expect(entries).toHaveLength(0)
  })

  it('records pre-bootstrap state', () => {
    const state = readBootstrapState(OMG_ROOT)
    const workspace = inspectOmgWorkspace(SECRETARY_WORKSPACE)
    writeArtifact('phase-11-pre-state.json', { state, workspace })
    console.log(`[phase-11] pre-bootstrap: ${workspace.nodeCount} nodes, state=${state?.status ?? 'null'}`)
  })

  it('runs bootstrap tick with force (limited batches)', async () => {
    const openclawConfig = readOpenClawConfig()
    const pluginConfig = parseConfig({
      ...openclawConfig.pluginConfig,
      bootstrap: {
        ...(openclawConfig.pluginConfig['bootstrap'] as Record<string, unknown> ?? {}),
        batchBudgetPerRun: Math.min(BATCH_CAP, 5),
      },
    })

    const generateFn = createGatewayCompletionsGenerateFn({
      port: 18789,
      authToken: openclawConfig.gatewayAuthToken,
      model: openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-20250514',
    })
    const trackedGenerateFn = wrapGenerateFnWithTracker(generateFn, 'phase-11-bootstrap')
    const llmClient = createLlmClient(
      openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-20250514',
      trackedGenerateFn,
    )

    const result = await runBootstrapTick({
      workspaceDir: SECRETARY_WORKSPACE,
      config: pluginConfig,
      llmClient,
      force: true,
    })

    writeArtifact('phase-11-bootstrap-result.json', result)
    console.log(`[phase-11] tick result: ran=${result.ran}, batches=${result.batchesProcessed}, succeeded=${result.chunksSucceeded}, nodes=${result.nodesWritten}, more=${result.moreWorkRemains}`)

    expect(result.ran).toBe(true)
  })

  it('failure log contains entries (if any failures occurred)', async () => {
    const failures = await readFailureLog(OMG_ROOT)
    writeArtifact('phase-11-failure-log.json', failures)
    console.log(`[phase-11] failure log: ${failures.length} entries`)

    // Categorize by error type
    const byType: Record<string, number> = {}
    for (const f of failures) {
      byType[f.errorType] = (byType[f.errorType] ?? 0) + 1
    }
    console.log(`[phase-11] failure types: ${JSON.stringify(byType)}`)
    writeArtifact('phase-11-failure-types.json', byType)

    // Key assertion: NO parse-empty failures — fence stripping should eliminate them
    const parseEmptyCount = byType['parse-empty'] ?? 0
    const zeroOpsCount = byType['zero-operations'] ?? 0
    console.log(`[phase-11] parse-empty=${parseEmptyCount}, zero-operations=${zeroOpsCount}`)

    // Fence stripping should eliminate parse-empty failures entirely.
    // zero-operations may still occur if the LLM genuinely returns no useful data
    // for some chunks, but parse-empty (where fences blocked XML parsing) should be 0.
    expect(parseEmptyCount).toBe(0)
  })

  it('failure entries have correct schema', async () => {
    const failures = await readFailureLog(OMG_ROOT)
    for (const f of failures) {
      expect(f.batchIndex).toBeTypeOf('number')
      expect(f.labels).toBeInstanceOf(Array)
      expect(f.errorType).toBeTypeOf('string')
      expect(f.error).toBeTypeOf('string')
      expect(f.timestamp).toBeTypeOf('string')
      expect(f.chunkCount).toBeTypeOf('number')
    }
  })

  it('bootstrap state is updated correctly', () => {
    const state = readBootstrapState(OMG_ROOT)
    writeArtifact('phase-11-post-state.json', state)
    expect(state).not.toBeNull()
    // Should be either paused (more batches remain) or completed
    expect(['paused', 'completed']).toContain(state!.status)
    console.log(`[phase-11] state: status=${state!.status}, ok=${state!.ok}, fail=${state!.fail}, cursor=${state!.cursor}/${state!.total}`)
  })
})

// ---------------------------------------------------------------------------
// Phase 11C — Quality metrics analysis
// ---------------------------------------------------------------------------

describe('Phase 11C — Quality metrics', { timeout: 30_000 }, () => {
  it('computes quality report from registry', async () => {
    const entries = await getRegistryEntries(OMG_ROOT)
    const report = computeBootstrapQuality(entries)

    writeArtifact('phase-11-quality-report.json', report)
    console.log(`[phase-11] quality: ${report.totalNodes} nodes, warnings=${report.warnings.length}`)
    console.log(`[phase-11] type distribution: ${JSON.stringify(report.typeCounts)}`)

    for (const warning of report.warnings) {
      console.warn(`[phase-11] quality warning: ${warning}`)
    }

    expect(report.totalNodes).toBeGreaterThan(0)
  })

  it('post-bootstrap workspace snapshot', () => {
    const workspace = inspectOmgWorkspace(SECRETARY_WORKSPACE)
    writeArtifact('phase-11-post-workspace.json', workspace)
    console.log(`[phase-11] workspace: ${workspace.nodeCount} nodes, ${workspace.mocCount} mocs, types=[${workspace.nodeTypes.join(', ')}]`)

    // List per-type counts
    for (const typeDir of workspace.nodeTypes) {
      const typePath = path.join(OMG_ROOT, 'nodes', typeDir)
      try {
        const count = fs.readdirSync(typePath).filter((f: string) => f.endsWith('.md')).length
        console.log(`[phase-11]   ${typeDir}: ${count}`)
      } catch { /* ignore */ }
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 11D — Retry mechanism (only if failures exist)
// ---------------------------------------------------------------------------

describe('Phase 11D — Retry failed batches', { timeout: 600_000 }, () => {
  it('retries failed batches from the failure log', async () => {
    // Clean up lock from previous bootstrap tick (which may have timed out)
    const lockPath = path.join(OMG_ROOT, '.bootstrap-lock')
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath)
    }
    _clearActiveClaims()

    const preFailures = await readFailureLog(OMG_ROOT)
    if (preFailures.length === 0) {
      console.log('[phase-11] no failures to retry — skipping')
      return
    }

    console.log(`[phase-11] retrying ${preFailures.length} failed batches`)

    const openclawConfig = readOpenClawConfig()
    const pluginConfig = parseConfig(openclawConfig.pluginConfig)

    const generateFn = createGatewayCompletionsGenerateFn({
      port: 18789,
      authToken: openclawConfig.gatewayAuthToken,
      model: openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-20250514',
    })
    const trackedGenerateFn = wrapGenerateFnWithTracker(generateFn, 'phase-11-retry')
    const llmClient = createLlmClient(
      openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-20250514',
      trackedGenerateFn,
    )

    const result = await runBootstrapRetry({
      workspaceDir: SECRETARY_WORKSPACE,
      config: pluginConfig,
      llmClient,
    })

    writeArtifact('phase-11-retry-result.json', result)
    console.log(`[phase-11] retry result: ran=${result.ran}, retried=${result.retriedCount}, nodes=${result.nodesWritten}, stillFailed=${result.stillFailedCount}`)

    // Retry should run (we know there are failures)
    expect(result.ran).toBe(true)

    // Post-retry failure log
    const postFailures = await readFailureLog(OMG_ROOT)
    console.log(`[phase-11] post-retry failures: ${postFailures.length} (was ${preFailures.length})`)
    writeArtifact('phase-11-post-retry-failures.json', postFailures)
  })

  it('post-retry workspace snapshot', () => {
    const workspace = inspectOmgWorkspace(SECRETARY_WORKSPACE)
    writeArtifact('phase-11-post-retry-workspace.json', workspace)
    console.log(`[phase-11] post-retry: ${workspace.nodeCount} nodes, types=[${workspace.nodeTypes.join(', ')}]`)
  })
})
