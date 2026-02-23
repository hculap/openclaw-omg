import { describe, it, expect } from 'vitest'
import { slugify, generateNodeId, computeUid, computeNodeId, computeNodePath } from '../../src/utils/id.js'

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

describe('computeUid', () => {
  it('returns a 12-character hex string', () => {
    const uid = computeUid('workspace/proj', 'preference', 'preferences.editor_theme')
    expect(uid).toMatch(/^[a-f0-9]{12}$/)
  })

  it('is deterministic — same inputs produce same uid', () => {
    const a = computeUid('workspace/proj', 'preference', 'preferences.editor_theme')
    const b = computeUid('workspace/proj', 'preference', 'preferences.editor_theme')
    expect(a).toBe(b)
  })

  it('different canonicalKeys produce different uids', () => {
    const a = computeUid('workspace/proj', 'preference', 'preferences.editor_theme')
    const b = computeUid('workspace/proj', 'preference', 'preferences.font_size')
    expect(a).not.toBe(b)
  })

  it('different types produce different uids (even with same key)', () => {
    const a = computeUid('workspace/proj', 'preference', 'some.key')
    const b = computeUid('workspace/proj', 'fact', 'some.key')
    expect(a).not.toBe(b)
  })

  it('different scopes produce different uids', () => {
    const a = computeUid('workspace/alice', 'preference', 'preferences.editor_theme')
    const b = computeUid('workspace/bob', 'preference', 'preferences.editor_theme')
    expect(a).not.toBe(b)
  })

  it('handles edge case: empty canonicalKey still produces a uid', () => {
    const uid = computeUid('scope', 'fact', '')
    expect(uid).toMatch(/^[a-f0-9]{12}$/)
  })
})

describe('computeNodeId', () => {
  it('returns omg/{type}/{slug-of-canonicalKey}', () => {
    expect(computeNodeId('preference', 'preferences.editor_theme')).toBe('omg/preference/preferences-editor-theme')
  })

  it('slugifies dots in canonicalKey', () => {
    expect(computeNodeId('fact', 'user.location.city')).toBe('omg/fact/user-location-city')
  })

  it('works for all node types', () => {
    expect(computeNodeId('identity', 'identity.name')).toBe('omg/identity/identity-name')
    expect(computeNodeId('project', 'projects.my_app')).toBe('omg/project/projects-my-app')
  })
})

describe('computeNodePath', () => {
  it('returns nodes/{type}/{slug}.md', () => {
    expect(computeNodePath('preference', 'preferences.editor_theme')).toBe('nodes/preference/preferences-editor-theme.md')
  })

  it('uses the same slug as computeNodeId', () => {
    const nodeId = computeNodeId('fact', 'user.location.city')
    const nodePath = computeNodePath('fact', 'user.location.city')
    // slug portion should match
    const slugFromId = nodeId.split('/')[2]!
    const slugFromPath = nodePath.replace('nodes/fact/', '').replace('.md', '')
    expect(slugFromId).toBe(slugFromPath)
  })

  it('constructs the full relative path correctly', () => {
    expect(computeNodePath('project', 'projects.secretary')).toBe('nodes/project/projects-secretary.md')
  })
})
