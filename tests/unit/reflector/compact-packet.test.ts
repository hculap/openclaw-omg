import { describe, it, expect } from 'vitest'
import { buildCompactPacket, serializeCompactPackets } from '../../../src/reflector/compact-packet.js'
import type { GraphNode } from '../../../src/types.js'

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    frontmatter: {
      id: 'omg/preference/dark-mode',
      description: 'User prefers dark mode',
      type: 'preference',
      priority: 'medium',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      canonicalKey: 'preferences.dark-mode',
      links: ['omg/moc-preferences', 'omg/preference/editor'],
      tags: ['editor', 'theme'],
      ...overrides.frontmatter,
    },
    body: overrides.body ?? 'The user prefers dark mode.\n\nThis applies to all editors.',
    filePath: overrides.filePath ?? '/test/node.md',
  }
}

describe('buildCompactPacket', () => {
  it('extracts canonicalKey from frontmatter', () => {
    const packet = buildCompactPacket(makeNode())
    expect(packet.canonicalKey).toBe('preferences.dark-mode')
  })

  it('falls back to id when no canonicalKey', () => {
    const node: GraphNode = {
      frontmatter: {
        id: 'omg/fact/test',
        description: 'test',
        type: 'fact',
        priority: 'low',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      },
      body: 'Just a body.',
      filePath: '/test/node.md',
    }
    const packet = buildCompactPacket(node)
    expect(packet.canonicalKey).toBe('omg/fact/test')
  })

  it('extracts summary lines from body', () => {
    const packet = buildCompactPacket(makeNode({
      body: 'Line 1\nLine 2\nLine 3\n\nLine 4',
    }))
    expect(packet.summaryLines).toEqual(['Line 1', 'Line 2', 'Line 3', 'Line 4'])
  })

  it('limits summary to 10 lines', () => {
    const body = Array.from({ length: 20 }, (_, i) => `Line ${i + 1}`).join('\n')
    const packet = buildCompactPacket(makeNode({ body }))
    expect(packet.summaryLines).toHaveLength(10)
  })

  it('extracts recent updates from ## Updates section', () => {
    const body = `## Summary\nSome content.\n\n## Updates\n- Update 1\n- Update 2\n- Update 3\n- Update 4\n\n## End`
    const packet = buildCompactPacket(makeNode({ body }))
    expect(packet.recentUpdates).toEqual(['- Update 2', '- Update 3', '- Update 4'])
  })

  it('returns empty recentUpdates when no Updates section', () => {
    const packet = buildCompactPacket(makeNode({ body: 'Just a body.' }))
    expect(packet.recentUpdates).toEqual([])
  })

  it('limits key links to 5', () => {
    const links = Array.from({ length: 10 }, (_, i) => `omg/link-${i}`)
    const packet = buildCompactPacket(makeNode({
      frontmatter: {
        id: 'omg/test',
        description: 'test',
        type: 'fact',
        priority: 'low',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
        links,
      },
    }))
    expect(packet.keyLinks).toHaveLength(5)
  })
})

describe('serializeCompactPackets', () => {
  it('serializes packets with descriptions and links', () => {
    const packets = [
      buildCompactPacket(makeNode()),
    ]
    const result = serializeCompactPackets(packets)
    expect(result).toContain('preferences.dark-mode')
    expect(result).toContain('User prefers dark mode')
    expect(result).toContain('omg/moc-preferences')
  })

  it('separates multiple packets with dividers', () => {
    const packets = [
      buildCompactPacket(makeNode()),
      buildCompactPacket(makeNode({
        frontmatter: {
          id: 'omg/fact/test',
          description: 'Test fact',
          type: 'fact',
          priority: 'low',
          created: '2026-01-01T00:00:00Z',
          updated: '2026-01-01T00:00:00Z',
        },
        body: 'Fact body.',
      })),
    ]
    const result = serializeCompactPackets(packets)
    expect(result).toContain('---')
  })

  it('returns empty string for empty array', () => {
    expect(serializeCompactPackets([])).toBe('')
  })
})
