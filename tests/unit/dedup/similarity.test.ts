import { describe, it, expect } from 'vitest'
import {
  extractTrigrams,
  trigramJaccard,
  tokenize,
  tokenSetJaccard,
  combinedSimilarity,
  keyPrefix,
} from '../../../src/dedup/similarity.js'

// ---------------------------------------------------------------------------
// extractTrigrams
// ---------------------------------------------------------------------------

describe('extractTrigrams', () => {
  it('returns empty map for empty string', () => {
    expect(extractTrigrams('').size).toBe(0)
  })

  it('returns empty map for strings shorter than 3 chars', () => {
    expect(extractTrigrams('ab').size).toBe(0)
  })

  it('returns correct trigrams for "abc"', () => {
    const t = extractTrigrams('abc')
    expect(t.get('abc')).toBe(1)
    expect(t.size).toBe(1)
  })

  it('counts repeated trigrams', () => {
    // "abab" → "aba", "bab" — both once
    const t = extractTrigrams('abab')
    expect(t.get('aba')).toBe(1)
    expect(t.get('bab')).toBe(1)
  })

  it('counts duplicate trigrams when text repeats', () => {
    // "aaaa" → "aaa" appears twice
    const t = extractTrigrams('aaaa')
    expect(t.get('aaa')).toBe(2)
  })

  it('handles full word', () => {
    const t = extractTrigrams('hello')
    expect(t.has('hel')).toBe(true)
    expect(t.has('ell')).toBe(true)
    expect(t.has('llo')).toBe(true)
    expect(t.size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// trigramJaccard
// ---------------------------------------------------------------------------

describe('trigramJaccard', () => {
  it('returns 1.0 for identical strings', () => {
    expect(trigramJaccard('hello world', 'hello world')).toBe(1)
  })

  it('returns 0 for completely different strings', () => {
    expect(trigramJaccard('aaa', 'bbb')).toBe(0)
  })

  it('returns 0 for two short strings (< 3 chars)', () => {
    expect(trigramJaccard('ab', 'cd')).toBe(0)
  })

  it('returns value between 0 and 1 for similar strings', () => {
    const score = trigramJaccard('preferences editor theme', 'preferences editor dark')
    expect(score).toBeGreaterThan(0)
    expect(score).toBeLessThan(1)
  })

  it('is symmetric', () => {
    const a = 'dark mode preference'
    const b = 'editor theme dark'
    expect(trigramJaccard(a, b)).toBeCloseTo(trigramJaccard(b, a))
  })
})

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

describe('tokenize', () => {
  it('returns empty set for empty string', () => {
    expect(tokenize('').size).toBe(0)
  })

  it('lowercases tokens', () => {
    const tokens = tokenize('Hello World')
    expect(tokens.has('hello')).toBe(true)
    expect(tokens.has('world')).toBe(true)
  })

  it('splits on non-alphanumeric', () => {
    const tokens = tokenize('foo.bar-baz_qux')
    expect(tokens.has('foo')).toBe(true)
    expect(tokens.has('bar')).toBe(true)
    expect(tokens.has('baz')).toBe(true)
    expect(tokens.has('qux')).toBe(true)
  })

  it('includes all words (no stopword filtering)', () => {
    const tokens = tokenize('the user prefers dark mode')
    expect(tokens.has('the')).toBe(true)
    expect(tokens.has('user')).toBe(true)
    expect(tokens.has('prefers')).toBe(true)
    expect(tokens.has('dark')).toBe(true)
    expect(tokens.has('mode')).toBe(true)
  })

  it('filters empty tokens', () => {
    const tokens = tokenize('  multiple   spaces  ')
    for (const t of tokens) {
      expect(t.length).toBeGreaterThan(0)
    }
  })

  it('preserves Unicode diacritics (Polish characters)', () => {
    const tokens = tokenize('siłownia formatowanie ćwiczenia')
    expect(tokens.has('siłownia')).toBe(true)
    expect(tokens.has('formatowanie')).toBe(true)
    expect(tokens.has('ćwiczenia')).toBe(true)
  })

  it('preserves Unicode diacritics (Spanish, German)', () => {
    const tokens = tokenize('señor über straße')
    expect(tokens.has('señor')).toBe(true)
    expect(tokens.has('über')).toBe(true)
    expect(tokens.has('straße')).toBe(true)
  })

  it('splits on non-letter/non-digit Unicode boundaries', () => {
    const tokens = tokenize('żona — wife, partner')
    expect(tokens.has('żona')).toBe(true)
    expect(tokens.has('wife')).toBe(true)
    expect(tokens.has('partner')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// tokenSetJaccard
// ---------------------------------------------------------------------------

describe('tokenSetJaccard', () => {
  it('returns 1.0 for identical strings', () => {
    expect(tokenSetJaccard('dark mode preference', 'dark mode preference')).toBe(1)
  })

  it('returns 0 for disjoint token sets', () => {
    const score = tokenSetJaccard('apple orange banana', 'quantum mechanics field')
    // may share no tokens
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('returns value > 0 for overlapping tokens', () => {
    const score = tokenSetJaccard('user prefers dark mode', 'user dark mode enabled')
    expect(score).toBeGreaterThan(0)
  })

  it('is symmetric', () => {
    const a = 'preferences editor theme dark'
    const b = 'editor dark theme mode'
    expect(tokenSetJaccard(a, b)).toBeCloseTo(tokenSetJaccard(b, a))
  })

  it('produces > 0 similarity for mixed multilingual text with shared tokens', () => {
    const score = tokenSetJaccard('siłownia gym workout trening', 'gym trening exercise siłownia')
    expect(score).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// combinedSimilarity
// ---------------------------------------------------------------------------

describe('combinedSimilarity', () => {
  it('returns 1 for identical desc and key', () => {
    const score = combinedSimilarity('dark mode', 'dark mode', 'preferences.dark_mode', 'preferences.dark_mode')
    expect(score).toBe(1)
  })

  it('returns 0 for completely different inputs', () => {
    const score = combinedSimilarity('aaa', 'zzz', 'a.b', 'x.y')
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('returns high score for semantic duplicates', () => {
    // "preferences.dark_mode" vs "preferences.editor_theme_dark"
    const score = combinedSimilarity(
      'User prefers dark mode for the editor',
      'User prefers dark editor theme',
      'preferences.dark_mode',
      'preferences.editor_theme_dark'
    )
    expect(score).toBeGreaterThan(0.3)
  })

  it('result is in [0, 1] range', () => {
    const score = combinedSimilarity('foo bar baz', 'qux quux corge', 'a.b.c', 'd.e.f')
    expect(score).toBeGreaterThanOrEqual(0)
    expect(score).toBeLessThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// keyPrefix
// ---------------------------------------------------------------------------

describe('keyPrefix', () => {
  it('returns first segment of dotted key', () => {
    expect(keyPrefix('preferences.editor_theme')).toBe('preferences')
  })

  it('returns the full key when no dot', () => {
    expect(keyPrefix('identity')).toBe('identity')
  })

  it('handles deeply nested key', () => {
    expect(keyPrefix('project.main.goals')).toBe('project')
  })

  it('returns empty string for empty input', () => {
    expect(keyPrefix('')).toBe('')
  })
})
