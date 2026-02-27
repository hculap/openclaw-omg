import { describe, it, expect } from 'vitest'
import { buildReflectorSystemPrompt, buildReflectorUserPrompt } from '../../src/reflector/prompts.js'
import type { GraphNode } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<GraphNode['frontmatter']> = {}): GraphNode {
  return {
    frontmatter: {
      id: 'omg/preference/dark-mode',
      description: 'User prefers dark mode',
      type: 'preference',
      priority: 'high',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
      ...overrides,
    },
    body: 'The user prefers dark mode in all editors.',
    filePath: '/workspace/memory/omg/nodes/preference/preference-dark-mode-2026-01-01.md',
  }
}

// ---------------------------------------------------------------------------
// System prompt tests
// ---------------------------------------------------------------------------

describe('buildReflectorSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(100)
  })

  it('contains all four compression levels in the table', () => {
    const prompt = buildReflectorSystemPrompt()
    // Each level appears as a row — check for the level number followed by whitespace/pipe
    expect(prompt).toMatch(/\|\s*0\s*\|/)
    expect(prompt).toMatch(/\|\s*1\s*\|/)
    expect(prompt).toMatch(/\|\s*2\s*\|/)
    expect(prompt).toMatch(/\|\s*3\s*\|/)
  })

  it('mentions all four XML output sections', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt).toContain('<reflection-nodes>')
    expect(prompt).toContain('<archive-nodes>')
    expect(prompt).toContain('<moc-updates>')
    expect(prompt).toContain('<node-updates>')
  })

  it('includes the reflection XML root element', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt).toContain('<reflection>')
    expect(prompt).toContain('</reflection>')
  })

  it('describes the memory curator role', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt.toLowerCase()).toContain('memory curator')
  })

  it('includes rules about preserving user assertions', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt.toLowerCase()).toContain('preserve user assertions')
  })

  it('mentions the reflections domain in MOC update guidance', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt).toContain('reflections')
  })

  it('is deterministic — returns same string on multiple calls', () => {
    expect(buildReflectorSystemPrompt()).toBe(buildReflectorSystemPrompt())
  })

  it('includes <tags> element in the XML schema', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt).toContain('<tags>')
  })

  it('includes bilingual tag instruction with 10–14 count requirement', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt).toContain('Bilingual tags (10–14 required)')
    expect(prompt).toContain('Never monolingual')
  })

  it('few-shot example contains non-English tags', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt).toContain('preferencje')
    expect(prompt).toContain('edytor')
  })

  it('field reference documents <tags>', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt).toContain('comma-separated bilingual keyword list')
  })

  it('includes ID specificity rule with BAD/GOOD examples', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt).toContain('Specific IDs')
    expect(prompt).toContain('BAD:')
    expect(prompt).toContain('GOOD:')
  })

  it('includes bilingual description rule', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt).toContain('Bilingual descriptions')
    expect(prompt).toContain('tłumaczenie w języku użytkownika')
  })

  it('includes body structure rule with TL;DR', () => {
    const prompt = buildReflectorSystemPrompt()
    expect(prompt).toContain('Body structure')
    expect(prompt).toContain('TL;DR')
  })

  it('few-shot example has >= 10 tags', () => {
    const prompt = buildReflectorSystemPrompt()
    const tagMatch = prompt.match(/<tags>([^<]+)<\/tags>/)
    expect(tagMatch).not.toBeNull()
    const tags = tagMatch![1]!.split(',').map(t => t.trim()).filter(Boolean)
    expect(tags.length).toBeGreaterThanOrEqual(10)
  })

  it('few-shot example description is bilingual with separator', () => {
    const prompt = buildReflectorSystemPrompt()
    // The description in the example should contain " — " separator
    expect(prompt).toContain('Przepływ pracy CLI')
  })
})

// ---------------------------------------------------------------------------
// User prompt tests
// ---------------------------------------------------------------------------

describe('buildReflectorUserPrompt', () => {
  it('includes the compression level in the output', () => {
    const prompt = buildReflectorUserPrompt({ nodes: [], compressionLevel: 2 })
    expect(prompt).toContain('2')
  })

  it('includes node body content when nodes are provided', () => {
    const node = makeNode()
    const prompt = buildReflectorUserPrompt({ nodes: [node], compressionLevel: 0 })
    expect(prompt).toContain('The user prefers dark mode in all editors.')
  })

  it('includes node ID in the serialized frontmatter', () => {
    const node = makeNode({ id: 'omg/preference/dark-mode' })
    const prompt = buildReflectorUserPrompt({ nodes: [node], compressionLevel: 1 })
    expect(prompt).toContain('omg/preference/dark-mode')
  })

  it('includes node description in the serialized frontmatter', () => {
    const node = makeNode({ description: 'User prefers dark mode' })
    const prompt = buildReflectorUserPrompt({ nodes: [node], compressionLevel: 0 })
    expect(prompt).toContain('User prefers dark mode')
  })

  it('indicates "(none)" when no nodes are provided', () => {
    const prompt = buildReflectorUserPrompt({ nodes: [], compressionLevel: 0 })
    expect(prompt).toContain('(none)')
  })

  it('includes existing MOC index when provided', () => {
    const prompt = buildReflectorUserPrompt({
      nodes: [],
      compressionLevel: 0,
      existingMocIndex: '## Reflections\n- [[omg/reflection/old-insight]]',
    })
    expect(prompt).toContain('omg/reflection/old-insight')
  })

  it('omits the MOC index section when existingMocIndex is undefined', () => {
    const prompt = buildReflectorUserPrompt({ nodes: [], compressionLevel: 0 })
    expect(prompt).not.toContain('Existing MOC Index')
  })

  it('omits the MOC index section when existingMocIndex is empty/whitespace', () => {
    const prompt = buildReflectorUserPrompt({
      nodes: [],
      compressionLevel: 0,
      existingMocIndex: '   ',
    })
    expect(prompt).not.toContain('Existing MOC Index')
  })

  it('serializes multiple nodes as separate fenced blocks', () => {
    const node1 = makeNode({ id: 'omg/preference/dark-mode' })
    const node2 = makeNode({ id: 'omg/fact/node-js-version', description: 'Node.js version used' })
    const prompt = buildReflectorUserPrompt({ nodes: [node1, node2], compressionLevel: 1 })
    expect(prompt).toContain('omg/preference/dark-mode')
    expect(prompt).toContain('omg/fact/node-js-version')
    // Both should be in fenced code blocks
    const fenceCount = (prompt.match(/```/g) ?? []).length
    expect(fenceCount).toBe(4) // 2 opening + 2 closing
  })

  it('wraps each node in markdown code fences', () => {
    const node = makeNode()
    const prompt = buildReflectorUserPrompt({ nodes: [node], compressionLevel: 0 })
    expect(prompt).toContain('```markdown')
    expect(prompt).toContain('```')
  })

  it('includes the compression level header section', () => {
    const prompt = buildReflectorUserPrompt({ nodes: [], compressionLevel: 3 })
    expect(prompt).toContain('## Compression Level')
    expect(prompt).toContain('3')
  })
})
