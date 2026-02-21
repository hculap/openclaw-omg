import { describe, it, expect } from 'vitest'
import { renderContextBlock } from '../../src/context/renderer.js'
import type { GraphContextSlice, GraphNode } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, body: string, type: GraphNode['frontmatter']['type'] = 'fact'): GraphNode {
  const now = new Date().toISOString()
  return {
    frontmatter: {
      id,
      description: `Description of ${id}`,
      type,
      priority: 'medium',
      created: now,
      updated: now,
    },
    body,
    filePath: `/omg/nodes/${type}/${id}.md`,
  }
}

function makeSlice(overrides: Partial<GraphContextSlice> = {}): GraphContextSlice {
  return {
    index: overrides.index ?? '# Index\n- [[omg/moc-projects]]',
    nowNode: overrides.nowNode ?? null,
    mocs: overrides.mocs ?? [],
    nodes: overrides.nodes ?? [],
    estimatedTokens: overrides.estimatedTokens ?? 100,
  }
}

// ---------------------------------------------------------------------------
// renderContextBlock
// ---------------------------------------------------------------------------

describe('renderContextBlock', () => {
  it('wraps output in <omg-context> tags', () => {
    const result = renderContextBlock(makeSlice())
    expect(result).toMatch(/^<omg-context>/)
    expect(result).toMatch(/<\/omg-context>$/)
  })

  it('includes Memory Index section with index content', () => {
    const slice = makeSlice({ index: '# Index\n- [[omg/moc-projects]]' })
    const result = renderContextBlock(slice)
    expect(result).toContain('## Memory Index')
    expect(result).toContain('# Index')
    expect(result).toContain('[[omg/moc-projects]]')
  })

  it('includes Current State section when nowNode is present', () => {
    const now = makeNode('omg/now', '# Now\nWorking on phase 4.', 'now')
    const slice = makeSlice({ nowNode: now })
    const result = renderContextBlock(slice)
    expect(result).toContain('## Current State')
    expect(result).toContain('Working on phase 4.')
  })

  it('omits Current State section when nowNode is null', () => {
    const slice = makeSlice({ nowNode: null })
    const result = renderContextBlock(slice)
    expect(result).not.toContain('## Current State')
  })

  it('includes Relevant Knowledge section with moc and node content', () => {
    const moc = makeNode('omg/moc/projects', '- [[omg/project/alpha]]', 'moc')
    const node = makeNode('omg/fact/typescript', 'TypeScript is typed JS.', 'fact')
    const slice = makeSlice({ mocs: [moc], nodes: [node] })
    const result = renderContextBlock(slice)
    expect(result).toContain('## Relevant Knowledge')
    expect(result).toContain('omg/moc/projects')
    expect(result).toContain('TypeScript is typed JS.')
  })

  it('omits Relevant Knowledge section when mocs and nodes are both empty', () => {
    const slice = makeSlice({ mocs: [], nodes: [] })
    const result = renderContextBlock(slice)
    expect(result).not.toContain('## Relevant Knowledge')
  })

  it('includes node description in rendered output', () => {
    const node = makeNode('omg/fact/typescript', 'TypeScript is typed JS.', 'fact')
    node.frontmatter
    const slice = makeSlice({ nodes: [node] })
    const result = renderContextBlock(slice)
    expect(result).toContain('Description of omg/fact/typescript')
  })

  it('renders multiple nodes in order', () => {
    const nodeA = makeNode('omg/fact/alpha', 'Alpha content.')
    const nodeB = makeNode('omg/fact/beta', 'Beta content.')
    const slice = makeSlice({ nodes: [nodeA, nodeB] })
    const result = renderContextBlock(slice)
    const posA = result.indexOf('Alpha content.')
    const posB = result.indexOf('Beta content.')
    expect(posA).toBeLessThan(posB)
  })

  it('minimal slice (only index, no now/mocs/nodes) produces valid output', () => {
    const slice = makeSlice({ index: '# Index', mocs: [], nodes: [], nowNode: null })
    const result = renderContextBlock(slice)
    expect(result).toContain('<omg-context>')
    expect(result).toContain('## Memory Index')
    expect(result).not.toContain('## Current State')
    expect(result).not.toContain('## Relevant Knowledge')
  })
})
