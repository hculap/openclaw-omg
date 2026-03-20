/**
 * Comparison test: context selection WITH vs WITHOUT graph expansion.
 *
 * Uses real registry data and simulated agent prompts based on
 * actual agent sessions from gateway.err.log:
 *   - pati:telegram — photo/media generation
 *   - coding:telegram — discord routing, visa project
 *   - whatsapp-triage — heartbeat/automation
 *   - pati:cron — surprise message delivery
 *   - email-triage — calendar, contacts
 *
 * Writes comparison results to /tmp/graph-comparison-results.txt
 */

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { parseConfig } from '../../src/config.js'
import { selectContextV2 } from '../../src/context/selector.js'
import type { RegistryNodeEntry } from '../../src/graph/registry.js'
import type { GraphNode } from '../../src/types.js'
import { readGraphNode } from '../../src/graph/node-reader.js'
import { clearGraphCache } from '../../src/graph/traversal.js'

const REGISTRY_PATH = '/Users/szymonpaluch/Projects/Personal/Secretary/memory/omg/.registry.json'
const OMG_ROOT = '/Users/szymonpaluch/Projects/Personal/Secretary/memory/omg'
const OUTPUT_PATH = '/tmp/graph-comparison-results.txt'

const lines: string[] = []
function log(msg: string): void { lines.push(msg) }

/**
 * Simulated agent prompts based on real gateway.err.log sessions.
 * Each represents a typical user message that triggers context injection.
 */
const SCENARIOS: Array<{ name: string; agent: string; prompt: string }> = [
  {
    name: 'Pati photo generation',
    agent: 'pati:telegram:direct:szymon',
    prompt: 'Generate a photo of Pati in the new outfit, use the reference from last session',
  },
  {
    name: 'Cron heartbeat troubleshooting',
    agent: 'whatsapp-triage:main',
    prompt: 'The heartbeat cron is showing false ack again, check step0 state update',
  },
  {
    name: 'Discord routing setup',
    agent: 'coding:telegram:direct:szymon',
    prompt: 'Update the discord channel routing for visa-poc project, check permissions state',
  },
  {
    name: 'Surprise message for Pati',
    agent: 'pati:cron',
    prompt: 'Send a surprise message to Pati with a photo and voice note, check delivery rules',
  },
  {
    name: 'Task management daily planning',
    agent: 'coding:main',
    prompt: 'Show me my daily goals and check the reminders inbox for overdue items',
  },
  {
    name: 'Invoice and finance automation',
    agent: 'coding:telegram:direct:szymon',
    prompt: 'Check the monthly invoice pipeline status and accountant flow automation',
  },
  {
    name: 'Video generation pipeline',
    agent: 'pati:telegram:direct:szymon',
    prompt: 'Generate a video of Pati, use the veo3 pipeline with elevenlabs dubbing',
  },
  {
    name: 'GPU infrastructure management',
    agent: 'coding:main',
    prompt: 'Check the RunPod ComfyUI pod status, should we stop the GPU after generation?',
  },
]

describe.skipIf(!existsSync(REGISTRY_PATH))('graph expansion comparison on real data', () => {
  const raw = existsSync(REGISTRY_PATH)
    ? JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'))
    : { nodes: {} }
  const registryEntries: [string, RegistryNodeEntry][] = (
    Object.entries(raw.nodes) as [string, RegistryNodeEntry][]
  ).filter(([, e]) => !e.archived)

  const indexContent = (() => {
    try { return readFileSync(`${OMG_ROOT}/index.md`, 'utf8') } catch { return '' }
  })()
  const nowContent = (() => {
    try { return readFileSync(`${OMG_ROOT}/now.md`, 'utf8') } catch { return null }
  })()

  // Default maxNodes=5 is too tight for graph expansion to show effect.
  // Test with maxNodes=15 to see what graph expansion surfaces.
  const configWithoutGraph = parseConfig({ injection: { maxNodes: 15, graph: { enabled: false } } })
  const configWithGraph = parseConfig({ injection: { maxNodes: 15, graph: { enabled: true, expansionTopK: 10, maxDepth: 2, neighborWeight: 0.5 } } })

  afterAll(() => {
    writeFileSync(OUTPUT_PATH, lines.join('\n') + '\n')
  })

  for (const scenario of SCENARIOS) {
    it(`compares: ${scenario.name}`, async () => {
      clearGraphCache()

      const messages = [{ role: 'user' as const, content: scenario.prompt }]

      const [sliceWithout, sliceWith] = await Promise.all([
        selectContextV2({
          indexContent,
          nowContent,
          registryEntries,
          recentMessages: messages,
          config: configWithoutGraph,
          hydrateNode: readGraphNode,
          omgRoot: OMG_ROOT,
        }),
        selectContextV2({
          indexContent,
          nowContent,
          registryEntries,
          recentMessages: messages,
          config: configWithGraph,
          hydrateNode: readGraphNode,
          omgRoot: OMG_ROOT,
        }),
      ])

      const allWithout = [...sliceWithout.mocs, ...sliceWithout.nodes, ...(sliceWithout.nowNode ? [sliceWithout.nowNode] : [])]
      const allWith = [...sliceWith.mocs, ...sliceWith.nodes, ...(sliceWith.nowNode ? [sliceWith.nowNode] : [])]
      const withoutIds = new Set(allWithout.map((n) => n.frontmatter.id))
      const withIds = new Set(allWith.map((n) => n.frontmatter.id))

      const onlyInWithout = [...withoutIds].filter((id) => !withIds.has(id))
      const onlyInWith = [...withIds].filter((id) => !withoutIds.has(id))
      const inBoth = [...withoutIds].filter((id) => withIds.has(id))

      log(`\n${'='.repeat(80)}`)
      log(`SCENARIO: ${scenario.name}`)
      log(`Agent: ${scenario.agent}`)
      log(`Prompt: "${scenario.prompt}"`)
      log(`${'='.repeat(80)}`)
      log('')
      log(`WITHOUT graph: ${allWithout.length} nodes, ${sliceWithout.estimatedTokens} tokens`)
      log(`WITH graph:    ${allWith.length} nodes, ${sliceWith.estimatedTokens} tokens`)
      log(`Common: ${inBoth.length} | Dropped: ${onlyInWithout.length} | NEW from graph: ${onlyInWith.length}`)
      log('')

      if (onlyInWith.length > 0) {
        log('--- NEW nodes added by graph expansion ---')
        for (const id of onlyInWith) {
          const node = allWith.find((n) => n.frontmatter.id === id)!
          const entry = registryEntries.find(([eid]) => eid === id)?.[1]
          log(`  + ${id}`)
          log(`    type=${entry?.type}, priority=${entry?.priority}`)
          log(`    "${entry?.description?.slice(0, 90)}"`)
        }
        log('')
      }

      if (onlyInWithout.length > 0) {
        log('--- Nodes DISPLACED by graph expansion ---')
        for (const id of onlyInWithout) {
          const entry = registryEntries.find(([eid]) => eid === id)?.[1]
          log(`  - ${id}`)
          log(`    type=${entry?.type}, "${entry?.description?.slice(0, 90)}"`)
        }
        log('')
      }

      log('--- Common nodes (in both) ---')
      for (const id of inBoth) {
        const entry = registryEntries.find(([eid]) => eid === id)?.[1]
        log(`  = ${id} (${entry?.type})`)
      }

      // Assess quality: are the NEW nodes topically relevant?
      const promptWords = new Set(scenario.prompt.toLowerCase().split(/\s+/).filter((w) => w.length > 3))
      let relevantNew = 0
      for (const id of onlyInWith) {
        const entry = registryEntries.find(([eid]) => eid === id)?.[1]
        const text = `${entry?.description ?? ''} ${(entry?.tags ?? []).join(' ')} ${id}`.toLowerCase()
        const matchingWords = [...promptWords].filter((w) => text.includes(w))
        if (matchingWords.length > 0) relevantNew++
      }

      log('')
      log(`QUALITY: ${relevantNew}/${onlyInWith.length} new nodes have keyword overlap with prompt`)
      log(`         (Remaining ${onlyInWith.length - relevantNew} are structurally connected but keyword-invisible)`)

      expect(allWith.length).toBeGreaterThan(0)
      expect(allWithout.length).toBeGreaterThan(0)
    })
  }
})
