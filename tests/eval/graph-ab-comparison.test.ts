/**
 * Graph A/B Comparison Eval
 *
 * Runs the 50-prompt eval suite twice:
 *   A) graph.enabled = false  (baseline — keyword + recency only)
 *   B) graph.enabled = true   (post-repair — adjacency expansion)
 *
 * Outputs per-prompt deltas and aggregate summary.
 *
 * Usage: pnpm test --project eval
 */

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import { parseConfig } from '../../src/config.js'
import { selectContextV2 } from '../../src/context/selector.js'
import { getRegistryEntries } from '../../src/graph/registry.js'
import { readGraphNode } from '../../src/graph/node-reader.js'
import { resolveOmgRoot } from '../../src/utils/paths.js'
import { clearGraphCache } from '../../src/graph/traversal.js'
import type { Message, GraphContextSlice } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = '/Users/szymonpaluch/Projects/Personal/Secretary'

const configA = parseConfig({
  injection: { graph: { enabled: false } },
})

const configB = parseConfig({
  injection: {
    graph: {
      enabled: true,
      expansionTopK: 10,
      maxDepth: 2,
      neighborWeight: 0.5,
    },
  },
})

const omgRoot = resolveOmgRoot(WORKSPACE_DIR, configA)

// ---------------------------------------------------------------------------
// 50 diverse user prompts
// ---------------------------------------------------------------------------

const TEST_PROMPTS: readonly { id: number; prompt: string; expectedDomains: readonly string[] }[] = [
  { id: 1, prompt: 'Powiedz mi o żona', expectedDomains: ['identity', 'relationship'] },
  { id: 2, prompt: 'Co wiem o mama', expectedDomains: ['identity', 'family'] },
  { id: 3, prompt: 'Jak ma na imię mój syn?', expectedDomains: ['identity', 'family'] },
  { id: 4, prompt: 'Kiedy mam urodziny?', expectedDomains: ['identity'] },
  { id: 5, prompt: 'Opowiedz mi o naszej rodzinie', expectedDomains: ['identity', 'family'] },
  { id: 6, prompt: 'Tell me about Sylwia', expectedDomains: ['identity', 'relationship'] },
  { id: 7, prompt: 'What do you know about Kira?', expectedDomains: ['identity', 'relationship'] },
  { id: 8, prompt: 'What are my hobbies?', expectedDomains: ['identity', 'preference'] },
  { id: 9, prompt: 'wife relationship context', expectedDomains: ['identity', 'relationship'] },
  { id: 10, prompt: 'What music do I like?', expectedDomains: ['identity', 'preference'] },
  { id: 11, prompt: 'Jak działa routing na Discordzie?', expectedDomains: ['decision', 'project'] },
  { id: 12, prompt: 'Pokaż strukturę kanałów Discord', expectedDomains: ['decision', 'project'] },
  { id: 13, prompt: 'Which Discord channel is for dev topics?', expectedDomains: ['decision', 'fact'] },
  { id: 14, prompt: 'Wyślij wiadomość na kanał hq', expectedDomains: ['decision', 'project'] },
  { id: 15, prompt: 'Discord permission setup for pati-kira channel', expectedDomains: ['decision', 'preference'] },
  { id: 16, prompt: 'TypeScript tsconfig configuration', expectedDomains: ['project', 'fact'] },
  { id: 17, prompt: 'Jaki jest status CI na Anmarze?', expectedDomains: ['project', 'fact'] },
  { id: 18, prompt: 'DataPilot architecture decision', expectedDomains: ['project', 'decision'] },
  { id: 19, prompt: 'How does the media pipeline work?', expectedDomains: ['decision', 'fact'] },
  { id: 20, prompt: 'RunPod setup for image generation', expectedDomains: ['fact', 'project'] },
  { id: 21, prompt: 'Rolety na parterze nie działają', expectedDomains: ['fact', 'episode'] },
  { id: 22, prompt: 'Home Assistant diagnostics', expectedDomains: ['fact', 'project'] },
  { id: 23, prompt: 'Status rolet w domu', expectedDomains: ['fact'] },
  { id: 24, prompt: 'Jakie mam zaległe taski?', expectedDomains: ['project', 'fact'] },
  { id: 25, prompt: 'Dodaj do kalendarza spotkanie jutro o 10', expectedDomains: ['preference', 'fact'] },
  { id: 26, prompt: 'Co mam w planie na dziś?', expectedDomains: ['fact', 'project'] },
  { id: 27, prompt: 'Overdue GitHub issues', expectedDomains: ['project', 'fact'] },
  { id: 28, prompt: 'Zrób listę zakupów', expectedDomains: ['preference', 'fact'] },
  { id: 29, prompt: 'Wygeneruj mi zdjęcie', expectedDomains: ['decision', 'preference'] },
  { id: 30, prompt: 'Photo generation workflow', expectedDomains: ['decision', 'fact'] },
  { id: 31, prompt: 'Jak wysyłać media przez message tool?', expectedDomains: ['fact', 'decision'] },
  { id: 32, prompt: 'Generate a couple photo of us', expectedDomains: ['decision', 'preference'] },
  { id: 33, prompt: 'LoRA training status', expectedDomains: ['project', 'fact'] },
  { id: 34, prompt: 'Jak działa OMG context injection?', expectedDomains: ['fact', 'reflection'] },
  { id: 35, prompt: 'Show me the memory graph stats', expectedDomains: ['fact', 'reflection'] },
  { id: 36, prompt: 'What nodes does OMG have?', expectedDomains: ['fact', 'reflection'] },
  { id: 37, prompt: 'OMG dedup quality', expectedDomains: ['reflection', 'fact'] },
  { id: 38, prompt: 'Jakie mam preferencje komunikacyjne?', expectedDomains: ['preference'] },
  { id: 39, prompt: 'Jak wolę dostawać alerty?', expectedDomains: ['preference', 'decision'] },
  { id: 40, prompt: 'Communication style preferences', expectedDomains: ['preference'] },
  { id: 41, prompt: 'Compact vs verbose response preference', expectedDomains: ['preference'] },
  { id: 42, prompt: 'Które crony nie działają?', expectedDomains: ['fact', 'project'] },
  { id: 43, prompt: 'Morning cron status', expectedDomains: ['fact', 'project'] },
  { id: 44, prompt: 'Weekly retro delivery issue', expectedDomains: ['fact', 'decision'] },
  { id: 45, prompt: 'Heartbeat configuration', expectedDomains: ['fact', 'decision'] },
  { id: 46, prompt: 'Hej', expectedDomains: [] },
  { id: 47, prompt: 'Siema, co tam?', expectedDomains: [] },
  { id: 48, prompt: 'ok', expectedDomains: [] },
  { id: 49, prompt: 'Dzięki!', expectedDomains: [] },
  { id: 50, prompt: 'Opowiedz mi o sobie', expectedDomains: ['identity'] },
]

// ---------------------------------------------------------------------------
// Evaluation logic
// ---------------------------------------------------------------------------

type Score = 'GOOD' | 'OK' | 'POOR' | 'EMPTY'

interface RunResult {
  readonly nodeCount: number
  readonly mocCount: number
  readonly estimatedTokens: number
  readonly nodeIds: readonly string[]
  readonly nodeTypes: readonly string[]
  readonly nodeDescriptions: readonly string[]
  readonly score: Score
  readonly issues: readonly string[]
}

function assessQuality(
  result: GraphContextSlice,
  expected: readonly string[],
  prompt: string,
): { issues: readonly string[]; score: Score } {
  const issues: string[] = []
  const nodeTypes = result.nodes.map(n => n.frontmatter.type)

  if (result.nodes.length === 0 && prompt.length > 5 && expected.length > 0) {
    issues.push('NO_NODES')
  }

  if (expected.length > 0) {
    const foundTypes = new Set(nodeTypes)
    const allNodeText = result.nodes
      .map(n => `${n.frontmatter.id} ${n.frontmatter.description} ${n.frontmatter.tags?.join(' ') ?? ''}`)
      .join(' ')
      .toLowerCase()

    for (const domain of expected) {
      const domainLower = domain.toLowerCase()
      if (!foundTypes.has(domainLower) && !allNodeText.includes(domainLower)) {
        issues.push(`MISSING:${domain}`)
      }
    }
  }

  if (result.estimatedTokens > 5000) {
    issues.push('TOKEN_BLOAT')
  }

  const now = Date.now()
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  const staleNodes = result.nodes.filter(n => (now - new Date(n.frontmatter.updated).getTime()) > thirtyDaysMs)
  if (staleNodes.length > result.nodes.length / 2 && result.nodes.length > 2) {
    issues.push('STALE')
  }

  if (prompt.length <= 5 && result.nodes.length > 2) {
    issues.push('OVER_INJECTION')
  }

  const score: Score = (result.nodes.length === 0 && expected.length > 0)
    ? 'EMPTY'
    : issues.some(i => i === 'NO_NODES' || i === 'TOKEN_BLOAT')
      ? 'POOR'
      : issues.length > 1 ? 'OK' : 'GOOD'

  return { issues, score }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Graph A/B Comparison (Secretary)', () => {
  it('compares graph-enabled vs graph-disabled context quality on 50 prompts', async () => {
    // Load shared data
    const registryEntries = await getRegistryEntries(omgRoot, { archived: false })
    const indexContent = await fs.readFile(path.join(omgRoot, 'index.md'), 'utf-8').catch(() => '')
    const nowContent = await fs.readFile(path.join(omgRoot, 'now.md'), 'utf-8').catch(() => null)

    // Link structure stats
    let totalLinks = 0
    let bidirectionalPairs = 0
    const linkMap = new Map<string, Set<string>>()
    for (const [id, entry] of registryEntries) {
      const links = entry.links ?? []
      linkMap.set(id, new Set(links))
      totalLinks += links.length
    }
    for (const [id, links] of linkMap) {
      for (const targetId of links) {
        if (linkMap.get(targetId)?.has(id)) bidirectionalPairs++
      }
    }
    bidirectionalPairs = Math.floor(bidirectionalPairs / 2)

    console.log('\n╔══════════════════════════════════════════════════════════════════╗')
    console.log('║  OMG Context Quality — Graph A/B Comparison                     ║')
    console.log('╚══════════════════════════════════════════════════════════════════╝')
    console.log(`\nWorkspace: ${WORKSPACE_DIR}`)
    console.log(`Registry:  ${registryEntries.length} active nodes`)
    console.log(`Links:     ${totalLinks} total, ${bidirectionalPairs} bidirectional pairs`)

    // --- Run A: No graph ---
    clearGraphCache()
    const resultsA: RunResult[] = []
    for (const test of TEST_PROMPTS) {
      const recentMessages: readonly Message[] = [{ role: 'user', content: test.prompt }]
      const slice = await selectContextV2({
        indexContent, nowContent, registryEntries, recentMessages,
        config: configA, hydrateNode: readGraphNode, memoryTools: null,
      })
      const { issues, score } = assessQuality(slice, test.expectedDomains, test.prompt)
      resultsA.push({
        nodeCount: slice.nodes.length, mocCount: slice.mocs.length,
        estimatedTokens: slice.estimatedTokens,
        nodeIds: slice.nodes.map(n => n.frontmatter.id),
        nodeTypes: slice.nodes.map(n => n.frontmatter.type),
        nodeDescriptions: slice.nodes.map(n => n.frontmatter.description),
        score, issues,
      })
    }

    // --- Run B: With graph ---
    clearGraphCache()
    const resultsB: RunResult[] = []
    for (const test of TEST_PROMPTS) {
      const recentMessages: readonly Message[] = [{ role: 'user', content: test.prompt }]
      const slice = await selectContextV2({
        indexContent, nowContent, registryEntries, recentMessages,
        config: configB, hydrateNode: readGraphNode, memoryTools: null,
        omgRoot,
      })
      const { issues, score } = assessQuality(slice, test.expectedDomains, test.prompt)
      resultsB.push({
        nodeCount: slice.nodes.length, mocCount: slice.mocs.length,
        estimatedTokens: slice.estimatedTokens,
        nodeIds: slice.nodes.map(n => n.frontmatter.id),
        nodeTypes: slice.nodes.map(n => n.frontmatter.type),
        nodeDescriptions: slice.nodes.map(n => n.frontmatter.description),
        score, issues,
      })
    }

    // --- Comparison ---
    const scoreOrder: Record<Score, number> = { GOOD: 3, OK: 2, POOR: 1, EMPTY: 0 }
    let improved = 0
    let regressed = 0
    let unchanged = 0
    let totalNewNodes = 0

    const scoresA: Record<Score, number> = { GOOD: 0, OK: 0, POOR: 0, EMPTY: 0 }
    const scoresB: Record<Score, number> = { GOOD: 0, OK: 0, POOR: 0, EMPTY: 0 }

    console.log('\n  #  | Prompt                                 |  A→B score  |  A nodes→B | A tok→B tok | New IDs in B')
    console.log('─'.repeat(140))

    for (let i = 0; i < TEST_PROMPTS.length; i++) {
      const test = TEST_PROMPTS[i]
      const a = resultsA[i]
      const b = resultsB[i]

      scoresA[a.score]++
      scoresB[b.score]++

      const idsA = new Set(a.nodeIds)
      const newIds = b.nodeIds.filter(id => !idsA.has(id))
      totalNewNodes += newIds.length

      const scoreDelta = scoreOrder[b.score] - scoreOrder[a.score]
      if (scoreDelta > 0) improved++
      else if (scoreDelta < 0) regressed++
      else unchanged++

      const arrow = scoreDelta > 0 ? '+' : scoreDelta < 0 ? '-' : ' '
      const promptTrunc = test.prompt.length > 38 ? test.prompt.slice(0, 35) + '...' : test.prompt
      const newIdStr = newIds.length > 0
        ? newIds.slice(0, 2).join(', ') + (newIds.length > 2 ? ` +${newIds.length - 2}` : '')
        : '-'

      console.log(
        ` ${String(test.id).padStart(2)} | ${promptTrunc.padEnd(39)}| ${a.score.padEnd(5)}→${b.score.padEnd(5)} ${arrow} | ` +
        `${String(a.nodeCount).padStart(2)}→${String(b.nodeCount).padStart(2)}     | ` +
        `${String(a.estimatedTokens).padStart(4)}→${String(b.estimatedTokens).padStart(4)}    | ${newIdStr}`
      )
    }

    // Summary
    const avgTokensA = Math.round(resultsA.reduce((s, r) => s + r.estimatedTokens, 0) / resultsA.length)
    const avgTokensB = Math.round(resultsB.reduce((s, r) => s + r.estimatedTokens, 0) / resultsB.length)
    const avgNodesA = (resultsA.reduce((s, r) => s + r.nodeCount, 0) / resultsA.length).toFixed(1)
    const avgNodesB = (resultsB.reduce((s, r) => s + r.nodeCount, 0) / resultsB.length).toFixed(1)

    console.log('\n╔══════════════════════════════════════════════════════════════╗')
    console.log('║                   AGGREGATE RESULTS                         ║')
    console.log('╠══════════════════════════════════════════════════════════════╣')
    console.log(`║  Metric          │ A (no graph) │ B (graph)                 ║`)
    console.log('╠══════════════════════════════════════════════════════════════╣')
    console.log(`║  GOOD            │  ${String(scoresA.GOOD).padStart(6)}       │ ${String(scoresB.GOOD).padStart(6)}                    ║`)
    console.log(`║  OK              │  ${String(scoresA.OK).padStart(6)}       │ ${String(scoresB.OK).padStart(6)}                    ║`)
    console.log(`║  POOR            │  ${String(scoresA.POOR).padStart(6)}       │ ${String(scoresB.POOR).padStart(6)}                    ║`)
    console.log(`║  EMPTY           │  ${String(scoresA.EMPTY).padStart(6)}       │ ${String(scoresB.EMPTY).padStart(6)}                    ║`)
    console.log('╠══════════════════════════════════════════════════════════════╣')
    console.log(`║  Avg tokens/prompt: A=${avgTokensA}  B=${avgTokensB}  (delta: ${avgTokensB - avgTokensA > 0 ? '+' : ''}${avgTokensB - avgTokensA})`)
    console.log(`║  Avg nodes/prompt:  A=${avgNodesA}  B=${avgNodesB}`)
    console.log(`║  Improved: ${improved} | Regressed: ${regressed} | Unchanged: ${unchanged}`)
    console.log(`║  New nodes via graph expansion: ${totalNewNodes}`)
    console.log('╚══════════════════════════════════════════════════════════════╝')

    // Domain coverage
    console.log('\n=== DOMAIN COVERAGE (A vs B) ===')
    const domainsA: Record<string, { hit: number; total: number }> = {}
    const domainsB: Record<string, { hit: number; total: number }> = {}

    for (let i = 0; i < TEST_PROMPTS.length; i++) {
      for (const domain of TEST_PROMPTS[i].expectedDomains) {
        if (!domainsA[domain]) domainsA[domain] = { hit: 0, total: 0 }
        if (!domainsB[domain]) domainsB[domain] = { hit: 0, total: 0 }
        domainsA[domain].total++
        domainsB[domain].total++
        if (!resultsA[i].issues.some(iss => iss === `MISSING:${domain}`)) domainsA[domain].hit++
        if (!resultsB[i].issues.some(iss => iss === `MISSING:${domain}`)) domainsB[domain].hit++
      }
    }

    const allDomains = [...new Set([...Object.keys(domainsA), ...Object.keys(domainsB)])].sort()
    for (const domain of allDomains) {
      const a = domainsA[domain] ?? { hit: 0, total: 0 }
      const b = domainsB[domain] ?? { hit: 0, total: 0 }
      const pctA = a.total > 0 ? Math.round(a.hit / a.total * 100) : 0
      const pctB = b.total > 0 ? Math.round(b.hit / b.total * 100) : 0
      const delta = pctB - pctA
      const deltaStr = delta > 0 ? `+${delta}%` : delta < 0 ? `${delta}%` : '  0%'
      console.log(`  ${domain.padEnd(15)} A: ${a.hit}/${a.total} (${String(pctA).padStart(3)}%)  B: ${b.hit}/${b.total} (${String(pctB).padStart(3)}%)  delta: ${deltaStr}`)
    }

    // Notable improvements
    console.log('\n=== NOTABLE IMPROVEMENTS (A→B) ===')
    let hasImprovements = false
    for (let i = 0; i < TEST_PROMPTS.length; i++) {
      const a = resultsA[i]
      const b = resultsB[i]
      const scoreDelta = scoreOrder[b.score] - scoreOrder[a.score]
      if (scoreDelta > 0) {
        hasImprovements = true
        const idsA = new Set(a.nodeIds)
        const newIds = b.nodeIds.filter(id => !idsA.has(id))
        console.log(`  #${TEST_PROMPTS[i].id} "${TEST_PROMPTS[i].prompt}"`)
        console.log(`    ${a.score} -> ${b.score}  |  nodes: ${a.nodeCount} -> ${b.nodeCount}  |  new: [${newIds.join(', ')}]`)
        const newDescs = b.nodeDescriptions.filter((_, idx) => newIds.includes(b.nodeIds[idx]))
        for (const d of newDescs.slice(0, 3)) {
          console.log(`      + "${d}"`)
        }
      }
    }
    if (!hasImprovements) console.log('  No score improvements (graph expansion may still add useful nodes)')

    // Regressions
    console.log('\n=== REGRESSIONS (B worse than A) ===')
    let hasRegressions = false
    for (let i = 0; i < TEST_PROMPTS.length; i++) {
      const a = resultsA[i]
      const b = resultsB[i]
      if (scoreOrder[b.score] < scoreOrder[a.score]) {
        hasRegressions = true
        console.log(`  #${TEST_PROMPTS[i].id} "${TEST_PROMPTS[i].prompt}"  ${a.score} -> ${b.score}`)
        console.log(`    A issues: [${a.issues.join(', ')}]`)
        console.log(`    B issues: [${b.issues.join(', ')}]`)
      }
    }
    if (!hasRegressions) console.log('  None! Graph expansion caused no regressions.')

    // Write JSON results
    const outputPath = path.join(omgRoot, '..', '..', 'graph-ab-results.json')
    await fs.writeFile(outputPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      workspace: WORKSPACE_DIR,
      registrySize: registryEntries.length,
      totalLinks,
      bidirectionalPairs,
      summary: { scoresA, scoresB, improved, regressed, unchanged, totalNewNodes, avgTokensA, avgTokensB },
      prompts: TEST_PROMPTS.map((test, i) => ({
        id: test.id, prompt: test.prompt, expectedDomains: test.expectedDomains,
        a: { score: resultsA[i].score, nodeCount: resultsA[i].nodeCount, tokens: resultsA[i].estimatedTokens, nodeIds: resultsA[i].nodeIds },
        b: { score: resultsB[i].score, nodeCount: resultsB[i].nodeCount, tokens: resultsB[i].estimatedTokens, nodeIds: resultsB[i].nodeIds },
      })),
    }, null, 2))
    console.log(`\nDetailed results: ${outputPath}`)

    // Assertions
    // Graph should produce new context via expansion
    expect(totalNewNodes).toBeGreaterThan(0)
    // Net improvement: more prompts improved than regressed
    expect(improved).toBeGreaterThanOrEqual(regressed)
    // No regressions to POOR or EMPTY (GOOD→OK is acceptable)
    const severeRegressions = TEST_PROMPTS.filter((_, i) => {
      const a = resultsA[i].score
      const b = resultsB[i].score
      return (a === 'GOOD' || a === 'OK') && (b === 'POOR' || b === 'EMPTY')
    })
    expect(severeRegressions).toHaveLength(0)
    // Score distribution should be at least as good overall
    expect(scoresB.GOOD + scoresB.OK).toBeGreaterThanOrEqual(scoresA.GOOD + scoresA.OK)
  })
})
