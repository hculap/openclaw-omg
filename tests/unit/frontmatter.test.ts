import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { parseNodeFrontmatter, nodeFrontmatterSchema, FrontmatterValidationError } from '../../src/frontmatter.js'
import type { NodeFrontmatter } from '../../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Asserts the function throws a FrontmatterValidationError mentioning `fieldPath`. */
function expectFieldError(fn: () => unknown, fieldPath: string): void {
  expect(fn).toThrow(FrontmatterValidationError)
  expect(fn).toThrow(fieldPath)
}

/** Minimal valid frontmatter object. */
const validMinimal = {
  id: 'omg/identity-core',
  description: 'Core identity node',
  type: 'identity',
  priority: 'high',
  created: '2024-01-01T00:00:00Z',
  updated: '2024-01-01T00:00:00Z',
}

// ---------------------------------------------------------------------------
// Valid inputs
// ---------------------------------------------------------------------------

describe('parseNodeFrontmatter — valid inputs', () => {
  it('minimal valid frontmatter → returns NodeFrontmatter', () => {
    const result = parseNodeFrontmatter(validMinimal)
    expect(result.id).toBe('omg/identity-core')
    expect(result.type).toBe('identity')
    expect(result.priority).toBe('high')
    expect(result.created).toBe('2024-01-01T00:00:00Z')
    expect(result.updated).toBe('2024-01-01T00:00:00Z')
  })

  it('all optional fields present → returned correctly', () => {
    const raw = {
      ...validMinimal,
      type: 'fact',
      priority: 'medium',
      appliesTo: { sessionScope: 'ws-1', identityKey: 'user-42' },
      sources: [{ sessionKey: 'sess-1', kind: 'user', timestamp: 1_700_000_000_000 }],
      links: ['omg/moc-preferences'],
      tags: ['core', 'identity'],
      supersedes: ['omg/old-identity'],
    }
    const result = parseNodeFrontmatter(raw)
    expect(result.type).toBe('fact')
    expect(result.appliesTo).toEqual({ sessionScope: 'ws-1', identityKey: 'user-42' })
    expect(result.sources).toHaveLength(1)
    expect(result.links).toEqual(['omg/moc-preferences'])
    expect(result.tags).toEqual(['core', 'identity'])
    expect(result.supersedes).toEqual(['omg/old-identity'])
  })

  it('updated > created → accepted', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, updated: '2024-06-01T00:00:00Z' })
    ).not.toThrow()
  })

  it('updated equal to created → accepted', () => {
    expect(() => parseNodeFrontmatter(validMinimal)).not.toThrow()
  })

  it('unknown keys → stripped silently', () => {
    const result = parseNodeFrontmatter({ ...validMinimal, unknownField: 'ignored' })
    expect((result as unknown as Record<string, unknown>)['unknownField']).toBeUndefined()
  })

  it('appliesTo with only sessionScope → accepted', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, appliesTo: { sessionScope: 'ws-1' } })
    ).not.toThrow()
  })

  it('appliesTo with only identityKey → accepted', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, appliesTo: { identityKey: 'user-42' } })
    ).not.toThrow()
  })

  it('all NodeType values → accepted', () => {
    const types = ['identity', 'preference', 'project', 'decision', 'fact', 'episode', 'reflection', 'moc', 'index', 'now'] as const
    for (const type of types) {
      expect(() => parseNodeFrontmatter({ ...validMinimal, type })).not.toThrow()
    }
  })

  it('compressionLevel 0 → accepted', () => {
    const result = parseNodeFrontmatter({ ...validMinimal, compressionLevel: 0 })
    expect(result.compressionLevel).toBe(0)
  })

  it('compressionLevel 3 → accepted', () => {
    const result = parseNodeFrontmatter({ ...validMinimal, compressionLevel: 3 })
    expect(result.compressionLevel).toBe(3)
  })

  it('compressionLevel absent → undefined in result', () => {
    const result = parseNodeFrontmatter(validMinimal)
    expect(result.compressionLevel).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Invalid inputs — required fields
// ---------------------------------------------------------------------------

describe('parseNodeFrontmatter — required field errors', () => {
  it('null input → throws FrontmatterValidationError at (root)', () => {
    expectFieldError(() => parseNodeFrontmatter(null), '(root)')
  })

  it('missing id → throws FrontmatterValidationError on id', () => {
    const { id: _id, ...rest } = validMinimal
    expectFieldError(() => parseNodeFrontmatter(rest), 'id')
  })

  it('empty id → throws FrontmatterValidationError on id', () => {
    expectFieldError(() => parseNodeFrontmatter({ ...validMinimal, id: '' }), 'id')
  })

  it('id without slash → throws FrontmatterValidationError on id', () => {
    expectFieldError(() => parseNodeFrontmatter({ ...validMinimal, id: 'no-slash' }), 'id')
  })

  it('id with uppercase → throws FrontmatterValidationError on id', () => {
    expectFieldError(() => parseNodeFrontmatter({ ...validMinimal, id: 'Omg/identity-core' }), 'id')
  })

  it('id with leading hyphen in namespace → throws FrontmatterValidationError on id', () => {
    expectFieldError(() => parseNodeFrontmatter({ ...validMinimal, id: '-omg/identity-core' }), 'id')
  })

  it('missing type → throws FrontmatterValidationError on type', () => {
    const { type: _type, ...rest } = validMinimal
    expectFieldError(() => parseNodeFrontmatter(rest), 'type')
  })

  it('invalid type → throws FrontmatterValidationError on type', () => {
    expectFieldError(() => parseNodeFrontmatter({ ...validMinimal, type: 'unknown-type' }), 'type')
  })

  it('uppercase type → throws FrontmatterValidationError on type', () => {
    expectFieldError(() => parseNodeFrontmatter({ ...validMinimal, type: 'FACT' }), 'type')
  })

  it('invalid priority → throws FrontmatterValidationError on priority', () => {
    expectFieldError(
      () => parseNodeFrontmatter({ ...validMinimal, priority: 'urgent' }),
      'priority'
    )
  })

  it('compressionLevel 4 → throws FrontmatterValidationError', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, compressionLevel: 4 })
    ).toThrow(FrontmatterValidationError)
  })

  it('non-ISO created → throws FrontmatterValidationError on created', () => {
    expectFieldError(
      () => parseNodeFrontmatter({ ...validMinimal, created: '2024-01-01' }),
      'created'
    )
  })

  it('non-ISO updated → throws FrontmatterValidationError on updated', () => {
    expectFieldError(
      () => parseNodeFrontmatter({ ...validMinimal, updated: 'yesterday' }),
      'updated'
    )
  })

  it('updated < created → throws FrontmatterValidationError on updated', () => {
    expectFieldError(
      () => parseNodeFrontmatter({
        ...validMinimal,
        created: '2024-06-01T00:00:00Z',
        updated: '2024-01-01T00:00:00Z',
      }),
      'updated'
    )
  })
})

// ---------------------------------------------------------------------------
// Invalid inputs — appliesTo
// ---------------------------------------------------------------------------

describe('parseNodeFrontmatter — appliesTo validation', () => {
  it('appliesTo: {} → throws (neither field present)', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, appliesTo: {} })
    ).toThrow(FrontmatterValidationError)
  })

  it('appliesTo with unknown field only → throws', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, appliesTo: { unknownField: 'x' } })
    ).toThrow(FrontmatterValidationError)
  })
})

// ---------------------------------------------------------------------------
// Invalid inputs — nested arrays
// ---------------------------------------------------------------------------

describe('parseNodeFrontmatter — nested array validation', () => {
  it('source with negative timestamp → throws FrontmatterValidationError', () => {
    expect(() =>
      parseNodeFrontmatter({
        ...validMinimal,
        sources: [{ sessionKey: 's', kind: 'user', timestamp: -1 }],
      })
    ).toThrow(FrontmatterValidationError)
  })

  it('source with empty sessionKey → throws FrontmatterValidationError', () => {
    expect(() =>
      parseNodeFrontmatter({
        ...validMinimal,
        sources: [{ sessionKey: '', kind: 'user', timestamp: 0 }],
      })
    ).toThrow(FrontmatterValidationError)
  })

  it('source with empty kind → throws FrontmatterValidationError', () => {
    expect(() =>
      parseNodeFrontmatter({
        ...validMinimal,
        sources: [{ sessionKey: 'sess-1', kind: '', timestamp: 0 }],
      })
    ).toThrow(FrontmatterValidationError)
  })

  it('source with unknown field → throws FrontmatterValidationError (strict schema)', () => {
    expect(() =>
      parseNodeFrontmatter({
        ...validMinimal,
        sources: [{ sessionKey: 'sess-1', kind: 'user', timestamp: 0, extraField: 'x' }],
      })
    ).toThrow(FrontmatterValidationError)
  })

  it('empty-string link → throws FrontmatterValidationError', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, links: [''] })
    ).toThrow(FrontmatterValidationError)
  })

  it('empty-string tag → throws FrontmatterValidationError', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, tags: ['valid', ''] })
    ).toThrow(FrontmatterValidationError)
  })

  it('empty-string supersedes entry → throws FrontmatterValidationError', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, supersedes: [''] })
    ).toThrow(FrontmatterValidationError)
  })
})

// ---------------------------------------------------------------------------
// FrontmatterValidationError structure
// ---------------------------------------------------------------------------

describe('FrontmatterValidationError', () => {
  it('message starts with standard prefix', () => {
    let err: FrontmatterValidationError | null = null
    try { parseNodeFrontmatter({ ...validMinimal, type: 'bad' }) }
    catch (e) { if (e instanceof FrontmatterValidationError) err = e }
    expect(err?.message).toMatch(/^OMG node frontmatter is invalid:/)
  })

  it('.issues contains structured ZodIssue objects with field path', () => {
    let err: FrontmatterValidationError | null = null
    try { parseNodeFrontmatter({ ...validMinimal, type: 'bad' }) }
    catch (e) { if (e instanceof FrontmatterValidationError) err = e }
    expect(err?.issues.length).toBeGreaterThan(0)
    expect(err?.issues[0]?.path).toContain('type')
  })

  it('Error.cause is the original ZodError', () => {
    let err: FrontmatterValidationError | null = null
    try { parseNodeFrontmatter({ ...validMinimal, type: 'bad' }) }
    catch (e) { if (e instanceof FrontmatterValidationError) err = e }
    expect(err?.cause).toBeInstanceOf(Error)
    expect((err?.cause as { issues?: unknown })?.issues).toBeDefined()
  })

  it('instanceof check works correctly (prototype chain)', () => {
    let err: unknown
    try { parseNodeFrontmatter({ ...validMinimal, type: 'bad' }) }
    catch (e) { err = e }
    expect(err).toBeInstanceOf(FrontmatterValidationError)
    expect(err).toBeInstanceOf(Error)
  })

  it('.name is "FrontmatterValidationError"', () => {
    let err: FrontmatterValidationError | null = null
    try { parseNodeFrontmatter({ ...validMinimal, type: 'bad' }) }
    catch (e) { if (e instanceof FrontmatterValidationError) err = e }
    expect(err?.name).toBe('FrontmatterValidationError')
  })

  it('zero-issues ZodError → throws an internal Error (not a FrontmatterValidationError)', () => {
    let thrown: unknown
    try { new FrontmatterValidationError(new z.ZodError([])) }
    catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(FrontmatterValidationError)
    expect((thrown as Error).message).toMatch(/[Ii]nternal bug/)
  })
})

// ---------------------------------------------------------------------------
// New optional fields: uid, canonicalKey, aliases (Phase 1d)
// ---------------------------------------------------------------------------

describe('parseNodeFrontmatter — uid, canonicalKey, aliases (new optional fields)', () => {
  it('accepts frontmatter without uid/canonicalKey/aliases (backward compat)', () => {
    const result = parseNodeFrontmatter(validMinimal)
    expect(result.uid).toBeUndefined()
    expect(result.canonicalKey).toBeUndefined()
    expect(result.aliases).toBeUndefined()
  })

  it('accepts valid uid (12-char hex)', () => {
    const result = parseNodeFrontmatter({ ...validMinimal, uid: 'a3f8c2d91e47' })
    expect(result.uid).toBe('a3f8c2d91e47')
  })

  it('rejects uid with wrong length (not 12 chars)', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, uid: 'abc123' })
    ).toThrow(FrontmatterValidationError)
  })

  it('rejects uid with uppercase letters', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, uid: 'A3F8C2D91E47' })
    ).toThrow(FrontmatterValidationError)
  })

  it('rejects uid with non-hex chars', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, uid: 'zzzzzzzzzzzz' })
    ).toThrow(FrontmatterValidationError)
  })

  it('accepts valid canonicalKey', () => {
    const result = parseNodeFrontmatter({ ...validMinimal, canonicalKey: 'preferences.editor_theme' })
    expect(result.canonicalKey).toBe('preferences.editor_theme')
  })

  it('rejects empty canonicalKey', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, canonicalKey: '' })
    ).toThrow(FrontmatterValidationError)
  })

  it('accepts aliases as array of strings', () => {
    const result = parseNodeFrontmatter({ ...validMinimal, aliases: ['editor-theme', 'dark-mode'] })
    expect(result.aliases).toEqual(['editor-theme', 'dark-mode'])
  })

  it('rejects aliases containing empty string', () => {
    expect(() =>
      parseNodeFrontmatter({ ...validMinimal, aliases: ['valid', ''] })
    ).toThrow(FrontmatterValidationError)
  })

  it('accepts all three new fields together', () => {
    const result = parseNodeFrontmatter({
      ...validMinimal,
      uid: 'a3f8c2d91e47',
      canonicalKey: 'preferences.editor_theme',
      aliases: ['editor-theme'],
    })
    expect(result.uid).toBe('a3f8c2d91e47')
    expect(result.canonicalKey).toBe('preferences.editor_theme')
    expect(result.aliases).toEqual(['editor-theme'])
  })
})

// ---------------------------------------------------------------------------
// nodeFrontmatterSchema export
// ---------------------------------------------------------------------------

describe('nodeFrontmatterSchema', () => {
  it('safeParse returns success:false for invalid input without throwing', () => {
    const result = nodeFrontmatterSchema.safeParse({ ...validMinimal, type: 'bad' })
    expect(result.success).toBe(false)
  })

  it('safeParse returns success:true for valid minimal input', () => {
    const result = nodeFrontmatterSchema.safeParse(validMinimal)
    expect(result.success).toBe(true)
  })

  it('inferred type is compatible with NodeFrontmatter', () => {
    // Compile-time check: ensure the schema output is assignable to NodeFrontmatter
    const result = nodeFrontmatterSchema.safeParse(validMinimal)
    if (result.success) {
      const _check: NodeFrontmatter = result.data as NodeFrontmatter
      expect(_check.id).toBe('omg/identity-core')
    }
  })
})
