import { describe, it, expect } from 'vitest'
import { slugify, generateNodeId } from '../../src/utils/id.js'

describe('slugify', () => {
  it('lowercases text', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('replaces non-alphanumeric chars with hyphens', () => {
    expect(slugify('my-preferred-name!')).toBe('my-preferred-name')
  })

  it('collapses multiple hyphens to one', () => {
    expect(slugify('hello   world')).toBe('hello-world')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  special  chars!! ')).toBe('special-chars')
  })

  it('returns empty string for empty input', () => {
    expect(slugify('')).toBe('')
  })

  it('truncates to 50 characters max', () => {
    const longText = 'a'.repeat(60)
    const result = slugify(longText)
    expect(result.length).toBeLessThanOrEqual(50)
  })

  it('truncates before trimming trailing hyphens', () => {
    // Build a string that when slugified would be exactly 50+ chars
    const text = 'a'.repeat(48) + '  extra'
    const result = slugify(text)
    expect(result.length).toBeLessThanOrEqual(50)
    // Should not end with a hyphen after trim
    expect(result).not.toMatch(/-$/)
  })

  it('handles strings with only special characters', () => {
    expect(slugify('!!!')).toBe('')
  })
})

describe('generateNodeId', () => {
  it('generates id with correct format omg/type/slug', () => {
    expect(generateNodeId('identity', 'Preferred Name')).toBe('omg/identity/preferred-name')
  })

  it('slugifies the description', () => {
    expect(generateNodeId('fact', 'TypeScript is cool')).toBe('omg/fact/typescript-is-cool')
  })

  it('works for all node types', () => {
    expect(generateNodeId('project', 'My Big Project')).toBe('omg/project/my-big-project')
    expect(generateNodeId('decision', 'Use TypeScript')).toBe('omg/decision/use-typescript')
    expect(generateNodeId('episode', 'First Day at Work')).toBe('omg/episode/first-day-at-work')
    expect(generateNodeId('moc', 'Top Level Map')).toBe('omg/moc/top-level-map')
  })
})
