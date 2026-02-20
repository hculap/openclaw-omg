import { describe, it, expect } from 'vitest'
import { extractWikilinks, insertWikilink, removeWikilink } from '../../src/utils/markdown.js'

describe('extractWikilinks', () => {
  it('returns empty array when no links present', () => {
    expect(extractWikilinks('no links here')).toEqual([])
  })

  it('extracts a single wikilink', () => {
    expect(extractWikilinks('[[foo]]')).toEqual(['foo'])
  })

  it('extracts multiple wikilinks', () => {
    expect(extractWikilinks('[[foo]] and [[bar]]')).toEqual(['foo', 'bar'])
  })

  it('deduplicates wikilinks', () => {
    expect(extractWikilinks('[[foo]] and [[bar]] and [[foo]]')).toEqual(['foo', 'bar'])
  })

  it('handles wikilinks with paths', () => {
    expect(extractWikilinks('see [[omg/identity/my-name]] for details')).toEqual(['omg/identity/my-name'])
  })

  it('returns empty array for empty string', () => {
    expect(extractWikilinks('')).toEqual([])
  })
})

describe('insertWikilink', () => {
  it('appends wikilink on a new line', () => {
    expect(insertWikilink('# Header\n', 'foo/bar')).toBe('# Header\n- [[foo/bar]]')
  })

  it('is idempotent when target already present', () => {
    const content = '# Header\n- [[foo/bar]]'
    expect(insertWikilink(content, 'foo/bar')).toBe(content)
  })

  it('appends to content without trailing newline', () => {
    expect(insertWikilink('some content', 'target')).toBe('some content\n- [[target]]')
  })

  it('handles empty content', () => {
    expect(insertWikilink('', 'foo')).toBe('- [[foo]]')
  })

  it('does not insert if link already exists mid-content', () => {
    const content = 'start\n- [[foo]]\nend'
    expect(insertWikilink(content, 'foo')).toBe(content)
  })
})

describe('removeWikilink', () => {
  it('removes the wikilink line', () => {
    const content = '# Header\n- [[foo/bar]]\nother content'
    expect(removeWikilink(content, 'foo/bar')).toBe('# Header\nother content')
  })

  it('returns content unchanged when target absent', () => {
    const content = '# Header\n- [[other]]'
    expect(removeWikilink(content, 'foo/bar')).toBe(content)
  })

  it('returns empty string for empty content', () => {
    expect(removeWikilink('', 'foo')).toBe('')
  })

  it('handles removal of last line', () => {
    expect(removeWikilink('- [[foo]]', 'foo')).toBe('')
  })

  it('only removes the matching line, not partial matches', () => {
    const content = '- [[foobar]]\n- [[foo]]'
    expect(removeWikilink(content, 'foo')).toBe('- [[foobar]]')
  })
})
