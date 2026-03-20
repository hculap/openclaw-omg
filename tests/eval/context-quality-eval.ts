/**
 * Context Quality Evaluation Script
 *
 * Extracts 50 diverse user prompts (Polish + English, different domains),
 * runs each through the OMG context selector (selectContextV2), and
 * outputs the context block with a quality assessment.
 *
 * Usage: pnpm tsx tests/eval/context-quality-eval.ts
 */

import path from 'node:path'
import fs from 'node:fs/promises'
import { parseConfig } from '../../src/config.js'
import { selectContextV2 } from '../../src/context/selector.js'
import { renderContextBlock } from '../../src/context/renderer.js'
import { getRegistryEntries } from '../../src/graph/registry.js'
import { readGraphNode } from '../../src/graph/node-reader.js'
import { resolveOmgRoot } from '../../src/utils/paths.js'
import type { Message } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = '/Users/szymonpaluch/Projects/Personal/Secretary'
const config = parseConfig({})
const omgRoot = resolveOmgRoot(WORKSPACE_DIR, config)

// ---------------------------------------------------------------------------
// 50 diverse user prompts — based on real conversation patterns
// ---------------------------------------------------------------------------

const TEST_PROMPTS: readonly { id: number; prompt: string; expectedDomains: readonly string[] }[] = [
  // --- Polish personal / family ---
  { id: 1, prompt: 'Powiedz mi o żona', expectedDomains: ['identity', 'relationship'] },
  { id: 2, prompt: 'Co wiem o mama', expectedDomains: ['identity', 'family'] },
  { id: 3, prompt: 'Jak ma na imię mój syn?', expectedDomains: ['identity', 'family'] },
  { id: 4, prompt: 'Kiedy mam urodziny?', expectedDomains: ['identity'] },
  { id: 5, prompt: 'Opowiedz mi o naszej rodzinie', expectedDomains: ['identity', 'family'] },

  // --- English personal ---
  { id: 6, prompt: 'Tell me about Sylwia', expectedDomains: ['identity', 'relationship'] },
  { id: 7, prompt: 'What do you know about Kira?', expectedDomains: ['identity', 'relationship'] },
  { id: 8, prompt: 'What are my hobbies?', expectedDomains: ['identity', 'preference'] },
  { id: 9, prompt: 'wife relationship context', expectedDomains: ['identity', 'relationship'] },
  { id: 10, prompt: 'What music do I like?', expectedDomains: ['identity', 'preference'] },

  // --- Discord / communication ---
  { id: 11, prompt: 'Jak działa routing na Discordzie?', expectedDomains: ['decision', 'project'] },
  { id: 12, prompt: 'Pokaż strukturę kanałów Discord', expectedDomains: ['decision', 'project'] },
  { id: 13, prompt: 'Which Discord channel is for dev topics?', expectedDomains: ['decision', 'fact'] },
  { id: 14, prompt: 'Wyślij wiadomość na kanał hq', expectedDomains: ['decision', 'project'] },
  { id: 15, prompt: 'Discord permission setup for pati-kira channel', expectedDomains: ['decision', 'preference'] },

  // --- Technical / coding ---
  { id: 16, prompt: 'TypeScript tsconfig configuration', expectedDomains: ['project', 'fact'] },
  { id: 17, prompt: 'Jaki jest status CI na Anmarze?', expectedDomains: ['project', 'fact'] },
  { id: 18, prompt: 'DataPilot architecture decision', expectedDomains: ['project', 'decision'] },
  { id: 19, prompt: 'How does the media pipeline work?', expectedDomains: ['decision', 'fact'] },
  { id: 20, prompt: 'RunPod setup for image generation', expectedDomains: ['fact', 'project'] },

  // --- Home automation ---
  { id: 21, prompt: 'Rolety na parterze nie działają', expectedDomains: ['fact', 'episode'] },
  { id: 22, prompt: 'Home Assistant diagnostics', expectedDomains: ['fact', 'project'] },
  { id: 23, prompt: 'Status rolet w domu', expectedDomains: ['fact'] },

  // --- Tasks / calendar ---
  { id: 24, prompt: 'Jakie mam zaległe taski?', expectedDomains: ['project', 'fact'] },
  { id: 25, prompt: 'Dodaj do kalendarza spotkanie jutro o 10', expectedDomains: ['preference', 'fact'] },
  { id: 26, prompt: 'Co mam w planie na dziś?', expectedDomains: ['fact', 'project'] },
  { id: 27, prompt: 'Overdue GitHub issues', expectedDomains: ['project', 'fact'] },
  { id: 28, prompt: 'Zrób listę zakupów', expectedDomains: ['preference', 'fact'] },

  // --- Photo / media generation ---
  { id: 29, prompt: 'Wygeneruj mi zdjęcie', expectedDomains: ['decision', 'preference'] },
  { id: 30, prompt: 'Photo generation workflow', expectedDomains: ['decision', 'fact'] },
  { id: 31, prompt: 'Jak wysyłać media przez message tool?', expectedDomains: ['fact', 'decision'] },
  { id: 32, prompt: 'Generate a couple photo of us', expectedDomains: ['decision', 'preference'] },
  { id: 33, prompt: 'LoRA training status', expectedDomains: ['project', 'fact'] },

  // --- OMG system / memory ---
  { id: 34, prompt: 'Jak działa OMG context injection?', expectedDomains: ['fact', 'reflection'] },
  { id: 35, prompt: 'Show me the memory graph stats', expectedDomains: ['fact', 'reflection'] },
  { id: 36, prompt: 'What nodes does OMG have?', expectedDomains: ['fact', 'reflection'] },
  { id: 37, prompt: 'OMG dedup quality', expectedDomains: ['reflection', 'fact'] },

  // --- Preferences / workflow ---
  { id: 38, prompt: 'Jakie mam preferencje komunikacyjne?', expectedDomains: ['preference'] },
  { id: 39, prompt: 'Jak wolę dostawać alerty?', expectedDomains: ['preference', 'decision'] },
  { id: 40, prompt: 'Communication style preferences', expectedDomains: ['preference'] },
  { id: 41, prompt: 'Compact vs verbose response preference', expectedDomains: ['preference'] },

  // --- Cron / ops ---
  { id: 42, prompt: 'Które crony nie działają?', expectedDomains: ['fact', 'project'] },
  { id: 43, prompt: 'Morning cron status', expectedDomains: ['fact', 'project'] },
  { id: 44, prompt: 'Weekly retro delivery issue', expectedDomains: ['fact', 'decision'] },
  { id: 45, prompt: 'Heartbeat configuration', expectedDomains: ['fact', 'decision'] },

  // --- Short / ambiguous (stress test) ---
  { id: 46, prompt: 'Hej', expectedDomains: [] },
  { id: 47, prompt: 'Siema, co tam?', expectedDomains: [] },
  { id: 48, prompt: 'ok', expectedDomains: [] },
  { id: 49, prompt: 'Dzięki!', expectedDomains: [] },
  { id: 50, prompt: 'Opowiedz mi o sobie', expectedDomains: ['identity'] },
]

// ---------------------------------------------------------------------------
// Evaluation logic
// ---------------------------------------------------------------------------

interface EvalResult {
  readonly id: number
  readonly prompt: string
  readonly expectedDomains: readonly string[]
  readonly nodeCount: number
  readonly mocCount: number
  readonly estimatedTokens: number
  readonly nodeIds: readonly string[]
  readonly nodeTypes: readonly string[]
  readonly nodeDescriptions: readonly string[]
  readonly hasNow: boolean
  readonly contextBlock: string
  readonly qualityIssues: readonly string[]
  readonly score: 'GOOD' | 'OK' | 'POOR' | 'EMPTY'
}

function assessQuality(
  result: Awaited<ReturnType<typeof selectContextV2>>,
  expected: readonly string[],
  prompt: string,
): { issues: readonly string[]; score: 'GOOD' | 'OK' | 'POOR' | 'EMPTY' } {
  const issues: string[] = []

  const nodeTypes = result.nodes.map(n => n.frontmatter.type)
  const allTypes = [
    ...nodeTypes,
    ...result.mocs.map(n => n.frontmatter.type),
  ]

  // 1. Empty result for non-trivial prompt
  if (result.nodes.length === 0 && prompt.length > 5 && expected.length > 0) {
    issues.push('NO_NODES: Non-trivial prompt returned zero nodes')
  }

  // 2. Expected domain coverage
  if (expected.length > 0) {
    const foundTypes = new Set(nodeTypes)
    const allNodeText = result.nodes
      .map(n => `${n.frontmatter.id} ${n.frontmatter.description} ${n.frontmatter.tags?.join(' ') ?? ''}`)
      .join(' ')
      .toLowerCase()

    for (const domain of expected) {
      const domainLower = domain.toLowerCase()
      const hasTypeMatch = foundTypes.has(domainLower)
      const hasTextMatch = allNodeText.includes(domainLower)
      if (!hasTypeMatch && !hasTextMatch) {
        issues.push(`MISSING_DOMAIN: Expected "${domain}" not found in nodes`)
      }
    }
  }

  // 3. Token budget check
  if (result.estimatedTokens > 5000) {
    issues.push(`TOKEN_BLOAT: ${result.estimatedTokens} tokens exceeds reasonable budget`)
  }

  // 4. Stale content check (nodes older than 30 days)
  const now = Date.now()
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000
  const staleNodes = result.nodes.filter(n => {
    const updated = new Date(n.frontmatter.updated).getTime()
    return (now - updated) > thirtyDaysMs
  })
  if (staleNodes.length > result.nodes.length / 2 && result.nodes.length > 2) {
    issues.push(`STALE: ${staleNodes.length}/${result.nodes.length} nodes are older than 30 days`)
  }

  // 5. Duplicate type saturation (e.g. all reflections, no variety)
  const typeCounts: Record<string, number> = {}
  for (const t of nodeTypes) {
    typeCounts[t] = (typeCounts[t] ?? 0) + 1
  }
  for (const [type, count] of Object.entries(typeCounts)) {
    if (count >= 4 && result.nodes.length >= 5) {
      issues.push(`TYPE_SATURATION: ${count}/${result.nodes.length} nodes are type "${type}"`)
    }
  }

  // 6. Short prompts should get minimal context (not waste tokens)
  if (prompt.length <= 5 && result.nodes.length > 2) {
    issues.push(`OVER_INJECTION: Very short prompt "${prompt}" got ${result.nodes.length} nodes`)
  }

  // Score
  let score: 'GOOD' | 'OK' | 'POOR' | 'EMPTY'
  if (result.nodes.length === 0 && expected.length > 0) {
    score = 'EMPTY'
  } else if (issues.some(i => i.startsWith('NO_NODES') || i.startsWith('TOKEN_BLOAT'))) {
    score = 'POOR'
  } else if (issues.length > 1) {
    score = 'OK'
  } else {
    score = 'GOOD'
  }

  return { issues, score }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== OMG Context Quality Evaluation ===')
  console.log(`Workspace: ${WORKSPACE_DIR}`)
  console.log(`OMG root:  ${omgRoot}`)
  console.log(`Prompts:   ${TEST_PROMPTS.length}`)
  console.log()

  // Load registry once
  const registryEntries = await getRegistryEntries(omgRoot, { archived: false })
  console.log(`Registry:  ${registryEntries.length} active nodes`)

  // Load index and now
  const indexContent = await fs.readFile(path.join(omgRoot, 'index.md'), 'utf-8').catch(() => '')
  const nowContent = await fs.readFile(path.join(omgRoot, 'now.md'), 'utf-8').catch(() => null)

  console.log(`Index:     ${indexContent.length} chars`)
  console.log(`Now:       ${nowContent ? nowContent.length + ' chars' : 'not found'}`)
  console.log()
  console.log('─'.repeat(120))

  const results: EvalResult[] = []
  const scoreCounts = { GOOD: 0, OK: 0, POOR: 0, EMPTY: 0 }

  for (const test of TEST_PROMPTS) {
    const recentMessages: readonly Message[] = [{ role: 'user', content: test.prompt }]

    const slice = await selectContextV2({
      indexContent,
      nowContent,
      registryEntries,
      recentMessages,
      config,
      hydrateNode: readGraphNode,
      memoryTools: null,
    })

    const contextBlock = renderContextBlock(slice)
    const { issues, score } = assessQuality(slice, test.expectedDomains, test.prompt)
    scoreCounts[score]++

    const evalResult: EvalResult = {
      id: test.id,
      prompt: test.prompt,
      expectedDomains: test.expectedDomains,
      nodeCount: slice.nodes.length,
      mocCount: slice.mocs.length,
      estimatedTokens: slice.estimatedTokens,
      nodeIds: slice.nodes.map(n => n.frontmatter.id),
      nodeTypes: slice.nodes.map(n => n.frontmatter.type),
      nodeDescriptions: slice.nodes.map(n => n.frontmatter.description),
      hasNow: slice.nowNode !== null,
      contextBlock,
      qualityIssues: issues,
      score,
    }
    results.push(evalResult)

    // Compact output
    const scoreEmoji = { GOOD: '✅', OK: '⚠️', POOR: '❌', EMPTY: '🔴' }[score]
    const typeSummary = [...new Set(evalResult.nodeTypes)].join(',') || '(none)'
    console.log(
      `${scoreEmoji} #${String(test.id).padStart(2)} | ${score.padEnd(5)} | ` +
      `nodes=${String(evalResult.nodeCount).padStart(1)} mocs=${String(evalResult.mocCount).padStart(1)} ` +
      `tokens=${String(evalResult.estimatedTokens).padStart(4)} | ` +
      `types=[${typeSummary.padEnd(30)}] | ` +
      `"${test.prompt}"`
    )
    if (issues.length > 0) {
      for (const issue of issues) {
        console.log(`     └─ ${issue}`)
      }
    }
  }

  console.log()
  console.log('─'.repeat(120))
  console.log()
  console.log('=== SUMMARY ===')
  console.log(`Total:  ${results.length}`)
  console.log(`✅ GOOD:  ${scoreCounts.GOOD} (${Math.round(scoreCounts.GOOD / results.length * 100)}%)`)
  console.log(`⚠️  OK:    ${scoreCounts.OK} (${Math.round(scoreCounts.OK / results.length * 100)}%)`)
  console.log(`❌ POOR:  ${scoreCounts.POOR} (${Math.round(scoreCounts.POOR / results.length * 100)}%)`)
  console.log(`🔴 EMPTY: ${scoreCounts.EMPTY} (${Math.round(scoreCounts.EMPTY / results.length * 100)}%)`)
  console.log()

  // Domain coverage breakdown
  console.log('=== DOMAIN COVERAGE ===')
  const domainHits: Record<string, { hit: number; miss: number }> = {}
  for (const r of results) {
    for (const d of r.expectedDomains) {
      if (!domainHits[d]) domainHits[d] = { hit: 0, miss: 0 }
      const missed = r.qualityIssues.some(i => i.includes(`"${d}"`))
      if (missed) {
        domainHits[d].miss++
      } else {
        domainHits[d].hit++
      }
    }
  }
  for (const [domain, counts] of Object.entries(domainHits).sort((a, b) => a[0].localeCompare(b[0]))) {
    const total = counts.hit + counts.miss
    const pct = Math.round(counts.hit / total * 100)
    console.log(`  ${domain.padEnd(15)} ${counts.hit}/${total} (${pct}%)`)
  }

  // Worst cases
  console.log()
  console.log('=== WORST CASES (POOR + EMPTY) ===')
  const worst = results.filter(r => r.score === 'POOR' || r.score === 'EMPTY')
  if (worst.length === 0) {
    console.log('  None! All prompts got reasonable context.')
  } else {
    for (const r of worst) {
      console.log(`  #${r.id} "${r.prompt}"`)
      console.log(`    Expected: [${r.expectedDomains.join(', ')}]`)
      console.log(`    Got: ${r.nodeCount} nodes [${r.nodeTypes.join(', ')}]`)
      console.log(`    Issues: ${r.qualityIssues.join('; ')}`)
      if (r.nodeDescriptions.length > 0) {
        console.log(`    Descriptions:`)
        for (const d of r.nodeDescriptions) {
          console.log(`      - ${d}`)
        }
      }
    }
  }

  // Write detailed results to file
  const outputPath = path.join(omgRoot, '..', '..', 'context-eval-results.json')
  await fs.writeFile(outputPath, JSON.stringify(results.map(r => ({
    ...r,
    contextBlock: r.contextBlock.substring(0, 500) + (r.contextBlock.length > 500 ? '...' : ''),
  })), null, 2))
  console.log()
  console.log(`Detailed results written to: ${outputPath}`)
}

main().catch(err => {
  console.error('Eval failed:', err)
  process.exit(1)
})
