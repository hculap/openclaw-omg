import { describe, it, expect } from 'vitest'
import type { RegistryNodeEntry } from '../../../src/graph/registry.js'
import {
  buildDedupSystemPrompt,
  buildDedupUserPrompt,
} from '../../../src/dedup/prompts.js'
import type { CandidateCluster } from '../../../src/dedup/candidates.js'

// ---------------------------------------------------------------------------
// buildDedupSystemPrompt
// ---------------------------------------------------------------------------

describe('buildDedupSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildDedupSystemPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  it('mentions merge plan JSON output', () => {
    const prompt = buildDedupSystemPrompt()
    expect(prompt.toLowerCase()).toMatch(/merge|dedup/i)
    expect(prompt).toContain('mergePlans')
  })

  it('instructs to output valid JSON', () => {
    const prompt = buildDedupSystemPrompt()
    expect(prompt.toLowerCase()).toContain('json')
  })
})

// ---------------------------------------------------------------------------
// buildDedupUserPrompt
// ---------------------------------------------------------------------------

function makeEntry(canonicalKey: string, description: string): RegistryNodeEntry {
  return {
    type: 'preference',
    kind: 'observation',
    priority: 'medium',
    created: '2024-01-01T00:00:00Z',
    updated: '2024-06-01T00:00:00Z',
    filePath: '/root/nodes/preference/test.md',
    description,
    canonicalKey,
  }
}

describe('buildDedupUserPrompt', () => {
  it('returns a non-empty string', () => {
    const cluster: CandidateCluster = {
      nodeIds: ['omg/preference/a', 'omg/preference/b'],
      entries: new Map([
        ['omg/preference/a', makeEntry('preferences.dark_mode', 'User prefers dark mode')],
        ['omg/preference/b', makeEntry('preferences.editor_theme', 'User prefers dark editor theme')],
      ]),
      maxScore: 0.8,
    }
    const prompt = buildDedupUserPrompt([cluster])
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  it('includes node IDs in the prompt', () => {
    const cluster: CandidateCluster = {
      nodeIds: ['omg/preference/dark-mode', 'omg/preference/editor-theme'],
      entries: new Map([
        ['omg/preference/dark-mode', makeEntry('preferences.dark_mode', 'dark mode preference')],
        ['omg/preference/editor-theme', makeEntry('preferences.editor_theme', 'editor dark theme')],
      ]),
      maxScore: 0.75,
    }
    const prompt = buildDedupUserPrompt([cluster])
    expect(prompt).toContain('omg/preference/dark-mode')
    expect(prompt).toContain('omg/preference/editor-theme')
  })

  it('includes canonical keys', () => {
    const cluster: CandidateCluster = {
      nodeIds: ['omg/preference/a', 'omg/preference/b'],
      entries: new Map([
        ['omg/preference/a', makeEntry('preferences.dark_mode', 'dark mode')],
        ['omg/preference/b', makeEntry('preferences.editor_dark_theme', 'editor dark')],
      ]),
      maxScore: 0.7,
    }
    const prompt = buildDedupUserPrompt([cluster])
    expect(prompt).toContain('preferences.dark_mode')
    expect(prompt).toContain('preferences.editor_dark_theme')
  })

  it('handles multiple clusters', () => {
    const clusterA: CandidateCluster = {
      nodeIds: ['omg/preference/a1', 'omg/preference/a2'],
      entries: new Map([
        ['omg/preference/a1', makeEntry('preferences.theme', 'theme pref')],
        ['omg/preference/a2', makeEntry('preferences.editor_theme', 'editor theme pref')],
      ]),
      maxScore: 0.8,
    }
    const clusterB: CandidateCluster = {
      nodeIds: ['omg/preference/b1', 'omg/preference/b2'],
      entries: new Map([
        ['omg/preference/b1', makeEntry('preferences.font', 'font size pref')],
        ['omg/preference/b2', makeEntry('preferences.font_size', 'editor font size pref')],
      ]),
      maxScore: 0.7,
    }
    const prompt = buildDedupUserPrompt([clusterA, clusterB])
    expect(prompt).toContain('omg/preference/a1')
    expect(prompt).toContain('omg/preference/b1')
  })

  it('handles empty clusters list', () => {
    const prompt = buildDedupUserPrompt([])
    expect(typeof prompt).toBe('string')
    // Should return something (even if minimal)
  })
})
