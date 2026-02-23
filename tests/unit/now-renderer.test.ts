import { describe, it, expect } from 'vitest'
import { renderNowPatch, shouldUpdateNow, resolveCanonicalKeyToWikilink } from '../../src/observer/now-renderer.js'
import type { NowPatch } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MINIMAL_PATCH: NowPatch = {
  focus: 'Working on auth module.',
  openLoops: [],
  suggestedLinks: [],
}

const FULL_PATCH: NowPatch = {
  focus: 'Working on auth module.',
  openLoops: ['JWT middleware', 'login tests'],
  suggestedLinks: ['preferences.answer_style', 'projects.secretary'],
}

// ---------------------------------------------------------------------------
// resolveCanonicalKeyToWikilink
// ---------------------------------------------------------------------------

describe('resolveCanonicalKeyToWikilink', () => {
  it('resolves preferences.* to [[omg/preference/...]]', () => {
    const result = resolveCanonicalKeyToWikilink('preferences.answer_style')
    expect(result).toContain('omg/preference/')
  })

  it('resolves projects.* to [[omg/project/...]]', () => {
    const result = resolveCanonicalKeyToWikilink('projects.secretary')
    expect(result).toContain('omg/project/')
  })

  it('resolves facts.* to [[omg/fact/...]]', () => {
    const result = resolveCanonicalKeyToWikilink('facts.typescript_types')
    expect(result).toContain('omg/fact/')
  })

  it('resolves identity.* to [[omg/identity/...]]', () => {
    const result = resolveCanonicalKeyToWikilink('identity.core')
    expect(result).toContain('omg/identity/')
  })

  it('returns null for unknown prefix', () => {
    const result = resolveCanonicalKeyToWikilink('unknown.key')
    expect(result).toBeNull()
  })

  it('wraps result in [[ ]] wikilink format', () => {
    const result = resolveCanonicalKeyToWikilink('preferences.answer_style')
    expect(result).toMatch(/^\[\[.*\]\]$/)
  })
})

// ---------------------------------------------------------------------------
// renderNowPatch — content structure
// ---------------------------------------------------------------------------

describe('renderNowPatch — structure', () => {
  it('includes Current Focus section', () => {
    const rendered = renderNowPatch(MINIMAL_PATCH, [])
    expect(rendered).toContain('## Current Focus')
    expect(rendered).toContain('Working on auth module.')
  })

  it('includes Open Loops section when openLoops is non-empty', () => {
    const rendered = renderNowPatch(FULL_PATCH, [])
    expect(rendered).toContain('## Open Loops')
    expect(rendered).toContain('JWT middleware')
    expect(rendered).toContain('login tests')
  })

  it('omits Open Loops section when openLoops is empty', () => {
    const rendered = renderNowPatch(MINIMAL_PATCH, [])
    expect(rendered).not.toContain('## Open Loops')
  })

  it('includes Recent Nodes section when recentNodeIds is non-empty', () => {
    const rendered = renderNowPatch(MINIMAL_PATCH, ['omg/fact/facts-foo'])
    expect(rendered).toContain('## Recent Nodes')
    expect(rendered).toContain('omg/fact/facts-foo')
  })

  it('omits Recent Nodes section when recentNodeIds is empty', () => {
    const rendered = renderNowPatch(MINIMAL_PATCH, [])
    expect(rendered).not.toContain('## Recent Nodes')
  })

  it('includes Related section for resolvable suggestedLinks', () => {
    const rendered = renderNowPatch(FULL_PATCH, [])
    expect(rendered).toContain('## Related')
  })
})

// ---------------------------------------------------------------------------
// renderNowPatch — idempotency
// ---------------------------------------------------------------------------

describe('renderNowPatch — idempotency', () => {
  it('returns identical output for identical inputs', () => {
    const a = renderNowPatch(FULL_PATCH, ['omg/fact/facts-a', 'omg/fact/facts-b'])
    const b = renderNowPatch(FULL_PATCH, ['omg/fact/facts-a', 'omg/fact/facts-b'])
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// renderNowPatch — size cap
// ---------------------------------------------------------------------------

describe('renderNowPatch — size cap', () => {
  it('stays within 60 lines / 2000 chars for typical input', () => {
    const patch: NowPatch = {
      focus: 'Working on something.',
      openLoops: Array.from({ length: 20 }, (_, i) => `Loop ${i}`),
      suggestedLinks: [],
    }
    const rendered = renderNowPatch(patch, [])
    const lines = rendered.split('\n').length
    expect(lines).toBeLessThanOrEqual(60)
    expect(rendered.length).toBeLessThanOrEqual(2000)
  })
})

// ---------------------------------------------------------------------------
// shouldUpdateNow
// ---------------------------------------------------------------------------

describe('shouldUpdateNow', () => {
  it('returns true when currentContent is null', () => {
    expect(shouldUpdateNow(null, MINIMAL_PATCH)).toBe(true)
  })

  it('returns true when rendered output differs from current content', () => {
    const current = 'some old content'
    expect(shouldUpdateNow(current, MINIMAL_PATCH)).toBe(true)
  })

  it('returns false when current content matches rendered patch', () => {
    const rendered = renderNowPatch(MINIMAL_PATCH, [])
    expect(shouldUpdateNow(rendered, MINIMAL_PATCH)).toBe(false)
  })

  it('returns true when open loops changed (non-empty)', () => {
    const patchWithLoops: NowPatch = {
      focus: 'Same focus.',
      openLoops: ['New loop'],
      suggestedLinks: [],
    }
    const rendered = renderNowPatch(patchWithLoops, [])
    // With different loops, content differs
    const patchNoLoops: NowPatch = { ...patchWithLoops, openLoops: [] }
    expect(shouldUpdateNow(rendered, patchNoLoops)).toBe(true)
  })
})
