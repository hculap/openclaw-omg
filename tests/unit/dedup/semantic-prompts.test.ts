import { describe, it, expect } from 'vitest'
import { buildSemanticDedupSystemPrompt, buildSemanticDedupUserPrompt } from '../../../src/dedup/semantic-prompts.js'
import type { SemanticBlock } from '../../../src/dedup/semantic-types.js'
import type { RegistryNodeEntry } from '../../../src/graph/registry.js'

function makeBlock(nodeCount: number = 3): SemanticBlock {
  const nodeIds = Array.from({ length: nodeCount }, (_, i) => `omg/fact-${i}`)
  const entries = new Map<string, RegistryNodeEntry>()
  for (let i = 0; i < nodeCount; i++) {
    entries.set(`omg/fact-${i}`, {
      type: 'fact',
      kind: 'observation',
      description: `Description for fact ${i}`,
      priority: 'medium',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-15T00:00:00Z',
      filePath: `/fake/fact-${i}.md`,
      canonicalKey: `facts.fact-${i}`,
      tags: ['tag-a', 'tag-b'],
    })
  }
  return { nodeIds, entries, domain: 'facts', maxHeuristicScore: 0.5 }
}

describe('buildSemanticDedupSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildSemanticDedupSystemPrompt()
    expect(prompt.length).toBeGreaterThan(100)
  })

  it('mentions JSON output format', () => {
    const prompt = buildSemanticDedupSystemPrompt()
    expect(prompt).toContain('JSON')
  })

  it('mentions similarity score', () => {
    const prompt = buildSemanticDedupSystemPrompt()
    expect(prompt).toContain('similarityScore')
  })
})

describe('buildSemanticDedupUserPrompt', () => {
  it('includes all node IDs', () => {
    const block = makeBlock(3)
    const contents = new Map<string, string>()
    for (const id of block.nodeIds) {
      contents.set(id, `Body for ${id}`)
    }
    const prompt = buildSemanticDedupUserPrompt(block, contents, 500)
    for (const id of block.nodeIds) {
      expect(prompt).toContain(id)
    }
  })

  it('includes descriptions', () => {
    const block = makeBlock(2)
    const contents = new Map<string, string>()
    const prompt = buildSemanticDedupUserPrompt(block, contents, 500)
    expect(prompt).toContain('Description for fact 0')
    expect(prompt).toContain('Description for fact 1')
  })

  it('includes tags', () => {
    const block = makeBlock(1)
    const contents = new Map<string, string>()
    const prompt = buildSemanticDedupUserPrompt(block, contents, 500)
    expect(prompt).toContain('tag-a')
  })

  it('truncates long bodies', () => {
    const block = makeBlock(1)
    const longBody = 'x'.repeat(1000)
    const contents = new Map<string, string>([[block.nodeIds[0]!, longBody]])
    const prompt = buildSemanticDedupUserPrompt(block, contents, 200)
    expect(prompt).toContain('...[truncated]')
    expect(prompt).not.toContain('x'.repeat(1000))
  })

  it('includes domain in header', () => {
    const block = makeBlock(1)
    const contents = new Map<string, string>()
    const prompt = buildSemanticDedupUserPrompt(block, contents, 500)
    expect(prompt).toContain('Domain: facts')
  })
})
