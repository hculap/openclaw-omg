import { describe, it, expect, vi } from 'vitest'
import { buildReflectionClusters } from '../../../src/reflector/cluster-orchestrator.js'
import { parseConfig } from '../../../src/config.js'
import type { RegistryNodeEntry } from '../../../src/graph/registry.js'
import type { GraphNode } from '../../../src/types.js'

function makeEntry(
  updated: string,
  overrides: Partial<RegistryNodeEntry> = {},
): RegistryNodeEntry {
  return {
    type: 'fact',
    kind: 'observation',
    description: 'Test entry',
    priority: 'medium',
    created: '2026-01-01T00:00:00Z',
    updated,
    filePath: `/test/nodes/${updated.slice(0, 10)}.md`,
    ...overrides,
  }
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    reflection: {
      clustering: {
        enabled: true,
        windowSpanDays: 7,
        maxNodesPerCluster: 25,
        maxInputTokensPerCluster: 8000,
        enableAnchorSplit: false,
        ...overrides,
      },
    },
  })
}

function makeNode(id: string, body = 'test body'): GraphNode {
  return {
    frontmatter: {
      id,
      description: `Node ${id}`,
      type: 'fact',
      priority: 'medium',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    },
    body,
    filePath: `/test/${id}.md`,
  }
}

describe('buildReflectionClusters', () => {
  it('returns empty array for empty entries', async () => {
    const result = await buildReflectionClusters([], makeConfig(), vi.fn())
    expect(result).toEqual([])
  })

  it('creates clusters grouped by domain', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['id1', makeEntry('2026-01-01T00:00:00Z', { links: ['omg/moc-preferences'] })],
      ['id2', makeEntry('2026-01-02T00:00:00Z', { links: ['omg/moc-preferences'] })],
      ['id3', makeEntry('2026-01-01T00:00:00Z', { canonicalKey: 'identity.name' })],
    ]

    const hydrateNode = vi.fn().mockImplementation((filePath: string) => {
      const id = filePath.split('/').pop()?.replace('.md', '') ?? 'unknown'
      return Promise.resolve(makeNode(id))
    })

    const clusters = await buildReflectionClusters(entries, makeConfig(), hydrateNode)

    const domains = clusters.map((c) => c.domain)
    expect(domains).toContain('preferences')
    expect(domains).toContain('identity')
  })

  it('produces compact packets for each node', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['id1', makeEntry('2026-01-01T00:00:00Z')],
    ]

    const hydrateNode = vi.fn().mockResolvedValue(makeNode('id1', 'some body content'))

    const clusters = await buildReflectionClusters(entries, makeConfig(), hydrateNode)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.compactPackets).toHaveLength(1)
    expect(clusters[0]!.compactPackets[0]!.description).toBe('Node id1')
  })

  it('skips nodes that fail hydration', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['id1', makeEntry('2026-01-01T00:00:00Z')],
      ['id2', makeEntry('2026-01-02T00:00:00Z')],
    ]

    const hydrateNode = vi.fn()
      .mockResolvedValueOnce(makeNode('id1'))
      .mockResolvedValueOnce(null) // id2 fails

    const clusters = await buildReflectionClusters(entries, makeConfig(), hydrateNode)

    expect(clusters).toHaveLength(1)
    expect(clusters[0]!.nodes).toHaveLength(1)
  })

  it('drops clusters where all hydrations fail', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['id1', makeEntry('2026-01-01T00:00:00Z')],
    ]

    const hydrateNode = vi.fn().mockResolvedValue(null)

    const clusters = await buildReflectionClusters(entries, makeConfig(), hydrateNode)
    expect(clusters).toEqual([])
  })

  it('uses anchor split when enabled', async () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['id1', makeEntry('2026-01-01T00:00:00Z', { links: ['omg/anchor'] })],
      ['id2', makeEntry('2026-01-02T00:00:00Z', { links: ['omg/anchor'] })],
      ['id3', makeEntry('2026-01-03T00:00:00Z')],
    ]

    const hydrateNode = vi.fn().mockImplementation((_: string) =>
      Promise.resolve(makeNode('test'))
    )

    const config = makeConfig({ enableAnchorSplit: true })
    const clusters = await buildReflectionClusters(entries, config, hydrateNode)

    // Should have at least 1 cluster (anchor split only splits oversized clusters)
    expect(clusters.length).toBeGreaterThanOrEqual(1)
  })
})
