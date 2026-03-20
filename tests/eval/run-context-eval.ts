/**
 * Standalone context quality evaluation — runs outside vitest.
 * Usage: pnpm exec tsx tests/eval/run-context-eval.ts
 */
import { readFile, writeFile } from 'node:fs/promises'
import { selectContextV2 } from '../../src/context/selector.js'
import { renderContextBlock } from '../../src/context/renderer.js'
import { readGraphNode } from '../../src/graph/node-reader.js'
import { parseConfig } from '../../src/config.js'
import type { RegistryNodeEntry } from '../../src/graph/registry.js'
import type { GraphNode, Message } from '../../src/types.js'

const OMG_ROOT = '/Users/szymonpaluch/Projects/Personal/Secretary/memory/omg'

interface TestQuery {
  readonly label: string
  readonly messages: readonly Message[]
  readonly expectedHits: readonly string[]
  readonly antiPatterns: readonly string[]
  readonly minRelevance: number
}

const TEST_QUERIES: readonly TestQuery[] = [
  // === IDENTITY ===
  {
    label: '1. Who am I (core identity)',
    messages: [{ role: 'user', content: 'Przypomnij mi kim jestem i co robię' }],
    expectedHits: ['identity-szymon', 'identity-communication-style'],
    antiPatterns: ['cron', 'comfyui'],
    minRelevance: 6,
  },
  {
    label: '2. My kids (family)',
    messages: [{ role: 'user', content: 'Ile lat mają moje dzieci?' }],
    expectedHits: ['identity-family-children', 'identity-parent'],
    antiPatterns: ['comfyui', 'gmail', 'cron'],
    minRelevance: 7,
  },
  {
    label: '3. Music background',
    messages: [{ role: 'user', content: 'What band did I play guitar in during university?' }],
    expectedHits: ['identity-music'],
    antiPatterns: ['cron', 'email', 'infrastructure'],
    minRelevance: 5,
  },
  {
    label: '4. Wife / partner',
    messages: [{ role: 'user', content: 'Powiedz mi o Sylwii' }],
    expectedHits: ['sylwia', 'family'],
    antiPatterns: ['comfyui', 'hackathon'],
    minRelevance: 5,
  },
  // === PREFERENCES ===
  {
    label: '5. Communication style',
    messages: [{ role: 'user', content: 'How should you talk to me? What do I prefer?' }],
    expectedHits: ['communication-style', 'preference'],
    antiPatterns: ['comfyui', 'hackathon'],
    minRelevance: 6,
  },
  {
    label: '6. Family time boundaries',
    messages: [{ role: 'user', content: 'Should you message me when I am with my family?' }],
    expectedHits: ['family-time', 'quiet-mode'],
    antiPatterns: ['hackathon', 'cron-models'],
    minRelevance: 6,
  },
  {
    label: '7. Photo generation workflow',
    messages: [{ role: 'user', content: 'How should Pati generate photos? What workflow do we use?' }],
    expectedHits: ['photo', 'reference', 'pati'],
    antiPatterns: ['email', 'gmail'],
    minRelevance: 6,
  },
  {
    label: '8. Task management',
    messages: [{ role: 'user', content: 'Where should tasks be stored? What is the single source of truth?' }],
    expectedHits: ['task', 'single-source'],
    antiPatterns: ['comfyui', 'music'],
    minRelevance: 6,
  },
  // === PROJECTS ===
  {
    label: '9. Image pipeline infra',
    messages: [{ role: 'user', content: 'What is the status of our image generation infrastructure?' }],
    expectedHits: ['comfyui', 'pipeline', 'tensordock'],
    antiPatterns: ['music', 'email'],
    minRelevance: 5,
  },
  {
    label: '10. OMG plugin project',
    messages: [{ role: 'user', content: 'Tell me about the OMG memory graph project' }],
    expectedHits: ['omg', 'memory-graph'],
    antiPatterns: ['music', 'family-children'],
    minRelevance: 5,
  },
  {
    label: '11. Cron job issues',
    messages: [{ role: 'user', content: 'What problems have we had with cron jobs?' }],
    expectedHits: ['cron'],
    antiPatterns: ['music', 'children-ages'],
    minRelevance: 5,
  },
  {
    label: '12. NVIDIA hackathon',
    messages: [{ role: 'user', content: 'Tell me about the NVIDIA hackathon project' }],
    expectedHits: ['cosmos', 'hackathon', 'nvidia', 'surveillance'],
    antiPatterns: ['email', 'music'],
    minRelevance: 5,
  },
  // === DECISIONS ===
  {
    label: '13. Self-hosted GPU',
    messages: [{ role: 'user', content: 'Why did we decide to self-host GPU instead of using API?' }],
    expectedHits: ['self-host', 'tensordock', 'gpu'],
    antiPatterns: ['email', 'children'],
    minRelevance: 5,
  },
  {
    label: '14. Agent architecture split',
    messages: [{ role: 'user', content: 'What is the architecture split between Pati and the coding agent?' }],
    expectedHits: ['clawdbot', 'pati', 'backend-frontend', 'split'],
    antiPatterns: ['music', 'email'],
    minRelevance: 5,
  },
  // === FACTS ===
  {
    label: '15. Email address',
    messages: [{ role: 'user', content: 'What is my email address?' }],
    expectedHits: ['email', 'contact'],
    antiPatterns: ['comfyui', 'hackathon'],
    minRelevance: 6,
  },
  {
    label: '16. Gamification insight',
    messages: [{ role: 'user', content: 'What motivational approach works best with me?' }],
    expectedHits: ['gamif', 'challenge', 'reward'],
    antiPatterns: ['cron', 'email'],
    minRelevance: 4,
  },
  // === EPISODIC / TIME-BASED ===
  {
    label: '17. Calendar handling',
    messages: [{ role: 'user', content: 'How should you handle my calendar and scheduling?' }],
    expectedHits: ['calendar', 'scheduling', 'capture'],
    antiPatterns: ['music', 'hackathon'],
    minRelevance: 5,
  },
  {
    label: '18. Monday routine',
    messages: [{ role: 'user', content: 'What is my Monday morning routine?' }],
    expectedHits: ['monday', 'planning', 'admin-blitz'],
    antiPatterns: ['comfyui', 'music'],
    minRelevance: 5,
  },
  // === POLISH LANGUAGE ===
  {
    label: '19. PL: productivity system',
    messages: [{ role: 'user', content: 'Jak wygląda mój system produktywności z Apple Reminders?' }],
    expectedHits: ['productivity', 'apple-remind', 'task'],
    antiPatterns: ['music'],
    minRelevance: 5,
  },
  {
    label: '20. PL: POV photo prompting',
    messages: [{ role: 'user', content: 'Jak promptować zdjęcia w stylu POV?' }],
    expectedHits: ['pov', 'photo', 'prompting'],
    antiPatterns: ['email', 'children'],
    minRelevance: 5,
  },
]

// ─── helpers ───────────────────────────────────────────────────────
async function loadRegistry(): Promise<readonly [string, RegistryNodeEntry][]> {
  const raw = await readFile(`${OMG_ROOT}/.registry.json`, 'utf-8')
  const data = JSON.parse(raw) as { version: number; nodes: Record<string, RegistryNodeEntry> }
  return Object.entries(data.nodes).filter(([, e]) => !e.archived)
}

function scoreRelevance(
  selectedIds: readonly string[],
  expectedHits: readonly string[],
  antiPatterns: readonly string[],
): number {
  const hitCount = expectedHits.filter((pat) =>
    selectedIds.some((id) => id.toLowerCase().includes(pat.toLowerCase())),
  ).length
  const antiCount = antiPatterns.filter((pat) =>
    selectedIds.some((id) => id.toLowerCase().includes(pat.toLowerCase())),
  ).length
  const hitRatio = expectedHits.length > 0 ? hitCount / expectedHits.length : 1
  const antiPenalty = antiCount * 0.5
  const raw = hitRatio * 10 - antiPenalty
  return Math.max(0, Math.min(10, Math.round(raw * 10) / 10))
}

// ─── main ──────────────────────────────────────────────────────────
async function main() {
  console.log('Loading registry...')
  const registryEntries = await loadRegistry()
  const indexContent = await readFile(`${OMG_ROOT}/index.md`, 'utf-8').catch(() => '')
  const nowContent = await readFile(`${OMG_ROOT}/now.md`, 'utf-8').catch(() => null)
  const config = parseConfig({
    injection: { maxContextTokens: 4000, maxMocs: 5, maxNodes: 10 },
  })

  console.log(`Registry: ${registryEntries.length} active nodes`)
  console.log(`Running ${TEST_QUERIES.length} queries...\n`)

  const results: Array<{
    label: string
    query: string
    score: number
    pass: boolean
    selectedIds: string[]
    hits: string[]
    misses: string[]
    antiHits: string[]
    tokens: number
  }> = []

  for (const q of TEST_QUERIES) {
    const slice = await selectContextV2({
      indexContent,
      nowContent,
      registryEntries,
      recentMessages: q.messages,
      config,
      hydrateNode: (fp: string) => readGraphNode(fp),
      memoryTools: null,
      omgRoot: OMG_ROOT,
    })

    const selectedIds = [
      ...slice.mocs.map((n) => n.frontmatter.id),
      ...slice.nodes.map((n) => n.frontmatter.id),
    ]

    const hits = q.expectedHits.filter((pat) =>
      selectedIds.some((id) => id.toLowerCase().includes(pat.toLowerCase())),
    )
    const misses = q.expectedHits.filter(
      (pat) => !selectedIds.some((id) => id.toLowerCase().includes(pat.toLowerCase())),
    )
    const antiHits = q.antiPatterns.filter((pat) =>
      selectedIds.some((id) => id.toLowerCase().includes(pat.toLowerCase())),
    )
    const score = scoreRelevance(selectedIds, q.expectedHits, q.antiPatterns)

    results.push({
      label: q.label,
      query: q.messages[0].content,
      score,
      pass: score >= q.minRelevance,
      selectedIds,
      hits,
      misses,
      antiHits,
      tokens: slice.estimatedTokens,
    })

    const icon = score >= q.minRelevance ? 'PASS' : 'FAIL'
    console.log(`[${icon}] ${q.label}: ${score}/10 (min ${q.minRelevance}) | ${selectedIds.length} nodes, ${slice.estimatedTokens} tokens`)
  }

  // ─── build report ────────────────────────────────────────────
  const lines: string[] = []
  const passed = results.filter((r) => r.pass)
  const failed = results.filter((r) => !r.pass)
  const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length
  const avgTokens = results.reduce((s, r) => s + r.tokens, 0) / results.length

  lines.push('# OMG Context Quality Evaluation — 20 Messages')
  lines.push('')
  lines.push(`**Date**: ${new Date().toISOString().slice(0, 10)}`)
  lines.push(`**Registry**: ${registryEntries.length} active nodes`)
  lines.push(`**Config**: maxTokens=4000, maxMocs=5, maxNodes=10`)
  lines.push(`**Semantic boost**: disabled (memoryTools=null)`)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Total queries: ${results.length}`)
  lines.push(`- Pass (>= min threshold): **${passed.length}/${results.length}**`)
  lines.push(`- Average score: **${avgScore.toFixed(1)}/10**`)
  lines.push(`- Average tokens: ${Math.round(avgTokens)}`)
  lines.push('')

  lines.push('## Results Table')
  lines.push('')
  lines.push('| # | Query | Score | Min | Pass | Hits | Miss | Noise | Tokens |')
  lines.push('|---|-------|-------|-----|------|------|------|-------|--------|')
  for (const r of results) {
    const icon = r.pass ? 'Y' : '**N**'
    const q = TEST_QUERIES.find((tq) => tq.label === r.label)!
    lines.push(`| ${r.label} | ${r.score} | ${q.minRelevance} | ${icon} | ${r.hits.length}/${q.expectedHits.length} | ${r.misses.length} | ${r.antiHits.length} | ${r.tokens} |`)
  }

  lines.push('')
  lines.push('## Detailed Results')
  lines.push('')
  for (const r of results) {
    const q = TEST_QUERIES.find((tq) => tq.label === r.label)!
    const icon = r.pass ? 'PASS' : 'FAIL'
    lines.push(`### ${r.label} [${icon}]`)
    lines.push('')
    lines.push(`**Query**: "${r.query}"`)
    lines.push(`**Score**: ${r.score}/10 (min: ${q.minRelevance})`)
    lines.push(`**Tokens**: ${r.tokens}`)
    lines.push('')
    lines.push(`**Selected nodes** (${r.selectedIds.length}):`)
    for (const id of r.selectedIds) {
      lines.push(`- \`${id}\``)
    }
    lines.push('')
    if (r.hits.length > 0) lines.push(`**Hits**: ${r.hits.join(', ')}`)
    if (r.misses.length > 0) lines.push(`**Misses**: ${r.misses.join(', ')}`)
    if (r.antiHits.length > 0) lines.push(`**Noise (anti-pattern matches)**: ${r.antiHits.join(', ')}`)
    lines.push('')
  }

  if (failed.length > 0) {
    lines.push('## Below Threshold')
    lines.push('')
    for (const r of failed) {
      const q = TEST_QUERIES.find((tq) => tq.label === r.label)!
      lines.push(`- **${r.label}**: ${r.score}/10 (expected >= ${q.minRelevance})`)
      if (r.misses.length > 0) lines.push(`  - Missing: ${r.misses.join(', ')}`)
      if (r.antiHits.length > 0) lines.push(`  - Noise: ${r.antiHits.join(', ')}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push(`**FINAL: ${avgScore.toFixed(1)}/10 avg | ${passed.length}/${results.length} pass**`)

  const report = lines.join('\n')
  await writeFile('/tmp/omg-eval-results.md', report, 'utf-8')

  console.log('\n========================================')
  console.log(`  FINAL: ${avgScore.toFixed(1)}/10 avg | ${passed.length}/${results.length} pass`)
  console.log('========================================')
  console.log('\nFull report: /tmp/omg-eval-results.md')
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
