import { describe, it, expect } from 'vitest'
import { parseConfig } from '../../src/config.js'
import type { OmgConfig } from '../../src/config.js'
import { resolveOmgRoot, resolveNodePath, resolveMocPath, resolveStatePath } from '../../src/utils/paths.js'

// ---------------------------------------------------------------------------
// resolveOmgRoot
// ---------------------------------------------------------------------------

describe('resolveOmgRoot', () => {
  it('returns workspace + default storagePath', () => {
    const config = parseConfig({})
    expect(resolveOmgRoot('/workspace', config)).toBe('/workspace/memory/omg')
  })

  it('returns workspace + custom storagePath', () => {
    const config = parseConfig({ storagePath: 'custom/data' })
    expect(resolveOmgRoot('/workspace', config)).toBe('/workspace/custom/data')
  })

  it('handles nested storagePath segments', () => {
    const config = parseConfig({ storagePath: 'a/b/c' })
    expect(resolveOmgRoot('/root', config)).toBe('/root/a/b/c')
  })

  it('handles workspace dir with trailing slash gracefully', () => {
    const config = parseConfig({})
    // path.join normalises trailing slashes
    expect(resolveOmgRoot('/workspace/', config)).toBe('/workspace/memory/omg')
  })

  it('handles absolute workspace paths of varying depth', () => {
    const config = parseConfig({ storagePath: 'store/omg' })
    expect(resolveOmgRoot('/users/alice/projects/my-project', config)).toBe(
      '/users/alice/projects/my-project/store/omg'
    )
  })
})

// ---------------------------------------------------------------------------
// resolveNodePath
// ---------------------------------------------------------------------------

describe('resolveNodePath', () => {
  const omgRoot = '/workspace/memory/omg'

  it('resolves identity node path', () => {
    expect(resolveNodePath(omgRoot, 'identity', 'node.md')).toBe(
      '/workspace/memory/omg/nodes/identity/node.md'
    )
  })

  it('resolves preference node path', () => {
    expect(resolveNodePath(omgRoot, 'preference', 'node.md')).toBe(
      '/workspace/memory/omg/nodes/preference/node.md'
    )
  })

  it('resolves project node path', () => {
    expect(resolveNodePath(omgRoot, 'project', 'my-project.md')).toBe(
      '/workspace/memory/omg/nodes/project/my-project.md'
    )
  })

  it('resolves decision node path', () => {
    expect(resolveNodePath(omgRoot, 'decision', 'use-typescript.md')).toBe(
      '/workspace/memory/omg/nodes/decision/use-typescript.md'
    )
  })

  it('resolves fact node path', () => {
    expect(resolveNodePath(omgRoot, 'fact', 'some-fact.md')).toBe(
      '/workspace/memory/omg/nodes/fact/some-fact.md'
    )
  })

  it('resolves episode node path', () => {
    expect(resolveNodePath(omgRoot, 'episode', 'episode-2024.md')).toBe(
      '/workspace/memory/omg/nodes/episode/episode-2024.md'
    )
  })

  it('resolves reflection node path', () => {
    expect(resolveNodePath(omgRoot, 'reflection', 'insight.md')).toBe(
      '/workspace/memory/omg/nodes/reflection/insight.md'
    )
  })

  it('resolves moc node path', () => {
    expect(resolveNodePath(omgRoot, 'moc', 'moc-index.md')).toBe(
      '/workspace/memory/omg/nodes/moc/moc-index.md'
    )
  })

  it('resolves now node path', () => {
    expect(resolveNodePath(omgRoot, 'now', 'now.md')).toBe(
      '/workspace/memory/omg/nodes/now/now.md'
    )
  })

  it('uses the provided omgRoot as base', () => {
    expect(resolveNodePath('/different/root', 'identity', 'core.md')).toBe(
      '/different/root/nodes/identity/core.md'
    )
  })
})

// ---------------------------------------------------------------------------
// resolveMocPath
// ---------------------------------------------------------------------------

describe('resolveMocPath', () => {
  const omgRoot = '/workspace/memory/omg'

  it('resolves identity MOC path', () => {
    expect(resolveMocPath(omgRoot, 'identity')).toBe(
      '/workspace/memory/omg/mocs/moc-identity.md'
    )
  })

  it('resolves preferences MOC path', () => {
    expect(resolveMocPath(omgRoot, 'preferences')).toBe(
      '/workspace/memory/omg/mocs/moc-preferences.md'
    )
  })

  it('resolves project MOC path', () => {
    expect(resolveMocPath(omgRoot, 'project')).toBe(
      '/workspace/memory/omg/mocs/moc-project.md'
    )
  })

  it('resolves arbitrary domain names', () => {
    expect(resolveMocPath(omgRoot, 'custom-domain')).toBe(
      '/workspace/memory/omg/mocs/moc-custom-domain.md'
    )
  })

  it('uses the provided omgRoot as base', () => {
    expect(resolveMocPath('/alt/root', 'identity')).toBe(
      '/alt/root/mocs/moc-identity.md'
    )
  })
})

// ---------------------------------------------------------------------------
// resolveStatePath
// ---------------------------------------------------------------------------

describe('resolveStatePath', () => {
  it('resolves state path with simple session key', () => {
    expect(resolveStatePath('/workspace', 'session-abc')).toBe(
      '/workspace/.omg-state/session-abc.json'
    )
  })

  it('resolves state path with UUID-like session key', () => {
    expect(resolveStatePath('/workspace', 'abc123-def456')).toBe(
      '/workspace/.omg-state/abc123-def456.json'
    )
  })

  it('resolves state path with numeric session key', () => {
    expect(resolveStatePath('/workspace', '12345')).toBe(
      '/workspace/.omg-state/12345.json'
    )
  })

  it('resolves state path with deeply nested workspace dir', () => {
    expect(resolveStatePath('/users/alice/projects/my-project', 'session-xyz')).toBe(
      '/users/alice/projects/my-project/.omg-state/session-xyz.json'
    )
  })

  it('uses .omg-state directory as the state container', () => {
    const result = resolveStatePath('/workspace', 'test-session')
    expect(result).toContain('/.omg-state/')
  })

  it('throws for sessionKey containing a forward slash', () => {
    expect(() => resolveStatePath('/workspace', 'path/traversal')).toThrow(/Invalid sessionKey/)
  })

  it('throws for sessionKey containing a backslash', () => {
    expect(() => resolveStatePath('/workspace', 'path\\traversal')).toThrow(/Invalid sessionKey/)
  })

  it('throws for sessionKey containing double dots', () => {
    expect(() => resolveStatePath('/workspace', '../escape')).toThrow(/Invalid sessionKey/)
  })
})
