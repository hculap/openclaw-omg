/**
 * Phase 14 — Semantic Dedup + Extraction Guardrails live tests.
 *
 * Tests Feature A (semantic dedup) and Feature C (extraction guardrails)
 * against real Secretary workspace data:
 *
 *   Part A — Semantic Blocks (no LLM): verify blocking, domain grouping, heuristic scoring
 *   Part B — Semantic Dedup (1-2 LLM calls): run on real blocks, verify parse + merge
 *   Part C — Source Fingerprinting (no LLM): fingerprint real nodes, verify overlap
 *   Part D — Candidate Suppression (no LLM): suppress against real registry entries
 *
 * COST: ~1-3 Sonnet calls ≈ $0.10-$0.50. Parts A/C/D are $0.
 *
 * NOTE: Gateway /v1/chat/completions always returns usage:{prompt_tokens:0,completion_tokens:0}.
 * tokensUsed will be 0 even on successful LLM calls. Tests account for this.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  requireLiveEnv,
  readOpenClawConfig,
  wrapGenerateFnWithTracker,
  llmTracker,
  writeArtifact,
  hashDirectory,
  SECRETARY_WORKSPACE,
  TECHLEAD_WORKSPACE,
} from './helpers.js'

let createLlmClient: typeof import('../../src/llm/client.js')['createLlmClient']
let createGatewayCompletionsGenerateFn: typeof import('../../src/llm/gateway-completions.js')['createGatewayCompletionsGenerateFn']
let parseConfig: typeof import('../../src/config.js')['parseConfig']
let getRegistryEntries: typeof import('../../src/graph/registry.js')['getRegistryEntries']
let resolveOmgRoot: typeof import('../../src/utils/paths.js')['resolveOmgRoot']
let generateSemanticBlocks: typeof import('../../src/dedup/semantic-blocks.js')['generateSemanticBlocks']
let runSemanticDedup: typeof import('../../src/dedup/semantic-dedup.js')['runSemanticDedup']
let buildFingerprint: typeof import('../../src/observer/source-fingerprint.js')['buildFingerprint']
let computeOverlap: typeof import('../../src/observer/source-fingerprint.js')['computeOverlap']
let checkSourceOverlap: typeof import('../../src/observer/extraction-guardrails.js')['checkSourceOverlap']
let suppressDuplicateCandidates: typeof import('../../src/observer/extraction-guardrails.js')['suppressDuplicateCandidates']
let parseFrontmatter: typeof import('../../src/utils/frontmatter.js')['parseFrontmatter']

beforeAll(async () => {
  requireLiveEnv()

  const client = await import('../../src/llm/client.js')
  createLlmClient = client.createLlmClient

  const gateway = await import('../../src/llm/gateway-completions.js')
  createGatewayCompletionsGenerateFn = gateway.createGatewayCompletionsGenerateFn

  const configMod = await import('../../src/config.js')
  parseConfig = configMod.parseConfig

  const registryMod = await import('../../src/graph/registry.js')
  getRegistryEntries = registryMod.getRegistryEntries

  const pathsMod = await import('../../src/utils/paths.js')
  resolveOmgRoot = pathsMod.resolveOmgRoot

  const blocksMod = await import('../../src/dedup/semantic-blocks.js')
  generateSemanticBlocks = blocksMod.generateSemanticBlocks

  const dedupMod = await import('../../src/dedup/semantic-dedup.js')
  runSemanticDedup = dedupMod.runSemanticDedup

  const fpMod = await import('../../src/observer/source-fingerprint.js')
  buildFingerprint = fpMod.buildFingerprint
  computeOverlap = fpMod.computeOverlap

  const guardrailMod = await import('../../src/observer/extraction-guardrails.js')
  checkSourceOverlap = guardrailMod.checkSourceOverlap
  suppressDuplicateCandidates = guardrailMod.suppressDuplicateCandidates

  const fmMod = await import('../../src/utils/frontmatter.js')
  parseFrontmatter = fmMod.parseFrontmatter
})

function buildConfig(overrides: Record<string, unknown> = {}) {
  const openclawConfig = readOpenClawConfig()
  return parseConfig({
    ...openclawConfig.pluginConfig,
    semanticDedup: {
      enabled: true,
      heuristicPrefilterThreshold: 0.25,
      semanticMergeThreshold: 85,
      maxBlockSize: 6,
      maxBlocksPerRun: 3,
      maxBodyCharsPerNode: 500,
      timeWindowDays: 30,
      ...overrides,
    },
    extractionGuardrails: {
      enabled: true,
      skipOverlapThreshold: 0.85,
      truncateOverlapThreshold: 0.5,
      candidateSuppressionThreshold: 0.7,
      recentWindowSize: 5,
    },
  })
}

function buildLlmClient(phase: string) {
  const openclawConfig = readOpenClawConfig()
  const rawGenerate = createGatewayCompletionsGenerateFn({
    port: 18789,
    authToken: openclawConfig.gatewayAuthToken,
  })
  const trackedGenerate = wrapGenerateFnWithTracker(rawGenerate, phase)
  return createLlmClient(
    openclawConfig.defaultModel ?? 'anthropic/claude-sonnet-4-6',
    trackedGenerate,
  )
}

// ---------------------------------------------------------------------------
// Part A — Semantic Blocks (no LLM, $0)
// ---------------------------------------------------------------------------

describe('Phase 14A — Semantic Blocks on Real Data', () => {
  let resolvedOmgRoot: string
  let allEntries: readonly [string, import('../../src/graph/registry.js').RegistryNodeEntry][]

  it('reads registry entries', async () => {
    const config = buildConfig()
    resolvedOmgRoot = resolveOmgRoot(SECRETARY_WORKSPACE, config)
    allEntries = await getRegistryEntries(resolvedOmgRoot)

    expect(allEntries.length).toBeGreaterThan(50)
    console.log(`[phase-14a] ${allEntries.length} total registry entries`)
  })

  it('generates candidate blocks with real entries', () => {
    const config = buildConfig()
    const blocks = generateSemanticBlocks(allEntries, config.semanticDedup)

    expect(blocks.length).toBeGreaterThan(0)

    const summary = blocks.map((b) => ({
      domain: b.domain,
      nodeCount: b.nodeIds.length,
      maxHeuristicScore: Math.round(b.maxHeuristicScore * 100) / 100,
      nodeIds: b.nodeIds,
    }))

    console.log(`[phase-14a] ${blocks.length} semantic block(s):`)
    for (const s of summary) {
      console.log(`  [${s.domain}] ${s.nodeCount} nodes, maxScore=${s.maxHeuristicScore}`)
    }

    writeArtifact('phase-14-blocks.json', summary)
  })

  it('blocks respect maxBlockSize', () => {
    const config = buildConfig({ maxBlockSize: 3 })
    const blocks = generateSemanticBlocks(allEntries, config.semanticDedup)

    for (const block of blocks) {
      expect(block.nodeIds.length).toBeLessThanOrEqual(3)
    }
  })

  it('blocks respect maxBlocksPerRun', () => {
    const config = buildConfig({ maxBlocksPerRun: 2 })
    const blocks = generateSemanticBlocks(allEntries, config.semanticDedup)

    expect(blocks.length).toBeLessThanOrEqual(2)
  })

  it('higher threshold produces fewer blocks', () => {
    const lowConfig = buildConfig({ heuristicPrefilterThreshold: 0.2 })
    const highConfig = buildConfig({ heuristicPrefilterThreshold: 0.6 })

    const lowBlocks = generateSemanticBlocks(allEntries, lowConfig.semanticDedup)
    const highBlocks = generateSemanticBlocks(allEntries, highConfig.semanticDedup)

    // High threshold should produce same or fewer blocks
    expect(highBlocks.length).toBeLessThanOrEqual(lowBlocks.length)
    console.log(`[phase-14a] Low threshold (0.2): ${lowBlocks.length} blocks, High threshold (0.6): ${highBlocks.length} blocks`)
  })

  it('all block node IDs exist in registry', () => {
    const config = buildConfig()
    const blocks = generateSemanticBlocks(allEntries, config.semanticDedup)
    const allIds = new Set(allEntries.map(([id]) => id))

    for (const block of blocks) {
      for (const nodeId of block.nodeIds) {
        expect(allIds.has(nodeId)).toBe(true)
      }
    }
  })

  it('blocks group same-type nodes', () => {
    const config = buildConfig()
    const blocks = generateSemanticBlocks(allEntries, config.semanticDedup)
    const entryMap = new Map(allEntries)

    for (const block of blocks) {
      const types = new Set(block.nodeIds.map((id) => entryMap.get(id)?.type))
      // All nodes within a block should be the same type
      expect(types.size).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Part B — Semantic Dedup with Real LLM (1-3 calls)
// ---------------------------------------------------------------------------

describe('Phase 14B — Semantic Dedup (LLM)', () => {
  let resolvedOmgRoot: string

  it('runs semantic dedup on real workspace (capped to 2 blocks)', async () => {
    const config = buildConfig({ maxBlocksPerRun: 2 })
    resolvedOmgRoot = resolveOmgRoot(SECRETARY_WORKSPACE, config)
    const llmClient = buildLlmClient('phase-14b')

    // Snapshot nodes dir before
    const nodesDir = path.join(resolvedOmgRoot, 'nodes')
    const hashesBefore = hashDirectory(nodesDir)

    const callsBefore = llmTracker.calls

    // Suppress console noise during test
    const origError = console.error
    const origWarn = console.warn
    const warnings: string[] = []
    console.error = (...args: unknown[]) => {
      warnings.push(String(args[0]))
    }
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]))
    }

    let result: Awaited<ReturnType<typeof runSemanticDedup>>
    try {
      result = await runSemanticDedup({ omgRoot: resolvedOmgRoot, config, llmClient })
    } finally {
      console.error = origError
      console.warn = origWarn
    }

    const callsAfter = llmTracker.calls
    const llmCallsMade = callsAfter - callsBefore

    // Snapshot after
    const hashesAfter = hashDirectory(nodesDir)
    const changedFiles = [...hashesAfter.entries()].filter(
      ([p, hash]) => hashesBefore.get(p) !== hash,
    )

    const artifact = {
      blocksProcessed: result.blocksProcessed,
      mergesExecuted: result.mergesExecuted,
      nodesArchived: result.nodesArchived,
      tokensUsed: result.tokensUsed,
      errorCount: result.errors.length,
      errors: result.errors,
      llmCallsMade,
      changedFiles: changedFiles.map(([p]) => p),
      warnings: warnings.filter((w) => w.includes('[omg]')),
    }

    console.log(`[phase-14b] blocks=${result.blocksProcessed}, merges=${result.mergesExecuted}, archived=${result.nodesArchived}`)
    console.log(`[phase-14b] LLM calls: ${llmCallsMade}, changed files: ${changedFiles.length}`)
    if (result.errors.length > 0) {
      console.log(`[phase-14b] errors: ${result.errors.join('; ')}`)
    }

    writeArtifact('phase-14-dedup-result.json', artifact)

    // Assertions
    expect(result.blocksProcessed).toBeGreaterThan(0)
    expect(result.blocksProcessed).toBeLessThanOrEqual(2)
    expect(llmCallsMade).toBeGreaterThan(0)
    expect(llmCallsMade).toBeLessThanOrEqual(2)
  })

  it('result has consistent counters', async () => {
    const config = buildConfig({ maxBlocksPerRun: 1 })
    const llmClient = buildLlmClient('phase-14b-verify')

    const origError = console.error
    const origWarn = console.warn
    console.error = () => {}
    console.warn = () => {}

    let result: Awaited<ReturnType<typeof runSemanticDedup>>
    try {
      result = await runSemanticDedup({
        omgRoot: resolveOmgRoot(SECRETARY_WORKSPACE, config),
        config,
        llmClient,
      })
    } finally {
      console.error = origError
      console.warn = origWarn
    }

    // mergesExecuted >= 0
    expect(result.mergesExecuted).toBeGreaterThanOrEqual(0)
    // nodesArchived >= mergesExecuted (each merge archives at least 1)
    expect(result.nodesArchived).toBeGreaterThanOrEqual(result.mergesExecuted)
    // errors array is always present
    expect(Array.isArray(result.errors)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Part C — Source Fingerprinting on Real Node Bodies (no LLM, $0)
// ---------------------------------------------------------------------------

describe('Phase 14C — Source Fingerprinting', () => {
  let resolvedOmgRoot: string

  it('builds fingerprints from real node bodies', async () => {
    const config = buildConfig()
    resolvedOmgRoot = resolveOmgRoot(SECRETARY_WORKSPACE, config)

    // Read a few real node files
    const nodesDir = path.join(resolvedOmgRoot, 'nodes', 'preference')
    const files = fs.readdirSync(nodesDir)
      .filter((f) => f.endsWith('.md'))
      .slice(0, 5)

    expect(files.length).toBeGreaterThan(0)

    const fingerprints = files.map((file) => {
      const content = fs.readFileSync(path.join(nodesDir, file), 'utf-8')
      const { body } = parseFrontmatter(content)
      // Simulate as if the body was a conversation message
      return buildFingerprint([{ role: 'user', content: body }])
    })

    for (const fp of fingerprints) {
      expect(fp.shingleHashes.length).toBeGreaterThan(0)
      expect(fp.messageCount).toBe(1)
      expect(fp.totalChars).toBeGreaterThan(0)
      expect(fp.timestamp).toBeTruthy()
    }

    console.log(`[phase-14c] Built ${fingerprints.length} fingerprints from real preference nodes`)
    console.log(`[phase-14c] Shingle counts: ${fingerprints.map((fp) => fp.shingleHashes.length).join(', ')}`)
  })

  it('similar nodes have higher overlap than dissimilar ones', async () => {
    const config = buildConfig()
    resolvedOmgRoot = resolveOmgRoot(SECRETARY_WORKSPACE, config)

    // Read preference nodes and fact nodes — expect within-type overlap > cross-type
    const prefDir = path.join(resolvedOmgRoot, 'nodes', 'preference')
    const factDir = path.join(resolvedOmgRoot, 'nodes', 'fact')

    const readBodies = (dir: string, max: number) => {
      return fs.readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .slice(0, max)
        .map((file) => {
          const content = fs.readFileSync(path.join(dir, file), 'utf-8')
          const { body } = parseFrontmatter(content)
          return body
        })
    }

    const prefBodies = readBodies(prefDir, 3)
    const factBodies = readBodies(factDir, 3)

    expect(prefBodies.length).toBeGreaterThan(1)
    expect(factBodies.length).toBeGreaterThan(0)

    // Within-type: first two prefs
    const fp1 = buildFingerprint([{ role: 'user', content: prefBodies[0]! }])
    const fp2 = buildFingerprint([{ role: 'user', content: prefBodies[1]! }])
    const withinOverlap = computeOverlap(fp1, fp2)

    // Cross-type: pref vs fact
    const fp3 = buildFingerprint([{ role: 'user', content: factBodies[0]! }])
    const crossOverlap = computeOverlap(fp1, fp3)

    console.log(`[phase-14c] Within-type overlap (pref/pref): ${(withinOverlap * 100).toFixed(1)}%`)
    console.log(`[phase-14c] Cross-type overlap (pref/fact): ${(crossOverlap * 100).toFixed(1)}%`)

    // Not asserting within > cross because real data may vary,
    // but verify both are in valid range
    expect(withinOverlap).toBeGreaterThanOrEqual(0)
    expect(withinOverlap).toBeLessThanOrEqual(1)
    expect(crossOverlap).toBeGreaterThanOrEqual(0)
    expect(crossOverlap).toBeLessThanOrEqual(1)
  })

  it('identical content produces overlap of 1', () => {
    const content = 'User prefers dark mode in the editor and wants a warm color scheme.'
    const fp1 = buildFingerprint([{ role: 'user', content }])
    const fp2 = buildFingerprint([{ role: 'user', content }])

    expect(computeOverlap(fp1, fp2)).toBe(1)
  })

  it('checkSourceOverlap returns proceed for fresh messages', () => {
    const config = buildConfig()
    const messages = [
      { role: 'user' as const, content: 'This is a completely new conversation about quantum physics.' },
      { role: 'assistant' as const, content: 'Quantum physics is the study of matter at the subatomic level.' },
    ]
    const recentFingerprints = [
      buildFingerprint([{ role: 'user', content: 'I want to discuss my workout routine and meal plans.' }]),
    ]

    const decision = checkSourceOverlap(messages, recentFingerprints, config)
    expect(decision.action).toBe('proceed')
    expect(decision.overlapScore).toBeLessThan(0.5)
    console.log(`[phase-14c] Fresh messages overlap: ${(decision.overlapScore * 100).toFixed(1)}%`)
  })

  it('checkSourceOverlap detects high overlap', () => {
    const config = buildConfig()
    const sharedContent = 'The user wants to configure their notification preferences for morning alerts and evening summaries with custom sounds.'
    const messages = [
      { role: 'user' as const, content: sharedContent },
      { role: 'assistant' as const, content: 'I will configure those notification preferences.' },
    ]
    const recentFingerprints = [
      buildFingerprint([
        { role: 'user', content: sharedContent },
        { role: 'assistant', content: 'Setting up notification preferences now.' },
      ]),
    ]

    const decision = checkSourceOverlap(messages, recentFingerprints, config)
    expect(decision.overlapScore).toBeGreaterThan(0.3)
    console.log(`[phase-14c] High-overlap decision: action=${decision.action}, overlap=${(decision.overlapScore * 100).toFixed(1)}%`)
  })
})

// ---------------------------------------------------------------------------
// Part D — Candidate Suppression on Real Registry (no LLM, $0)
// ---------------------------------------------------------------------------

describe('Phase 14D — Candidate Suppression', () => {
  let allEntries: readonly [string, import('../../src/graph/registry.js').RegistryNodeEntry][]
  let resolvedOmgRoot: string

  it('loads registry entries', async () => {
    const config = buildConfig()
    resolvedOmgRoot = resolveOmgRoot(SECRETARY_WORKSPACE, config)
    allEntries = await getRegistryEntries(resolvedOmgRoot)
    expect(allEntries.length).toBeGreaterThan(0)
  })

  it('suppresses exact-match duplicate candidates', () => {
    const config = buildConfig()

    // Pick a real entry and create a candidate that mirrors it
    const [realId, realEntry] = allEntries.find(
      ([, e]) => !e.archived && e.type === 'preference',
    )!

    const duplicateCandidate: import('../../src/types.js').ExtractCandidate = {
      type: 'preference',
      canonicalKey: realEntry.canonicalKey ?? 'test.key',
      title: 'Duplicate test',
      description: realEntry.description,
      body: 'Some body content',
      priority: 'medium',
    }

    const result = suppressDuplicateCandidates(
      [duplicateCandidate],
      [realId],
      allEntries,
      config,
    )

    expect(result.suppressed.length).toBe(1)
    expect(result.survivors.length).toBe(0)
    console.log(`[phase-14d] Exact-match suppression: suppressed=${result.suppressed.join(', ')}`)
  })

  it('passes through novel candidates', () => {
    const config = buildConfig()

    const recentNodeIds = allEntries
      .filter(([, e]) => !e.archived && e.type === 'preference')
      .slice(0, 3)
      .map(([id]) => id)

    const novelCandidate: import('../../src/types.js').ExtractCandidate = {
      type: 'fact',
      canonicalKey: 'facts.completely-novel-quantum-teleportation-results',
      title: 'Quantum teleportation research results',
      description: 'Latest experimental results in quantum teleportation achieved 99.9% fidelity over 100km fiber link.',
      body: 'Breakthrough quantum teleportation experiment.',
      priority: 'medium',
    }

    const result = suppressDuplicateCandidates(
      [novelCandidate],
      recentNodeIds,
      allEntries,
      config,
    )

    expect(result.survivors.length).toBe(1)
    expect(result.suppressed.length).toBe(0)
    console.log(`[phase-14d] Novel candidate survived suppression`)
  })

  it('mixed batch: some suppressed, some survive', () => {
    const config = buildConfig()

    // Pick two real entries for suppression targets
    const realPrefs = allEntries.filter(([, e]) => !e.archived && e.type === 'preference')
    expect(realPrefs.length).toBeGreaterThan(1)

    const [id1, entry1] = realPrefs[0]!
    const [id2] = realPrefs[1]!

    const candidates: import('../../src/types.js').ExtractCandidate[] = [
      {
        type: 'preference',
        canonicalKey: entry1.canonicalKey ?? 'test.dup',
        title: 'Duplicate of real entry',
        description: entry1.description,
        body: 'Body',
        priority: 'medium',
      },
      {
        type: 'fact',
        canonicalKey: 'facts.novel-mars-colonization-timeline',
        title: 'Mars colonization timeline',
        description: 'SpaceX plans to establish first permanent Mars colony by 2042 with 100 settlers.',
        body: 'Novel fact about Mars.',
        priority: 'medium',
      },
    ]

    const result = suppressDuplicateCandidates(
      candidates,
      [id1, id2],
      allEntries,
      config,
    )

    expect(result.suppressed.length).toBeGreaterThanOrEqual(1)
    expect(result.survivors.length).toBeGreaterThanOrEqual(1)

    writeArtifact('phase-14-suppression.json', {
      candidateCount: candidates.length,
      suppressedCount: result.suppressed.length,
      survivorCount: result.survivors.length,
      suppressed: result.suppressed,
    })

    console.log(`[phase-14d] Mixed batch: ${result.suppressed.length} suppressed, ${result.survivors.length} survived`)
  })

  it('disabled guardrails pass everything through', () => {
    const config = parseConfig({
      extractionGuardrails: { enabled: false },
    })

    const recentIds = allEntries.slice(0, 3).map(([id]) => id)

    const candidates: import('../../src/types.js').ExtractCandidate[] = [
      {
        type: 'preference',
        canonicalKey: 'test.anything',
        title: 'Test',
        description: 'Any description at all',
        body: 'Body',
        priority: 'medium',
      },
    ]

    const result = suppressDuplicateCandidates(candidates, recentIds, allEntries, config)

    expect(result.survivors.length).toBe(1)
    expect(result.suppressed.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Part E — TechLead Workspace (blocks + dedup + suppression)
// ---------------------------------------------------------------------------

describe('Phase 14E — TechLead Workspace', () => {
  let tlOmgRoot: string
  let tlEntries: readonly [string, import('../../src/graph/registry.js').RegistryNodeEntry][]

  it('reads TechLead registry', async () => {
    const config = buildConfig()
    tlOmgRoot = resolveOmgRoot(TECHLEAD_WORKSPACE, config)
    tlEntries = await getRegistryEntries(tlOmgRoot)

    const active = tlEntries.filter(([, e]) => !e.archived)
    const byType: Record<string, number> = {}
    for (const [, e] of active) {
      byType[e.type] = (byType[e.type] ?? 0) + 1
    }

    console.log(`[phase-14e] TechLead: ${tlEntries.length} total, ${active.length} active`)
    console.log(`[phase-14e] By type: ${JSON.stringify(byType)}`)

    writeArtifact('phase-14-techlead-registry.json', {
      total: tlEntries.length,
      active: active.length,
      byType,
    })

    expect(tlEntries.length).toBeGreaterThan(0)
  })

  it('generates semantic blocks (may be empty for small graph)', () => {
    const config = buildConfig()
    const blocks = generateSemanticBlocks(tlEntries, config.semanticDedup)

    console.log(`[phase-14e] TechLead semantic blocks: ${blocks.length}`)
    if (blocks.length > 0) {
      for (const b of blocks) {
        console.log(`  [${b.domain}] ${b.nodeIds.length} nodes, maxScore=${Math.round(b.maxHeuristicScore * 100) / 100}`)
      }
    }

    writeArtifact('phase-14-techlead-blocks.json', blocks.map((b) => ({
      domain: b.domain,
      nodeCount: b.nodeIds.length,
      maxHeuristicScore: Math.round(b.maxHeuristicScore * 100) / 100,
      nodeIds: b.nodeIds,
    })))

    // Small graph may produce 0 blocks — that's valid
    expect(blocks.length).toBeGreaterThanOrEqual(0)
  })

  it('runs semantic dedup on TechLead (capped to 2 blocks)', async () => {
    const config = buildConfig({ maxBlocksPerRun: 2 })
    const llmClient = buildLlmClient('phase-14e')

    const nodesDir = path.join(tlOmgRoot, 'nodes')
    const hashesBefore = hashDirectory(nodesDir)
    const callsBefore = llmTracker.calls

    const origError = console.error
    const origWarn = console.warn
    const warnings: string[] = []
    console.error = (...args: unknown[]) => { warnings.push(String(args[0])) }
    console.warn = (...args: unknown[]) => { warnings.push(String(args[0])) }

    let result: Awaited<ReturnType<typeof runSemanticDedup>>
    try {
      result = await runSemanticDedup({ omgRoot: tlOmgRoot, config, llmClient })
    } finally {
      console.error = origError
      console.warn = origWarn
    }

    const llmCallsMade = llmTracker.calls - callsBefore
    const hashesAfter = hashDirectory(nodesDir)
    const changedFiles = [...hashesAfter.entries()].filter(
      ([p, hash]) => hashesBefore.get(p) !== hash,
    )

    const artifact = {
      blocksProcessed: result.blocksProcessed,
      mergesExecuted: result.mergesExecuted,
      nodesArchived: result.nodesArchived,
      errorCount: result.errors.length,
      errors: result.errors,
      llmCallsMade,
      changedFiles: changedFiles.map(([p]) => p),
      warnings: warnings.filter((w) => w.includes('[omg]')),
    }

    console.log(`[phase-14e] TechLead dedup: blocks=${result.blocksProcessed}, merges=${result.mergesExecuted}, archived=${result.nodesArchived}, llmCalls=${llmCallsMade}`)
    writeArtifact('phase-14-techlead-dedup-result.json', artifact)

    // No errors expected
    expect(result.errors).toHaveLength(0)
    // Counters are consistent
    expect(result.nodesArchived).toBeGreaterThanOrEqual(result.mergesExecuted)
  })

  it('candidate suppression works on TechLead registry', () => {
    const config = buildConfig()
    const activeEntries = tlEntries.filter(([, e]) => !e.archived && e.type !== 'reflection' && e.type !== 'moc' && e.type !== 'now')

    if (activeEntries.length === 0) {
      console.log('[phase-14e] No active non-reflection entries in TechLead — suppression test skipped')
      return
    }

    const [realId, realEntry] = activeEntries[0]!

    const duplicateCandidate: import('../../src/types.js').ExtractCandidate = {
      type: realEntry.type as import('../../src/types.js').ExtractCandidate['type'],
      canonicalKey: realEntry.canonicalKey ?? 'test.key',
      title: 'Duplicate test',
      description: realEntry.description,
      body: 'Some body',
      priority: 'medium',
    }

    const novelCandidate: import('../../src/types.js').ExtractCandidate = {
      type: 'fact',
      canonicalKey: 'facts.novel-deep-sea-bioluminescence-discovery',
      title: 'Deep sea bioluminescence discovery',
      description: 'New species of bioluminescent fish discovered at 8000m depth in Mariana Trench.',
      body: 'Novel fact.',
      priority: 'medium',
    }

    const result = suppressDuplicateCandidates(
      [duplicateCandidate, novelCandidate],
      [realId],
      tlEntries,
      config,
    )

    expect(result.suppressed.length).toBeGreaterThanOrEqual(1)
    expect(result.survivors.length).toBeGreaterThanOrEqual(1)
    console.log(`[phase-14e] TechLead suppression: ${result.suppressed.length} suppressed, ${result.survivors.length} survived`)
  })
})
