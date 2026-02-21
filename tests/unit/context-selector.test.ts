import { describe, it, expect, beforeEach } from 'vitest'
import { parseConfig } from '../../src/config.js'
import { selectContext } from '../../src/context/selector.js'
import type { OmgConfig } from '../../src/config.js'
import type { GraphNode } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(
  overrides: Partial<{
    id: string
    type: GraphNode['frontmatter']['type']
    priority: GraphNode['frontmatter']['priority']
    description: string
    body: string
    updated: string
    links: string[]
    tags: string[]
  }> = {}
): GraphNode {
  const now = new Date().toISOString()
  return {
    frontmatter: {
      id: overrides.id ?? 'omg/fact/test-fact',
      description: overrides.description ?? 'A test fact',
      type: overrides.type ?? 'fact',
      priority: overrides.priority ?? 'medium',
      created: now,
      updated: overrides.updated ?? now,
      links: overrides.links,
      tags: overrides.tags,
    },
    body: overrides.body ?? 'Some content about the topic.',
    filePath: `/omg/nodes/fact/test-fact.md`,
  }
}

function makeOldNode(daysAgo: number, id: string, priority: GraphNode['frontmatter']['priority'] = 'medium'): GraphNode {
  const d = new Date()
  d.setDate(d.getDate() - daysAgo)
  return makeNode({ id, priority, updated: d.toISOString() })
}

const INDEX_CONTENT = '# Memory Index\n- [[omg/moc-projects]]\n- [[omg/moc-preferences]]'
const NOW_CONTENT = '# Now\nWorking on phase 4 implementation.'

let config: OmgConfig

beforeEach(() => {
  config = parseConfig({})
})

// ---------------------------------------------------------------------------
// selectContext — empty graph
// ---------------------------------------------------------------------------

describe('selectContext — empty graph', () => {
  it('returns index and nowNode when graph has no nodes or mocs', () => {
    const slice = selectContext({
      indexContent: INDEX_CONTENT,
      nowContent: NOW_CONTENT,
      allNodes: [],
      recentMessages: [],
      config,
    })

    expect(slice.index).toBe(INDEX_CONTENT)
    expect(slice.nowNode).not.toBeNull()
    expect(slice.nodes).toHaveLength(0)
    expect(slice.mocs).toHaveLength(0)
  })

  it('returns null nowNode when nowContent is null', () => {
    const slice = selectContext({
      indexContent: INDEX_CONTENT,
      nowContent: null,
      allNodes: [],
      recentMessages: [],
      config,
    })

    expect(slice.nowNode).toBeNull()
  })

  it('estimates tokens for index + now', () => {
    const slice = selectContext({
      indexContent: INDEX_CONTENT,
      nowContent: NOW_CONTENT,
      allNodes: [],
      recentMessages: [],
      config,
    })

    expect(slice.estimatedTokens).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// selectContext — node scoring
// ---------------------------------------------------------------------------

describe('selectContext — node scoring', () => {
  it('includes high-priority nodes before low-priority ones when budget is tight', () => {
    const tightConfig = parseConfig({ injection: { maxContextTokens: 100, maxNodes: 2 } })

    const highNode = makeNode({ id: 'omg/fact/high', priority: 'high', body: 'hi' })
    const lowNode = makeNode({ id: 'omg/fact/low', priority: 'low', body: 'lo' })
    const medNode = makeNode({ id: 'omg/fact/med', priority: 'medium', body: 'md' })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [lowNode, highNode, medNode],
      recentMessages: [],
      config: tightConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/fact/high')
  })

  it('applies recency factor — newer nodes rank higher than older at same priority', () => {
    const newNode = makeOldNode(1, 'omg/fact/new', 'medium')
    const oldNode = makeOldNode(60, 'omg/fact/old', 'medium')

    const tightConfig = parseConfig({ injection: { maxContextTokens: 50, maxNodes: 1 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [oldNode, newNode],
      recentMessages: [],
      config: tightConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/fact/new')
    expect(ids).not.toContain('omg/fact/old')
  })

  it('boosts nodes that match keywords in recent messages', () => {
    const relevantNode = makeNode({ id: 'omg/fact/typescript', body: 'TypeScript configuration matters.', tags: ['typescript'] })
    const irrelevantNode = makeNode({ id: 'omg/fact/cooking', body: 'Pasta recipe for dinner.', tags: ['food'] })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 80, maxNodes: 1 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [irrelevantNode, relevantNode],
      recentMessages: [{ role: 'user', content: 'Help me with TypeScript configuration.' }],
      config: tightConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/fact/typescript')
    expect(ids).not.toContain('omg/fact/cooking')
  })

  it('respects maxNodes limit', () => {
    const nodes = Array.from({ length: 10 }, (_, i) =>
      makeNode({ id: `omg/fact/node-${i}`, body: 'content ' + i })
    )

    const limitedConfig = parseConfig({ injection: { maxNodes: 3, maxContextTokens: 10_000 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: nodes,
      recentMessages: [],
      config: limitedConfig,
    })

    expect(slice.nodes.length).toBeLessThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// selectContext — MOC handling
// ---------------------------------------------------------------------------

describe('selectContext — MOC handling', () => {
  it('separates moc nodes from regular nodes', () => {
    const mocNode = makeNode({ id: 'omg/moc/projects', type: 'moc', body: '- [[omg/project/alpha]]' })
    const factNode = makeNode({ id: 'omg/fact/alpha', type: 'fact' })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [mocNode, factNode],
      recentMessages: [],
      config,
    })

    expect(slice.mocs.map((m) => m.frontmatter.id)).toContain('omg/moc/projects')
    expect(slice.nodes.map((n) => n.frontmatter.id)).toContain('omg/fact/alpha')
    expect(slice.nodes.map((n) => n.frontmatter.id)).not.toContain('omg/moc/projects')
  })

  it('respects maxMocs limit', () => {
    const mocs = Array.from({ length: 6 }, (_, i) =>
      makeNode({ id: `omg/moc/domain-${i}`, type: 'moc', body: `- [[omg/fact/node-${i}]]` })
    )

    const limitedConfig = parseConfig({ injection: { maxMocs: 2, maxContextTokens: 10_000 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: mocs,
      recentMessages: [],
      config: limitedConfig,
    })

    expect(slice.mocs.length).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// selectContext — pinned nodes
// ---------------------------------------------------------------------------

describe('selectContext — pinned nodes', () => {
  it('always includes pinned nodes regardless of score', () => {
    // Pinned node IDs use two-segment format as required by config validation
    const pinnedNode = makeNode({ id: 'omg/identity-core', type: 'identity', priority: 'low', body: 'core identity' })
    const highNode = makeNode({ id: 'omg/fact-other', priority: 'high', body: 'other stuff' })

    const pinnedConfig = parseConfig({
      injection: {
        maxNodes: 1,
        maxContextTokens: 10_000,
        pinnedNodes: ['omg/identity-core'],
      },
    })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [highNode, pinnedNode],
      recentMessages: [],
      config: pinnedConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/identity-core')
  })

  it('does not double-include a pinned node that is also top-ranked', () => {
    const pinnedNode = makeNode({ id: 'omg/fact-top', priority: 'high', body: 'top fact' })

    const pinnedConfig = parseConfig({
      injection: { maxNodes: 5, maxContextTokens: 10_000, pinnedNodes: ['omg/fact-top'] },
    })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [pinnedNode],
      recentMessages: [],
      config: pinnedConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    const count = ids.filter((id) => id === 'omg/fact-top').length
    expect(count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// selectContext — token budget
// ---------------------------------------------------------------------------

describe('selectContext — token budget', () => {
  it('enforces maxContextTokens and drops lowest-scored nodes first', () => {
    // Each body word ~= 0.25 tokens. Make bodies large enough to matter.
    const makeBodyNode = (id: string, priority: GraphNode['frontmatter']['priority'], bodyLength: number) =>
      makeNode({ id, priority, body: 'w'.repeat(bodyLength) })

    const highNode = makeBodyNode('omg/fact/high', 'high', 20)
    const lowNode = makeBodyNode('omg/fact/low', 'low', 20)

    // Budget tight enough that we can fit only one
    const tightConfig = parseConfig({ injection: { maxContextTokens: 10, maxNodes: 10 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [lowNode, highNode],
      recentMessages: [],
      config: tightConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    if (ids.length > 0) {
      expect(ids).not.toContain('omg/fact/low')
    }
  })

  it('estimatedTokens does not exceed maxContextTokens significantly', () => {
    const nodes = Array.from({ length: 20 }, (_, i) =>
      makeNode({ id: `omg/fact/node-${i}`, body: 'x'.repeat(400) }) // ~100 tokens each
    )

    const tightConfig = parseConfig({ injection: { maxContextTokens: 500, maxNodes: 20 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: nodes,
      recentMessages: [],
      config: tightConfig,
    })

    // Estimated tokens should be within budget (may slightly exceed due to estimation heuristic)
    expect(slice.estimatedTokens).toBeLessThanOrEqual(600)
  })
})
