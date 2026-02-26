import { describe, it, expect } from 'vitest'
import { resolvePrimaryDomain, assignDomains } from '../../../src/reflector/domain-resolver.js'
import type { RegistryNodeEntry } from '../../../src/graph/registry.js'

function makeEntry(overrides: Partial<RegistryNodeEntry> = {}): RegistryNodeEntry {
  return {
    type: 'fact',
    kind: 'observation',
    description: 'test entry',
    priority: 'medium',
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    filePath: '/test/node.md',
    ...overrides,
  }
}

describe('resolvePrimaryDomain', () => {
  it('priority 1: extracts domain from first omg/moc-* link', () => {
    const entry = makeEntry({ links: ['omg/moc-preferences', 'omg/moc-tools'] })
    expect(resolvePrimaryDomain(entry)).toBe('preferences')
  })

  it('priority 2: maps canonicalKey prefix to domain', () => {
    const entry = makeEntry({ canonicalKey: 'identity.preferred-name' })
    expect(resolvePrimaryDomain(entry)).toBe('identity')
  })

  it('priority 2: maps "preferences" prefix correctly', () => {
    const entry = makeEntry({ canonicalKey: 'preferences.dark-mode' })
    expect(resolvePrimaryDomain(entry)).toBe('preferences')
  })

  it('priority 2: maps "projects" prefix correctly', () => {
    const entry = makeEntry({ canonicalKey: 'projects.secretary' })
    expect(resolvePrimaryDomain(entry)).toBe('projects')
  })

  it('priority 2: maps "decisions" prefix correctly', () => {
    const entry = makeEntry({ canonicalKey: 'decisions.use-typescript' })
    expect(resolvePrimaryDomain(entry)).toBe('decisions')
  })

  it('priority 3: defaults to misc when no signals', () => {
    const entry = makeEntry()
    expect(resolvePrimaryDomain(entry)).toBe('misc')
  })

  it('priority 3: defaults to misc for unrecognized prefix', () => {
    const entry = makeEntry({ canonicalKey: 'random.stuff' })
    expect(resolvePrimaryDomain(entry)).toBe('misc')
  })

  it('MOC link takes precedence over canonicalKey', () => {
    const entry = makeEntry({
      links: ['omg/moc-tools'],
      canonicalKey: 'preferences.editor',
    })
    expect(resolvePrimaryDomain(entry)).toBe('tools')
  })

  it('handles entry with no links and no canonicalKey', () => {
    const entry = makeEntry({ links: undefined, canonicalKey: undefined })
    expect(resolvePrimaryDomain(entry)).toBe('misc')
  })
})

describe('assignDomains', () => {
  it('groups entries by domain', () => {
    const entries: [string, RegistryNodeEntry][] = [
      ['id1', makeEntry({ links: ['omg/moc-preferences'] })],
      ['id2', makeEntry({ links: ['omg/moc-preferences'] })],
      ['id3', makeEntry({ canonicalKey: 'identity.name' })],
      ['id4', makeEntry()],
    ]

    const result = assignDomains(entries)

    expect(result.get('preferences')).toHaveLength(2)
    expect(result.get('identity')).toHaveLength(1)
    expect(result.get('misc')).toHaveLength(1)
  })

  it('returns empty map for empty input', () => {
    const result = assignDomains([])
    expect(result.size).toBe(0)
  })
})
