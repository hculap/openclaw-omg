import { describe, it, expect, beforeEach } from 'vitest'
import { vol } from 'memfs'
import { applyPatch, archiveAsMerged } from '../../../src/dedup/merge.js'
import type { NodeFrontmatter } from '../../../src/types.js'
import type { MergePlan } from '../../../src/dedup/types.js'
import { clearRegistryCache } from '../../../src/graph/registry.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

import { vi } from 'vitest'

const OMG_ROOT = '/workspace/memory/omg'

function makeFrontmatter(overrides: Partial<NodeFrontmatter> = {}): NodeFrontmatter {
  return {
    id: 'omg/preference/dark-mode',
    description: 'User prefers dark mode',
    type: 'preference',
    priority: 'medium',
    created: '2024-01-01T00:00:00Z',
    updated: '2024-01-01T00:00:00Z',
    tags: ['dark', 'theme'],
    links: ['omg/moc-preferences'],
    ...overrides,
  }
}

beforeEach(() => {
  vol.reset()
  clearRegistryCache()
  vol.fromJSON({ [`${OMG_ROOT}/.keep`]: '' })
})

// ---------------------------------------------------------------------------
// applyPatch — immutability
// ---------------------------------------------------------------------------

describe('applyPatch — immutability', () => {
  it('does not mutate the original frontmatter', () => {
    const fm = makeFrontmatter({ tags: ['dark'], links: ['omg/moc-preferences'] })
    const patch: MergePlan['patch'] = { tags: ['dark', 'editor'] }
    const aliasKeys: string[] = ['preferences.old_key']

    applyPatch(fm, 'Original body', patch, aliasKeys)

    // Original unchanged
    expect(fm.tags).toEqual(['dark'])
  })

  it('returns a new frontmatter object', () => {
    const fm = makeFrontmatter()
    const patch: MergePlan['patch'] = { description: 'New description' }
    const { frontmatter: result } = applyPatch(fm, 'Body', patch, [])
    expect(result).not.toBe(fm)
    expect(result.description).toBe('New description')
  })
})

// ---------------------------------------------------------------------------
// applyPatch — tag/link union
// ---------------------------------------------------------------------------

describe('applyPatch — tag and link merging', () => {
  it('unions tags (no duplicates)', () => {
    const fm = makeFrontmatter({ tags: ['dark', 'theme'] })
    const patch: MergePlan['patch'] = { tags: ['theme', 'editor'] }
    const { frontmatter: result } = applyPatch(fm, 'Body', patch, [])
    expect(result.tags).toContain('dark')
    expect(result.tags).toContain('theme')
    expect(result.tags).toContain('editor')
    // 'theme' not duplicated
    const themeCount = result.tags!.filter((t) => t === 'theme').length
    expect(themeCount).toBe(1)
  })

  it('unions links (no duplicates)', () => {
    const fm = makeFrontmatter({ links: ['omg/moc-preferences', 'omg/identity-core'] })
    const patch: MergePlan['patch'] = { links: ['omg/moc-preferences', 'omg/project-main'] }
    const { frontmatter: result } = applyPatch(fm, 'Body', patch, [])
    expect(result.links).toContain('omg/moc-preferences')
    expect(result.links).toContain('omg/identity-core')
    expect(result.links).toContain('omg/project-main')
    const prefCount = result.links!.filter((l) => l === 'omg/moc-preferences').length
    expect(prefCount).toBe(1)
  })

  it('overlays description when patch provides one', () => {
    const fm = makeFrontmatter({ description: 'Old description' })
    const patch: MergePlan['patch'] = { description: 'New description' }
    const { frontmatter: result } = applyPatch(fm, 'Body', patch, [])
    expect(result.description).toBe('New description')
  })

  it('preserves description when patch does not provide one', () => {
    const fm = makeFrontmatter({ description: 'Preserved description' })
    const { frontmatter: result } = applyPatch(fm, 'Body', {}, [])
    expect(result.description).toBe('Preserved description')
  })
})

// ---------------------------------------------------------------------------
// applyPatch — aliases
// ---------------------------------------------------------------------------

describe('applyPatch — aliases', () => {
  it('adds alias keys to aliases array', () => {
    const fm = makeFrontmatter({ aliases: ['preferences.old'] })
    const { frontmatter: result } = applyPatch(fm, 'Body', {}, ['preferences.loser_key'])
    expect(result.aliases).toContain('preferences.old')
    expect(result.aliases).toContain('preferences.loser_key')
  })

  it('does not duplicate existing aliases', () => {
    const fm = makeFrontmatter({ aliases: ['preferences.existing'] })
    const { frontmatter: result } = applyPatch(fm, 'Body', {}, ['preferences.existing'])
    const count = result.aliases!.filter((a) => a === 'preferences.existing').length
    expect(count).toBe(1)
  })

  it('creates aliases array when none existed', () => {
    const fm = makeFrontmatter({ aliases: undefined })
    const { frontmatter: result } = applyPatch(fm, 'Body', {}, ['preferences.new_alias'])
    expect(result.aliases).toContain('preferences.new_alias')
  })
})

// ---------------------------------------------------------------------------
// applyPatch — bodyAppend
// ---------------------------------------------------------------------------

describe('applyPatch — bodyAppend', () => {
  it('appends to body when bodyAppend provided', () => {
    const { body: result } = applyPatch(makeFrontmatter(), 'Original body', { bodyAppend: 'Appended content' }, [])
    expect(result).toContain('Original body')
    expect(result).toContain('Appended content')
  })

  it('preserves body unchanged when no bodyAppend', () => {
    const { body: result } = applyPatch(makeFrontmatter(), 'Original body content', {}, [])
    expect(result).toBe('Original body content')
  })
})

// ---------------------------------------------------------------------------
// archiveAsMerged
// ---------------------------------------------------------------------------

describe('archiveAsMerged', () => {
  it('sets archived and mergedInto on the node file', async () => {
    const nodeContent = `---
id: omg/preference/loser
description: Loser preference
type: preference
priority: low
created: 2024-01-01T00:00:00Z
updated: 2024-01-01T00:00:00Z
---
Old content.`
    vol.fromJSON({ [`${OMG_ROOT}/nodes/preference/loser.md`]: nodeContent })

    await archiveAsMerged(`${OMG_ROOT}/nodes/preference/loser.md`, 'omg/preference/loser', 'omg/preference/keeper', OMG_ROOT)

    const { promises: fs } = await import('node:fs')
    const written = await fs.readFile(`${OMG_ROOT}/nodes/preference/loser.md`, 'utf-8')
    expect(written).toContain('archived: true')
    expect(written).toContain('mergedInto: omg/preference/keeper')
  })

  it('silently skips non-existent files', async () => {
    await expect(
      archiveAsMerged(`${OMG_ROOT}/nodes/preference/nonexistent.md`, 'omg/preference/nonexistent', 'omg/preference/keeper', OMG_ROOT)
    ).resolves.not.toThrow()
  })
})
