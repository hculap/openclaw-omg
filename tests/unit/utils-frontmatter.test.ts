import { describe, it, expect } from 'vitest'
import { parseFrontmatter, serializeFrontmatter } from '../../src/utils/frontmatter.js'

describe('parseFrontmatter', () => {
  it('parses a valid frontmatter block and body', () => {
    const raw = '---\ntitle: Hello\nauthor: Alice\n---\nBody content here.'
    const result = parseFrontmatter(raw)
    expect(result.frontmatter).toEqual({ title: 'Hello', author: 'Alice' })
    expect(result.body).toBe('Body content here.')
  })

  it('returns empty object and full string when no frontmatter block', () => {
    const raw = 'Just a plain body with no frontmatter.'
    const result = parseFrontmatter(raw)
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe('Just a plain body with no frontmatter.')
  })

  it('returns empty body string when frontmatter block has no trailing body', () => {
    const raw = '---\ntitle: Only FM\n---\n'
    const result = parseFrontmatter(raw)
    expect(result.frontmatter).toEqual({ title: 'Only FM' })
    expect(result.body).toBe('')
  })

  it('parses frontmatter with array values', () => {
    const raw = '---\ntags:\n  - alpha\n  - beta\n---\nContent.'
    const result = parseFrontmatter(raw)
    expect(result.frontmatter).toEqual({ tags: ['alpha', 'beta'] })
    expect(result.body).toBe('Content.')
  })

  it('parses frontmatter with nested object values', () => {
    const raw = '---\nmeta:\n  author: Bob\n  version: 2\n---\nBody.'
    const result = parseFrontmatter(raw)
    expect(result.frontmatter).toEqual({ meta: { author: 'Bob', version: 2 } })
    expect(result.body).toBe('Body.')
  })

  it('handles an empty string input', () => {
    const result = parseFrontmatter('')
    expect(result.frontmatter).toEqual({})
    expect(result.body).toBe('')
  })

  it('does not mutate the input string', () => {
    const raw = '---\nkey: val\n---\nbody'
    const copy = raw
    parseFrontmatter(raw)
    expect(raw).toBe(copy)
  })

  it('throws when the frontmatter block is a YAML array at root level', () => {
    const raw = '---\n- item1\n- item2\n---\nBody content.'
    expect(() => parseFrontmatter(raw)).toThrow(/array.*instead of object|instead of object/)
  })

  it('throws when the frontmatter block is a YAML scalar at root level', () => {
    const raw = '---\n42\n---\nBody content.'
    expect(() => parseFrontmatter(raw)).toThrow(/number.*instead of object|instead of object/)
  })
})

describe('serializeFrontmatter', () => {
  it('serializes simple frontmatter and body into "---\\n{yaml}\\n---\\n{body}" format', () => {
    const result = serializeFrontmatter({ title: 'Hello' }, 'Some body.')
    expect(result).toMatch(/^---\n/)
    expect(result).toContain('title: Hello')
    expect(result).toContain('---\nSome body.')
  })

  it('serializes empty frontmatter as "---\\n---\\n{body}"', () => {
    const result = serializeFrontmatter({}, 'My body.')
    expect(result).toBe('---\n{}\n---\nMy body.')
  })

  it('preserves the body content exactly', () => {
    const body = 'Line one.\nLine two.\n'
    const result = serializeFrontmatter({ x: 1 }, body)
    expect(result.endsWith(body)).toBe(true)
  })
})

describe('round-trip: serialize then parse', () => {
  it('round-trips simple frontmatter and body', () => {
    const original = { title: 'Test', count: 42 }
    const body = 'Round-trip body.'
    const serialized = serializeFrontmatter(original, body)
    const { frontmatter, body: parsedBody } = parseFrontmatter(serialized)
    expect(frontmatter).toEqual(original)
    expect(parsedBody).toBe(body)
  })

  it('round-trips frontmatter with arrays', () => {
    const original = { tags: ['a', 'b', 'c'] }
    const body = 'Array body.'
    const serialized = serializeFrontmatter(original, body)
    const { frontmatter, body: parsedBody } = parseFrontmatter(serialized)
    expect(frontmatter).toEqual(original)
    expect(parsedBody).toBe(body)
  })

  it('round-trips frontmatter with nested objects', () => {
    const original = { meta: { author: 'Alice', version: 3 } }
    const body = 'Nested body.'
    const serialized = serializeFrontmatter(original, body)
    const { frontmatter, body: parsedBody } = parseFrontmatter(serialized)
    expect(frontmatter).toEqual(original)
    expect(parsedBody).toBe(body)
  })
})
