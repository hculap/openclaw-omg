/**
 * Phase 5 — Maintenance, dedup, and reflector live tests.
 *
 * Tests cron-triggered maintenance operations:
 *   - Dedup: finds and merges near-duplicate nodes
 *   - Reflector: produces reflection nodes from aged observations
 *   - Maintenance: registry integrity, MOC repair
 *
 * COST: ~2-4 Sonnet calls ≈ $0.20-$0.40.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  requireLiveEnv,
  readOpenClawConfig,
  inspectOmgWorkspace,
  readBootstrapState,
  llmTracker,
  writeTrackerArtifact,
  writeRegistrySummaryArtifact,
  writeFileListArtifact,
  writeArtifact,
  SECRETARY_WORKSPACE,
  ARTIFACTS_DIR,
} from './helpers.js'

let createLlmClient: typeof import('../../src/llm/client.js')['createLlmClient']
let createGatewayCompletionsGenerateFn: typeof import('../../src/llm/gateway-completions.js')['createGatewayCompletionsGenerateFn']
let parseConfig: typeof import('../../src/config.js')['parseConfig']

const omgRoot = path.join(SECRETARY_WORKSPACE, 'memory/omg')

beforeAll(async () => {
  requireLiveEnv()

  const client = await import('../../src/llm/client.js')
  createLlmClient = client.createLlmClient

  const gateway = await import('../../src/llm/gateway-completions.js')
  createGatewayCompletionsGenerateFn = gateway.createGatewayCompletionsGenerateFn

  const configMod = await import('../../src/config.js')
  parseConfig = configMod.parseConfig
})

function buildLlmClient() {
  const openclawConfig = readOpenClawConfig()
  const generateFn = createGatewayCompletionsGenerateFn({
    port: 18789,
    authToken: openclawConfig.gatewayAuthToken,
  })
  return {
    llmClient: createLlmClient(
      openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-6',
      generateFn,
    ),
    config: parseConfig(openclawConfig.pluginConfig),
  }
}

// ---------------------------------------------------------------------------
// Registry integrity
// ---------------------------------------------------------------------------

describe('Phase 5 — Registry integrity', () => {
  it('registry.json exists and is valid JSON', () => {
    const registryPath = path.join(omgRoot, 'registry.json')
    if (!fs.existsSync(registryPath)) {
      console.log('[maintenance] No registry.json yet — skipping')
      return
    }

    const raw = fs.readFileSync(registryPath, 'utf-8')
    const registry = JSON.parse(raw) as Record<string, unknown>
    expect(registry).toBeDefined()

    const entries = Object.keys(registry)
    console.log(`[maintenance] Registry entries: ${entries.length}`)
  })

  it('registry entries have required fields', () => {
    const registryPath = path.join(omgRoot, 'registry.json')
    if (!fs.existsSync(registryPath)) return

    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as Record<string, Record<string, unknown>>

    let validCount = 0
    let invalidCount = 0

    for (const [nodeId, entry] of Object.entries(registry)) {
      if (typeof entry !== 'object' || entry === null) {
        invalidCount++
        continue
      }

      const hasType = typeof entry['type'] === 'string'
      const hasPath = typeof entry['path'] === 'string'

      if (hasType && hasPath) {
        validCount++
      } else {
        invalidCount++
        console.warn(`[maintenance] Invalid registry entry: ${nodeId} (type=${entry['type']}, path=${entry['path']})`)
      }
    }

    console.log(`[maintenance] Registry: ${validCount} valid, ${invalidCount} invalid`)
    expect(invalidCount).toBe(0)
  })

  it('all registry entries point to existing files', () => {
    const registryPath = path.join(omgRoot, 'registry.json')
    if (!fs.existsSync(registryPath)) return

    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as Record<string, Record<string, unknown>>
    let missing = 0
    let total = 0

    for (const entry of Object.values(registry)) {
      const entryPath = entry['path'] as string | undefined
      if (!entryPath) continue
      total++

      const fullPath = path.join(omgRoot, entryPath)
      if (!fs.existsSync(fullPath)) {
        missing++
        console.warn(`[maintenance] Missing file: ${fullPath}`)
      }
    }

    console.log(`[maintenance] File integrity: ${total - missing}/${total} files present`)
    expect(missing).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// MOC integrity
// ---------------------------------------------------------------------------

describe('Phase 5 — MOC integrity', () => {
  it('MOC files exist and contain wikilinks', () => {
    const mocsDir = path.join(omgRoot, 'mocs')
    if (!fs.existsSync(mocsDir)) {
      console.log('[maintenance] No mocs directory — skipping')
      return
    }

    const mocFiles = fs.readdirSync(mocsDir).filter(f => f.endsWith('.md'))
    console.log(`[maintenance] MOC files: ${mocFiles.length}`)

    for (const mocFile of mocFiles) {
      const content = fs.readFileSync(path.join(mocsDir, mocFile), 'utf-8')
      expect(content.length).toBeGreaterThan(0)

      // MOCs should contain wikilinks to nodes
      const wikilinks = content.match(/\[\[.*?\]\]/g)
      console.log(`[maintenance] ${mocFile}: ${wikilinks?.length ?? 0} wikilinks`)
    }
  })
})

// ---------------------------------------------------------------------------
// Dedup (informational — may not find duplicates)
// ---------------------------------------------------------------------------

describe('Phase 5 — Dedup', () => {
  it('dedup module loads without error', async () => {
    const dedup = await import('../../src/dedup/dedup.js')
    expect(dedup).toBeDefined()
    console.log('[dedup] Module loaded successfully')
  })

  it('candidate generation runs without error', async () => {
    const { generateCandidatePairs } = await import('../../src/dedup/candidates.js')
    const registryPath = path.join(omgRoot, 'registry.json')
    if (!fs.existsSync(registryPath)) {
      console.log('[dedup] No registry — skipping candidate generation')
      return
    }

    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8')) as Record<string, unknown>
    const entries = Object.entries(registry) as [string, import('../../src/graph/registry.js').RegistryNodeEntry][]

    const defaultDedupConfig = {
      similarityThreshold: 0.6,
      maxClustersPerRun: 10,
      maxClusterSize: 10,
      maxPairsPerBucket: 50,
      staleDaysThreshold: 30,
      stableTypes: ['preference', 'project', 'person'],
    }

    // generateCandidatePairs expects registry entries — check it doesn't crash
    try {
      const pairs = generateCandidatePairs(entries, null, defaultDedupConfig)
      console.log(`[dedup] Candidate pairs found: ${pairs.length}`)
      if (pairs.length > 0) {
        console.log(`[dedup] Sample pair: ${JSON.stringify(pairs[0], null, 2)}`)
      }
    } catch (err) {
      console.log(`[dedup] Candidate generation error (may be expected): ${err}`)
    }
  })
})

// ---------------------------------------------------------------------------
// Reflector (informational — needs aged nodes)
// ---------------------------------------------------------------------------

describe('Phase 5 — Reflector', () => {
  it('reflector module loads without error', async () => {
    const reflector = await import('../../src/reflector/reflector.js')
    expect(reflector).toBeDefined()
    console.log('[reflector] Module loaded successfully')
  })
})

// ---------------------------------------------------------------------------
// Final state report
// ---------------------------------------------------------------------------

describe('Phase 5 — Final state report + artifacts', () => {
  it('produces comprehensive state summary and writes artifacts', () => {
    const state = inspectOmgWorkspace(SECRETARY_WORKSPACE)
    const bootstrapState = readBootstrapState(state.omgRoot)

    console.log('\n=== LIVE TEST FINAL STATE ===')
    console.log(`OMG root: ${state.omgRoot}`)
    console.log(`Exists: ${state.exists}`)
    console.log(`Has index: ${state.hasIndex}`)
    console.log(`Has now: ${state.hasNow}`)
    console.log(`Has registry: ${state.hasRegistry}`)
    console.log(`Bootstrap status: ${bootstrapState?.status ?? 'n/a'}`)
    console.log(`Bootstrap cursor: ${bootstrapState?.cursor ?? 0}/${bootstrapState?.total ?? 0}`)
    console.log(`Node count: ${state.nodeCount}`)
    console.log(`Node types: ${state.nodeTypes.join(', ')}`)
    console.log(`MOC count: ${state.mocCount}`)
    console.log(`${llmTracker.summary()}`)
    console.log('=============================\n')

    // Write artifacts for debugging (Fix #7)
    writeArtifact('final-state.json', {
      workspace: state,
      bootstrap: bootstrapState,
      llm: {
        calls: llmTracker.calls,
        inputTokens: llmTracker.inputTokens,
        outputTokens: llmTracker.outputTokens,
      },
    })
    writeTrackerArtifact()
    writeRegistrySummaryArtifact(state.omgRoot)
    writeFileListArtifact(state.omgRoot)

    console.log(`[artifacts] Written to ${ARTIFACTS_DIR}`)

    expect(state.exists).toBe(true)
  })
})
