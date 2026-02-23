import { describe, it, expect } from 'vitest'
import {
  buildMergeSystemPrompt,
  buildMergeUserPrompt,
  parseMergeOutput,
} from '../../src/observer/merge-prompt.js'
import type { ExtractCandidate, ScoredMergeTarget } from '../../src/types.js'
import type { RegistryNodeEntry } from '../../src/graph/registry.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<ExtractCandidate> = {}): ExtractCandidate {
  return {
    type: 'preference',
    canonicalKey: 'preferences.editor_theme',
    title: 'Editor Theme',
    description: 'User prefers dark mode in editors',
    body: 'The user explicitly prefers dark mode.',
    priority: 'high',
    ...overrides,
  }
}

function makeRegistryEntry(overrides: Partial<RegistryNodeEntry> = {}): RegistryNodeEntry {
  return {
    type: 'preference',
    kind: 'observation',
    description: 'User prefers dark mode in all editors',
    priority: 'high',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    filePath: '/workspace/memory/omg/nodes/preference/preferences-editor-theme.md',
    canonicalKey: 'preferences.editor_theme',
    ...overrides,
  }
}

function makeScoredTarget(
  nodeId: string,
  overrides: Partial<RegistryNodeEntry> = {},
  finalScore = 0.75
): ScoredMergeTarget {
  return {
    nodeId,
    entry: makeRegistryEntry(overrides),
    localScore: finalScore,
    semanticScore: 0,
    finalScore,
  }
}

// ---------------------------------------------------------------------------
// buildMergeSystemPrompt
// ---------------------------------------------------------------------------

describe('buildMergeSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildMergeSystemPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  it('mentions the three decision options', () => {
    const prompt = buildMergeSystemPrompt()
    expect(prompt).toContain('keep_separate')
    expect(prompt).toContain('merge')
    expect(prompt).toContain('alias')
  })

  it('describes the XML output format', () => {
    const prompt = buildMergeSystemPrompt()
    expect(prompt).toContain('merge-decision')
  })

  it('mentions the confidence threshold for merging', () => {
    const prompt = buildMergeSystemPrompt()
    // Should mention some form of confidence/certainty threshold
    expect(prompt).toMatch(/85%|confident|confidence/i)
  })
})

// ---------------------------------------------------------------------------
// buildMergeUserPrompt
// ---------------------------------------------------------------------------

describe('buildMergeUserPrompt', () => {
  it('includes candidate information', () => {
    const candidate = makeCandidate()
    const prompt = buildMergeUserPrompt(candidate, [])
    expect(prompt).toContain('preferences.editor_theme')
    expect(prompt).toContain('User prefers dark mode in editors')
  })

  it('includes neighbor table when neighbors provided', () => {
    const candidate = makeCandidate()
    const neighbors = [makeScoredTarget('omg/preference/preferences-editor-theme')]
    const prompt = buildMergeUserPrompt(candidate, neighbors)
    expect(prompt).toContain('omg/preference/preferences-editor-theme')
  })

  it('truncates long descriptions in the neighbor table', () => {
    const candidate = makeCandidate()
    const longDescription = 'A'.repeat(200)
    const neighbors = [makeScoredTarget('omg/preference/test', { description: longDescription })]
    const prompt = buildMergeUserPrompt(candidate, neighbors)
    // The description should be truncated to 60 chars in the table
    const tableSection = prompt.split('## Existing Nearby Nodes')[1] ?? ''
    expect(tableSection).not.toContain('A'.repeat(200))
  })

  it('includes scores in the table', () => {
    const candidate = makeCandidate()
    const neighbors = [makeScoredTarget('omg/preference/test', {}, 0.75)]
    const prompt = buildMergeUserPrompt(candidate, neighbors)
    expect(prompt).toContain('0.750')
  })

  it('ends with the decision question', () => {
    const candidate = makeCandidate()
    const prompt = buildMergeUserPrompt(candidate, [])
    expect(prompt).toContain('Decide')
  })
})

// ---------------------------------------------------------------------------
// parseMergeOutput — keep_separate
// ---------------------------------------------------------------------------

describe('parseMergeOutput — keep_separate', () => {
  it('returns keep_separate for self-closing tag', () => {
    const result = parseMergeOutput('<merge-decision action="keep_separate" />')
    expect(result.action).toBe('keep_separate')
  })

  it('returns keep_separate for empty string', () => {
    const result = parseMergeOutput('')
    expect(result.action).toBe('keep_separate')
  })

  it('returns keep_separate for garbage text', () => {
    const result = parseMergeOutput('not xml at all')
    expect(result.action).toBe('keep_separate')
  })

  it('returns keep_separate for unknown action', () => {
    const result = parseMergeOutput('<merge-decision action="unknown" />')
    expect(result.action).toBe('keep_separate')
  })

  it('returns keep_separate when target-node-id is missing for merge', () => {
    const result = parseMergeOutput('<merge-decision action="merge" />')
    expect(result.action).toBe('keep_separate')
  })

  it('returns keep_separate when target-node-id is missing for alias', () => {
    const result = parseMergeOutput('<merge-decision action="alias" alias-key="preferences.dark_mode" />')
    expect(result.action).toBe('keep_separate')
  })

  it('returns keep_separate when alias-key is missing for alias', () => {
    const result = parseMergeOutput(
      '<merge-decision action="alias" target-node-id="omg/preference/test" />'
    )
    expect(result.action).toBe('keep_separate')
  })
})

// ---------------------------------------------------------------------------
// parseMergeOutput — merge
// ---------------------------------------------------------------------------

describe('parseMergeOutput — merge', () => {
  it('parses merge action with target-node-id', () => {
    const xml = '<merge-decision action="merge" target-node-id="omg/preference/preferences-editor-theme" />'
    const result = parseMergeOutput(xml)
    expect(result.action).toBe('merge')
    if (result.action === 'merge') {
      expect(result.targetNodeId).toBe('omg/preference/preferences-editor-theme')
    }
  })

  it('parses body-append when present', () => {
    const xml = `<merge-decision action="merge" target-node-id="omg/preference/test">
  <body-append>Extra context about dark mode preference.</body-append>
</merge-decision>`
    const result = parseMergeOutput(xml)
    expect(result.action).toBe('merge')
    if (result.action === 'merge') {
      expect(result.bodyAppend).toContain('Extra context')
    }
  })

  it('bodyAppend is undefined when body-append is empty', () => {
    const xml = '<merge-decision action="merge" target-node-id="omg/preference/test"><body-append></body-append></merge-decision>'
    const result = parseMergeOutput(xml)
    if (result.action === 'merge') {
      expect(result.bodyAppend).toBeUndefined()
    }
  })

  it('handles XML wrapped in markdown code fences', () => {
    const xml = '```xml\n<merge-decision action="merge" target-node-id="omg/preference/test" />\n```'
    const result = parseMergeOutput(xml)
    expect(result.action).toBe('merge')
  })
})

// ---------------------------------------------------------------------------
// parseMergeOutput — alias
// ---------------------------------------------------------------------------

describe('parseMergeOutput — alias', () => {
  it('parses alias action', () => {
    const xml = '<merge-decision action="alias" target-node-id="omg/preference/preferences-editor-theme" alias-key="preferences.dark_mode" />'
    const result = parseMergeOutput(xml)
    expect(result.action).toBe('alias')
    if (result.action === 'alias') {
      expect(result.targetNodeId).toBe('omg/preference/preferences-editor-theme')
      expect(result.aliasKey).toBe('preferences.dark_mode')
    }
  })
})
