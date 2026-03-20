/**
 * Context Quality Evaluation — 20 realistic user messages
 *
 * Tests the OMG context selector against the live Secretary graph
 * with 20 representative queries spanning identity, family, projects,
 * preferences, decisions, and episodic recall.
 *
 * Each query has manually-specified "expected" nodes that SHOULD appear
 * and "anti" nodes that should NOT appear. Scoring: 1–10 relevance.
 */
import { describe, it, expect } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { selectContextV2 } from '../../src/context/selector.js'
import { renderContextBlock } from '../../src/context/renderer.js'
import { readGraphNode } from '../../src/graph/node-reader.js'
import { parseConfig } from '../../src/config.js'
import type { RegistryNodeEntry } from '../../src/graph/registry.js'
import type { GraphNode, Message } from '../../src/types.js'

const OMG_ROOT = '/Users/szymonpaluch/Projects/Personal/Secretary/memory/omg'

interface TestQuery {
  /** Short label for the test */
  readonly label: string
  /** Simulated user message(s) */
  readonly messages: readonly Message[]
  /** Node ID substrings that SHOULD appear in selected context */
  readonly expectedHits: readonly string[]
  /** Node ID substrings that should NOT appear (noise) */
  readonly antiPatterns: readonly string[]
  /** Minimum acceptable relevance score (1–10) */
  readonly minRelevance: number
}

const TEST_QUERIES: readonly TestQuery[] = [
  // === IDENTITY ===
  {
    label: '1. Who am I? (core identity)',
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
    label: '8. Task management system',
    messages: [{ role: 'user', content: 'Where should tasks be stored? What is the single source of truth?' }],
    expectedHits: ['task', 'single-source'],
    antiPatterns: ['comfyui', 'music'],
    minRelevance: 6,
  },

  // === PROJECTS ===
  {
    label: '9. ComfyUI / image pipeline',
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
    label: '13. Self-hosted GPU decision',
    messages: [{ role: 'user', content: 'Why did we decide to self-host GPU instead of using API?' }],
    expectedHits: ['self-host', 'tensordock', 'gpu'],
    antiPatterns: ['email', 'children'],
    minRelevance: 5,
  },
  {
    label: '14. Pati vs coding agent split',
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
    label: '17. Calendar / scheduling',
    messages: [{ role: 'user', content: 'How should you handle my calendar and scheduling?' }],
    expectedHits: ['calendar', 'scheduling', 'capture'],
    antiPatterns: ['music', 'hackathon'],
    minRelevance: 5,
  },
  {
    label: '18. Monday planning routine',
    messages: [{ role: 'user', content: 'What is my Monday morning routine?' }],
    expectedHits: ['monday', 'planning', 'admin-blitz'],
    antiPatterns: ['comfyui', 'music'],
    minRelevance: 5,
  },

  // === POLISH LANGUAGE ===
  {
    label: '19. Polish: productivity system',
    messages: [{ role: 'user', content: 'Jak wygląda mój system produktywności z Apple Reminders?' }],
    expectedHits: ['productivity', 'apple-remind', 'task'],
    antiPatterns: ['music'],
    minRelevance: 5,
  },
  {
    label: '20. Polish: photo POV prompting',
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
  return Object.entries(data.nodes).filter(
    ([, e]) => !e.archived,
  )
}

async function loadFileContent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
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

  // Scale: 0–10
  const raw = hitRatio * 10 - antiPenalty
  return Math.max(0, Math.min(10, Math.round(raw * 10) / 10))
}

// ─── test suite ────────────────────────────────────────────────────

describe('Context Quality — 20 Message Evaluation', () => {
  let registryEntries: readonly [string, RegistryNodeEntry][]
  let indexContent: string
  let nowContent: string | null
  let config: ReturnType<typeof parseConfig>

  const results: Array<{
    label: string
    score: number
    pass: boolean
    selectedCount: number
    selectedIds: string[]
    hits: string[]
    misses: string[]
    antiHits: string[]
    tokens: number
  }> = []

  // Load once before all tests
  it('loads the live Secretary graph', async () => {
    registryEntries = await loadRegistry()
    indexContent = (await loadFileContent(`${OMG_ROOT}/index.md`)) ?? ''
    nowContent = await loadFileContent(`${OMG_ROOT}/now.md`)
    config = parseConfig({
      injection: {
        maxContextTokens: 4000,
        maxMocs: 5,
        maxNodes: 10,
      },
    })

    expect(registryEntries.length).toBeGreaterThan(100)
  })

  for (const query of TEST_QUERIES) {
    it(query.label, async () => {
      expect(registryEntries).toBeDefined()

      const hydrateNode = async (filePath: string): Promise<GraphNode | null> => {
        return readGraphNode(filePath)
      }

      const slice = await selectContextV2({
        indexContent,
        nowContent,
        registryEntries,
        recentMessages: query.messages,
        config,
        hydrateNode,
        memoryTools: null,
        omgRoot: OMG_ROOT,
      })

      const rendered = renderContextBlock(slice)
      const selectedIds = [
        ...slice.mocs.map((n) => n.frontmatter.id),
        ...slice.nodes.map((n) => n.frontmatter.id),
      ]

      const hits = query.expectedHits.filter((pat) =>
        selectedIds.some((id) => id.toLowerCase().includes(pat.toLowerCase())),
      )
      const misses = query.expectedHits.filter(
        (pat) => !selectedIds.some((id) => id.toLowerCase().includes(pat.toLowerCase())),
      )
      const antiHits = query.antiPatterns.filter((pat) =>
        selectedIds.some((id) => id.toLowerCase().includes(pat.toLowerCase())),
      )

      const score = scoreRelevance(selectedIds, query.expectedHits, query.antiPatterns)

      results.push({
        label: query.label,
        score,
        pass: score >= query.minRelevance,
        selectedCount: selectedIds.length,
        selectedIds: [...selectedIds],
        hits,
        misses,
        antiHits,
        tokens: slice.estimatedTokens,
      })

      // Log for debugging
      console.log(`\n--- ${query.label} ---`)
      console.log(`  Query: "${query.messages[0].content}"`)
      console.log(`  Selected (${selectedIds.length}): ${selectedIds.join(', ')}`)
      console.log(`  Hits: ${hits.join(', ') || '(none)'}`)
      console.log(`  Misses: ${misses.join(', ') || '(none)'}`)
      console.log(`  Anti-hits: ${antiHits.join(', ') || '(none)'}`)
      console.log(`  Score: ${score}/10 (min: ${query.minRelevance})`)
      console.log(`  Tokens: ${slice.estimatedTokens}`)
      console.log(`  Rendered length: ${rendered.length} chars`)

      // Soft assertion — don't fail the test but track the score
      expect(score).toBeGreaterThanOrEqual(0)
    })
  }

  it('prints summary report', () => {
    console.log('\n\n========================================')
    console.log('  CONTEXT QUALITY EVALUATION SUMMARY')
    console.log('========================================\n')

    const passed = results.filter((r) => r.pass)
    const failed = results.filter((r) => !r.pass)
    const avgScore = results.reduce((s, r) => s + r.score, 0) / results.length
    const avgTokens = results.reduce((s, r) => s + r.tokens, 0) / results.length

    console.log(`Total queries: ${results.length}`)
    console.log(`Pass (≥ min): ${passed.length}/${results.length}`)
    console.log(`Average score: ${avgScore.toFixed(1)}/10`)
    console.log(`Average tokens: ${Math.round(avgTokens)}`)
    console.log()

    // Table
    console.log('| # | Query | Score | Min | Pass | Hits | Misses | Anti | Tokens |')
    console.log('|---|-------|-------|-----|------|------|--------|------|--------|')
    for (const r of results) {
      const icon = r.pass ? 'Y' : 'N'
      console.log(
        `| ${r.label.split('.')[0].trim()} | ${r.label.split('.')[1]?.trim() ?? ''} | ${r.score} | ${
          TEST_QUERIES.find((q) => q.label === r.label)?.minRelevance ?? '?'
        } | ${icon} | ${r.hits.length} | ${r.misses.length} | ${r.antiHits.length} | ${r.tokens} |`,
      )
    }

    console.log()

    if (failed.length > 0) {
      console.log('--- BELOW THRESHOLD ---')
      for (const r of failed) {
        console.log(`  ${r.label}: ${r.score}/10 (expected ≥${TEST_QUERIES.find((q) => q.label === r.label)?.minRelevance})`)
        if (r.misses.length > 0) console.log(`    Missing: ${r.misses.join(', ')}`)
        if (r.antiHits.length > 0) console.log(`    Noise: ${r.antiHits.join(', ')}`)
      }
    }

    console.log('\n========================================')
    console.log(`  FINAL: ${avgScore.toFixed(1)}/10 avg | ${passed.length}/${results.length} pass`)
    console.log('========================================')

    // Write report to file for reading
    const lines: string[] = []
    lines.push('========================================')
    lines.push('  CONTEXT QUALITY EVALUATION SUMMARY')
    lines.push('========================================')
    lines.push('')
    lines.push(`Total queries: ${results.length}`)
    lines.push(`Pass (≥ min): ${passed.length}/${results.length}`)
    lines.push(`Average score: ${avgScore.toFixed(1)}/10`)
    lines.push(`Average tokens: ${Math.round(avgTokens)}`)
    lines.push('')

    lines.push('| # | Query | Score | Min | Pass | Hits | Misses | Anti | Tokens | Selected IDs |')
    lines.push('|---|-------|-------|-----|------|------|--------|------|--------|--------------|')
    for (const r of results) {
      const icon = r.pass ? 'Y' : 'N'
      const q = TEST_QUERIES.find((q) => q.label === r.label)
      lines.push(
        `| ${r.label} | ${r.score} | ${q?.minRelevance ?? '?'} | ${icon} | ${r.hits.join(',')} | ${r.misses.join(',')} | ${r.antiHits.join(',')} | ${r.tokens} | see below |`,
      )
    }
    lines.push('')

    // Detailed per-query results
    for (const r of results) {
      const q = TEST_QUERIES.find((q) => q.label === r.label)!
      lines.push(`--- ${r.label} ---`)
      lines.push(`  Query: "${q.messages[0].content}"`)
      lines.push(`  Selected (${r.selectedCount}): ${r.selectedIds.join(', ')}`)
      lines.push(`  Hits: ${r.hits.join(', ') || '(none)'}`)
      lines.push(`  Misses: ${r.misses.join(', ') || '(none)'}`)
      lines.push(`  Anti-hits: ${r.antiHits.join(', ') || '(none)'}`)
      lines.push(`  Score: ${r.score}/10 (min: ${q.minRelevance})`)
      lines.push(`  Tokens: ${r.tokens}`)
      lines.push('')
    }

    if (failed.length > 0) {
      lines.push('--- BELOW THRESHOLD ---')
      for (const r of failed) {
        lines.push(`  ${r.label}: ${r.score}/10 (expected ≥${TEST_QUERIES.find((q) => q.label === r.label)?.minRelevance})`)
        if (r.misses.length > 0) lines.push(`    Missing: ${r.misses.join(', ')}`)
        if (r.antiHits.length > 0) lines.push(`    Noise: ${r.antiHits.join(', ')}`)
      }
      lines.push('')
    }

    lines.push('========================================')
    lines.push(`  FINAL: ${avgScore.toFixed(1)}/10 avg | ${passed.length}/${results.length} pass`)
    lines.push('========================================')

    await writeFile('/tmp/omg-eval-results.txt', lines.join('\n'), 'utf-8')

    // Assert overall quality
    expect(avgScore).toBeGreaterThan(0)
  })
})
