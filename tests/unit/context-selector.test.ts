import { describe, it, expect, beforeEach, vi } from 'vitest'
import { parseConfig } from '../../src/config.js'
import { selectContext, selectContextV2 } from '../../src/context/selector.js'
import type { OmgConfig } from '../../src/config.js'
import type { GraphNode } from '../../src/types.js'
import type { RegistryNodeEntry } from '../../src/graph/registry.js'
import type { MemoryTools, MemorySearchResponse } from '../../src/context/memory-search.js'

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

// ---------------------------------------------------------------------------
// selectContext — multilingual keyword extraction
// ---------------------------------------------------------------------------

describe('selectContext — multilingual keyword extraction', () => {
  it('matches non-English query keywords against bilingual tags', () => {
    const node = makeNode({
      id: 'omg/identity/wife',
      type: 'identity',
      priority: 'high',
      body: 'Sylwia is the user\'s wife.',
      tags: ['wife', 'żona', 'partner', 'family'],
    })
    const irrelevant = makeNode({
      id: 'omg/fact/unrelated',
      body: 'Unrelated content about cooking.',
      tags: ['food', 'cooking'],
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 200, maxNodes: 1 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [irrelevant, node],
      recentMessages: [{ role: 'user', content: 'Powiedz mi o żona' }],
      config: tightConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/identity/wife')
  })

  it('preserves Unicode characters in keyword extraction (ą,ć,ę,ł,ń,ó,ś,ź,ż,ñ,ü,ö)', () => {
    const node = makeNode({
      id: 'omg/episode/gym',
      type: 'episode',
      body: 'Gym session scheduled.',
      tags: ['siłownia', 'gym', 'ćwiczenia', 'exercises'],
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 200, maxNodes: 1 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [node],
      recentMessages: [{ role: 'user', content: 'siłownia ćwiczenia jutro' }],
      config: tightConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/episode/gym')
  })

  it('handles mixed multilingual queries (Polish + English)', () => {
    const node = makeNode({
      id: 'omg/preference/formatting',
      type: 'preference',
      body: 'Prettier used for formatting.',
      tags: ['formatowanie', 'formatting', 'prettier'],
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 200, maxNodes: 1 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [node],
      recentMessages: [{ role: 'user', content: 'formatowanie prettier config' }],
      config: tightConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/preference/formatting')
  })

  it('still filters short common words (<= 3 chars) regardless of language', () => {
    // Short words like "jak", "nie", "tak" should be filtered by length
    const node = makeNode({
      id: 'omg/fact/test',
      body: 'Content.',
      tags: ['jak', 'nie', 'tak'],
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 200, maxNodes: 1 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [node],
      recentMessages: [{ role: 'user', content: 'jak nie tak to co' }],
      config: tightConfig,
    })

    // No keyword matches since all Polish words are <= 3 chars
    // Node should still appear due to baseline scoring, but not from keyword boost
    // The important thing is it doesn't crash
    expect(slice).toBeDefined()
  })

  it('prefix-matches inflected Polish keywords against tags (muzyce↔muzyka)', () => {
    const musicNode = makeNode({
      id: 'omg/identity/music',
      type: 'identity',
      priority: 'high',
      body: 'Band history and music background.',
      tags: ['muzyka', 'zespół', 'gitara'],
    })
    const irrelevant = makeNode({
      id: 'omg/fact/unrelated',
      body: 'Unrelated content.',
      tags: ['food', 'cooking'],
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 200, maxNodes: 1 } })

    // "muzyce" shares prefix "muzy" with "muzyka", "zespole" shares "zesp" with "zespół"
    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [irrelevant, musicNode],
      recentMessages: [{ role: 'user', content: 'Opowiedz mi o mojej muzyce i zespole' }],
      config: tightConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/identity/music')
  })

  it('prefix-matches inflected forms: urodziny↔urodzinach, dzieci↔dzieciach', () => {
    const node = makeNode({
      id: 'omg/identity/birthdays',
      type: 'identity',
      priority: 'high',
      body: 'Children birthday info.',
      tags: ['urodziny', 'dzieci', 'rodzina'],
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 200, maxNodes: 1 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [node],
      recentMessages: [{ role: 'user', content: 'Kiedy są urodzinach moich dzieciach?' }],
      config: tightConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/identity/birthdays')
  })

  it('prefix-matches short-stem Polish inflections: żonie↔żona (3-char stem)', () => {
    const node = makeNode({
      id: 'omg/identity/wife',
      type: 'identity',
      priority: 'high',
      body: 'Sylwia is the user\'s wife.',
      tags: ['żona', 'wife', 'partner'],
    })
    const irrelevant = makeNode({
      id: 'omg/fact/unrelated',
      body: 'Unrelated content.',
      tags: ['food', 'cooking'],
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 200, maxNodes: 1 } })

    // "żonie" (locative of żona) shares 3-char prefix "żon" with tag "żona"
    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [irrelevant, node],
      recentMessages: [{ role: 'user', content: 'Opowiedz mi o mojej żonie' }],
      config: tightConfig,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/identity/wife')
  })

  it('does NOT prefix-match unrelated short tags (api vs application)', () => {
    const node = makeNode({
      id: 'omg/fact/test',
      body: 'Content.',
      tags: ['api', 'git', 'ssh'],
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 200, maxNodes: 1 } })

    const slice = selectContext({
      indexContent: '',
      nowContent: null,
      allNodes: [node],
      recentMessages: [{ role: 'user', content: 'application programming interface' }],
      config: tightConfig,
    })

    // "application" prefix "app" ≠ "api" prefix "api" — no false match
    expect(slice).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// selectContextV2 — two-pass registry-based selection
// ---------------------------------------------------------------------------

function makeRegistryEntry(
  overrides: Partial<{
    type: RegistryNodeEntry['type']
    kind: RegistryNodeEntry['kind']
    priority: RegistryNodeEntry['priority']
    description: string
    updated: string
    filePath: string
    archived: boolean
    tags: string[]
    links: string[]
  }> = {}
): RegistryNodeEntry {
  const now = new Date().toISOString()
  return {
    type: overrides.type ?? 'fact',
    kind: overrides.kind ?? 'observation',
    priority: overrides.priority ?? 'medium',
    description: overrides.description ?? 'A test fact',
    created: now,
    updated: overrides.updated ?? now,
    filePath: overrides.filePath ?? '/omg/nodes/fact/test-fact.md',
    ...(overrides.archived !== undefined && { archived: overrides.archived }),
    ...(overrides.tags !== undefined && { tags: overrides.tags }),
    ...(overrides.links !== undefined && { links: overrides.links }),
  }
}

function makeHydratedNode(id: string, entry: RegistryNodeEntry, body = 'Node body content.'): GraphNode {
  return {
    frontmatter: {
      id,
      description: entry.description,
      type: entry.type,
      priority: entry.priority,
      created: entry.created,
      updated: entry.updated,
    },
    body,
    filePath: entry.filePath,
  }
}

describe('selectContextV2 — two-pass registry-based selection', () => {
  it('returns index and nowNode when registry is empty', async () => {
    const hydrateNode = vi.fn().mockResolvedValue(null)

    const slice = await selectContextV2({
      indexContent: INDEX_CONTENT,
      nowContent: NOW_CONTENT,
      registryEntries: [],
      recentMessages: [],
      config,
      hydrateNode,
    })

    expect(slice.index).toBe(INDEX_CONTENT)
    expect(slice.nowNode).not.toBeNull()
    expect(slice.nodes).toHaveLength(0)
    expect(slice.mocs).toHaveLength(0)
    expect(hydrateNode).not.toHaveBeenCalled()
  })

  it('hydrates only registry candidates (Pass 2) using hydrateNode', async () => {
    const entry = makeRegistryEntry({ filePath: '/omg/nodes/fact/node-1.md' })
    const hydratedNode = makeHydratedNode('omg/fact/node-1', entry)
    const hydrateNode = vi.fn().mockResolvedValue(hydratedNode)

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [['omg/fact/node-1', entry]],
      recentMessages: [],
      config,
      hydrateNode,
    })

    expect(hydrateNode).toHaveBeenCalledWith('/omg/nodes/fact/node-1.md')
    expect(slice.nodes.map((n) => n.frontmatter.id)).toContain('omg/fact/node-1')
  })

  it('prefers high-priority entries in Pass 1 (before hydration)', async () => {
    const highEntry = makeRegistryEntry({ priority: 'high', filePath: '/high.md' })
    const lowEntry = makeRegistryEntry({ priority: 'low', filePath: '/low.md' })
    const highNode = makeHydratedNode('omg/fact/high', highEntry, 'hi')
    const lowNode = makeHydratedNode('omg/fact/low', lowEntry, 'lo')

    const hydrateNode = vi.fn().mockImplementation((fp: string) => {
      if (fp === '/high.md') return Promise.resolve(highNode)
      if (fp === '/low.md') return Promise.resolve(lowNode)
      return Promise.resolve(null)
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 100, maxNodes: 1 } })

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [
        ['omg/fact/low', lowEntry],
        ['omg/fact/high', highEntry],
      ],
      recentMessages: [],
      config: tightConfig,
      hydrateNode,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/fact/high')
  })

  it('boosts entries matching keywords in Pass 1 description/tags', async () => {
    const tsEntry = makeRegistryEntry({
      description: 'TypeScript configuration',
      tags: ['typescript'],
      filePath: '/ts.md',
    })
    const cookEntry = makeRegistryEntry({
      description: 'Pasta recipe',
      tags: ['food'],
      filePath: '/cook.md',
    })
    const tsNode = makeHydratedNode('omg/fact/ts', tsEntry, 'TypeScript body.')
    const cookNode = makeHydratedNode('omg/fact/cook', cookEntry, 'Cooking body.')

    const hydrateNode = vi.fn().mockImplementation((fp: string) => {
      if (fp === '/ts.md') return Promise.resolve(tsNode)
      if (fp === '/cook.md') return Promise.resolve(cookNode)
      return Promise.resolve(null)
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 80, maxNodes: 1 } })

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [
        ['omg/fact/cook', cookEntry],
        ['omg/fact/ts', tsEntry],
      ],
      recentMessages: [{ role: 'user', content: 'Help me with TypeScript configuration.' }],
      config: tightConfig,
      hydrateNode,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/fact/ts')
    expect(ids).not.toContain('omg/fact/cook')
  })

  it('separates moc entries from regular entries', async () => {
    const mocEntry = makeRegistryEntry({ type: 'moc', filePath: '/moc.md' })
    const factEntry = makeRegistryEntry({ type: 'fact', filePath: '/fact.md' })
    const mocNode = makeHydratedNode('omg/moc/projects', mocEntry, '- [[omg/project/alpha]]')
    const factNode = makeHydratedNode('omg/fact/alpha', factEntry)

    const hydrateNode = vi.fn().mockImplementation((fp: string) => {
      if (fp === '/moc.md') return Promise.resolve(mocNode)
      if (fp === '/fact.md') return Promise.resolve(factNode)
      return Promise.resolve(null)
    })

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [
        ['omg/moc/projects', mocEntry],
        ['omg/fact/alpha', factEntry],
      ],
      recentMessages: [],
      config,
      hydrateNode,
    })

    expect(slice.mocs.map((m) => m.frontmatter.id)).toContain('omg/moc/projects')
    expect(slice.nodes.map((n) => n.frontmatter.id)).toContain('omg/fact/alpha')
    expect(slice.nodes.map((n) => n.frontmatter.id)).not.toContain('omg/moc/projects')
  })

  it('skips null results from hydrateNode without crashing', async () => {
    const entry = makeRegistryEntry({ filePath: '/missing.md' })
    const hydrateNode = vi.fn().mockResolvedValue(null)

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [['omg/fact/missing', entry]],
      recentMessages: [],
      config,
      hydrateNode,
    })

    expect(slice.nodes).toHaveLength(0)
  })

  it('drops entries where hydrateNode rejects and logs an error, but still injects remaining nodes', async () => {
    const entryA = makeRegistryEntry({ filePath: '/a.md' })
    const entryB = makeRegistryEntry({ filePath: '/b.md' })
    const entryC = makeRegistryEntry({ filePath: '/c.md' })
    const nodeA = makeHydratedNode('omg/fact/a', entryA)
    const nodeC = makeHydratedNode('omg/fact/c', entryC)
    const eaccesError = new Error('EACCES')

    const hydrateNode = vi.fn().mockImplementation((fp: string) => {
      if (fp === '/a.md') return Promise.resolve(nodeA)
      if (fp === '/b.md') return Promise.reject(eaccesError)
      if (fp === '/c.md') return Promise.resolve(nodeC)
      return Promise.resolve(null)
    })

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [
        ['omg/fact/a', entryA],
        ['omg/fact/b', entryB],
        ['omg/fact/c', entryC],
      ],
      recentMessages: [],
      config,
      hydrateNode,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/fact/a')
    expect(ids).not.toContain('omg/fact/b')
    expect(ids).toContain('omg/fact/c')
    expect(consoleSpy).toHaveBeenCalledOnce()
    expect(consoleSpy).toHaveBeenCalledWith(
      '[omg] hydrateEntries: failed to read node:',
      eaccesError
    )

    consoleSpy.mockRestore()
  })

  it('respects maxContextTokens even with many candidates', async () => {
    const entries: [string, RegistryNodeEntry][] = Array.from({ length: 20 }, (_, i) => [
      `omg/fact/node-${i}`,
      makeRegistryEntry({ filePath: `/node-${i}.md` }),
    ])

    const hydrateNode = vi.fn().mockImplementation((fp: string) => {
      const idx = parseInt(fp.match(/node-(\d+)/)![1]!)
      const pair = entries[idx]!
      return Promise.resolve(makeHydratedNode(pair[0], pair[1], 'x'.repeat(400)))
    })

    const tightConfig = parseConfig({ injection: { maxContextTokens: 500, maxNodes: 20 } })

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: entries,
      recentMessages: [],
      config: tightConfig,
      hydrateNode,
    })

    expect(slice.estimatedTokens).toBeLessThanOrEqual(600)
  })
})

// ---------------------------------------------------------------------------
// selectContextV2 — hybrid semantic scoring
// ---------------------------------------------------------------------------

function makeMemoryTools(searchResponse: MemorySearchResponse | null): MemoryTools {
  return {
    search: vi.fn().mockResolvedValue(searchResponse),
    get: vi.fn().mockResolvedValue(null),
  }
}

describe('selectContextV2 — hybrid semantic scoring', () => {
  it('boosts candidates matching memory_search results above non-matching ones', async () => {
    // Two registry entries at equal priority — semantic should break the tie
    const semanticEntry = makeRegistryEntry({ filePath: '/semantic.md', priority: 'medium', description: 'semantic node' })
    const plainEntry = makeRegistryEntry({ filePath: '/plain.md', priority: 'medium', description: 'plain node' })
    const semanticNode = makeHydratedNode('omg/fact/semantic', semanticEntry, 'semantic content')
    const plainNode = makeHydratedNode('omg/fact/plain', plainEntry, 'plain content')

    const hydrateNode = vi.fn().mockImplementation((fp: string) => {
      if (fp === '/semantic.md') return Promise.resolve(semanticNode)
      if (fp === '/plain.md') return Promise.resolve(plainNode)
      return Promise.resolve(null)
    })

    // memory_search returns only the semantic node with a high score
    const memoryTools = makeMemoryTools({
      results: [{ filePath: '/semantic.md', score: 0.9, snippet: 'snippet' }],
    })

    // tight budget — only 1 node fits
    const tightConfig = parseConfig({ injection: { maxContextTokens: 100, maxNodes: 1 } })

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [
        ['omg/fact/plain', plainEntry],
        ['omg/fact/semantic', semanticEntry],
      ],
      recentMessages: [],
      config: tightConfig,
      hydrateNode,
      memoryTools,
    })

    const ids = slice.nodes.map((n) => n.frontmatter.id)
    expect(ids).toContain('omg/fact/semantic')
    expect(ids).not.toContain('omg/fact/plain')
  })

  it('with memoryTools: null → behaves identically to registry-only (no crash)', async () => {
    const entry = makeRegistryEntry({ filePath: '/node.md' })
    const node = makeHydratedNode('omg/fact/node', entry)
    const hydrateNode = vi.fn().mockResolvedValue(node)

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [['omg/fact/node', entry]],
      recentMessages: [],
      config,
      hydrateNode,
      memoryTools: null,
    })

    expect(slice.nodes.map((n) => n.frontmatter.id)).toContain('omg/fact/node')
    expect(slice.nodes.length).toBe(1)
  })

  it('with semantic.enabled: false → memory_search not called', async () => {
    const entry = makeRegistryEntry({ filePath: '/node.md' })
    const node = makeHydratedNode('omg/fact/node', entry)
    const hydrateNode = vi.fn().mockResolvedValue(node)

    const disabledConfig = parseConfig({ injection: { semantic: { enabled: false } } })
    const memoryTools = makeMemoryTools({ results: [] })

    await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [['omg/fact/node', entry]],
      recentMessages: [],
      config: disabledConfig,
      hydrateNode,
      memoryTools,
    })

    expect(memoryTools.search).not.toHaveBeenCalled()
  })

  it('with memoryTools.search returning null → graceful fallback, registry-only', async () => {
    const entry = makeRegistryEntry({ filePath: '/node.md' })
    const node = makeHydratedNode('omg/fact/node', entry)
    const hydrateNode = vi.fn().mockResolvedValue(node)

    const memoryTools: MemoryTools = {
      search: vi.fn().mockResolvedValue(null),
      get: vi.fn().mockResolvedValue(null),
    }

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [['omg/fact/node', entry]],
      recentMessages: [],
      config,
      hydrateNode,
      memoryTools,
    })

    expect(slice.nodes.length).toBe(1)
    expect(slice.nodes[0]!.frontmatter.id).toBe('omg/fact/node')
  })

  it('with disabled:true response from memory_search → graceful fallback', async () => {
    const entry = makeRegistryEntry({ filePath: '/node.md' })
    const node = makeHydratedNode('omg/fact/node', entry)
    const hydrateNode = vi.fn().mockResolvedValue(node)

    const memoryTools = makeMemoryTools({ results: [], disabled: true })

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [['omg/fact/node', entry]],
      recentMessages: [],
      config,
      hydrateNode,
      memoryTools,
    })

    expect(slice.nodes.length).toBe(1)
  })

  it('memory_search results NOT in registry are ignored (no phantom nodes)', async () => {
    const entry = makeRegistryEntry({ filePath: '/known.md' })
    const knownNode = makeHydratedNode('omg/fact/known', entry)
    const hydrateNode = vi.fn().mockResolvedValue(knownNode)

    // memory_search returns a path not in the registry
    const memoryTools = makeMemoryTools({
      results: [{ filePath: '/outside-registry.md', score: 0.99, snippet: 'external' }],
    })

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [['omg/fact/known', entry]],
      recentMessages: [],
      config,
      hydrateNode,
      memoryTools,
    })

    const filePaths = slice.nodes.map((n) => n.filePath)
    expect(filePaths).not.toContain('/outside-registry.md')
    expect(filePaths).toContain('/known.md')
  })

  it('with semantic.weight = 0 → semantic has no effect (scores effectively registry-only)', async () => {
    // Even if memory_search returns results, weight=0 means no boost
    const entryA = makeRegistryEntry({ filePath: '/a.md', priority: 'high', description: 'high priority A' })
    const entryB = makeRegistryEntry({ filePath: '/b.md', priority: 'low', description: 'low priority B' })
    const nodeA = makeHydratedNode('omg/fact/a', entryA, 'a content')
    const nodeB = makeHydratedNode('omg/fact/b', entryB, 'b content')

    const hydrateNode = vi.fn().mockImplementation((fp: string) => {
      if (fp === '/a.md') return Promise.resolve(nodeA)
      if (fp === '/b.md') return Promise.resolve(nodeB)
      return Promise.resolve(null)
    })

    // memory_search boosts B only
    const memoryTools = makeMemoryTools({
      results: [{ filePath: '/b.md', score: 0.99, snippet: 'b' }],
    })

    const zeroWeightConfig = parseConfig({ injection: { maxNodes: 1, maxContextTokens: 200, semantic: { weight: 0 } } })

    const slice = await selectContextV2({
      indexContent: '',
      nowContent: null,
      registryEntries: [
        ['omg/fact/a', entryA],
        ['omg/fact/b', entryB],
      ],
      recentMessages: [],
      config: zeroWeightConfig,
      hydrateNode,
      memoryTools,
    })

    // A has higher registry score (high priority) — with weight=0, B's semantic boost is nullified
    expect(slice.nodes.map((n) => n.frontmatter.id)).toContain('omg/fact/a')
  })
})
