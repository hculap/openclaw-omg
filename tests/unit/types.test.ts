import { describe, it, expect } from 'vitest'
import {
  isNodeType, NODE_TYPES, PRIORITY_ORDER,
  isCompressionLevel,
  createReflectorOutput, ReflectorInvariantError,
  createOmgSessionState, OmgSessionStateError,
} from '../../src/types.js'
import type { ReflectorNodeEdit, NodeFrontmatter } from '../../src/types.js'

describe('isNodeType', () => {
  it('returns true for every valid NodeType', () => {
    for (const t of NODE_TYPES) {
      expect(isNodeType(t)).toBe(true)
    }
  })

  it('returns false for an unknown string', () => {
    expect(isNodeType('unknown')).toBe(false)
    expect(isNodeType('FACT')).toBe(false)
    expect(isNodeType('fact ')).toBe(false) // trailing space
  })

  it('returns false for non-string inputs', () => {
    expect(isNodeType(null)).toBe(false)
    expect(isNodeType(undefined)).toBe(false)
    expect(isNodeType(42)).toBe(false)
    expect(isNodeType({ type: 'fact' })).toBe(false)
    expect(isNodeType(['fact'])).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isNodeType('')).toBe(false)
  })
})

describe('NODE_TYPES', () => {
  it('contains exactly all expected node types (exhaustive)', () => {
    const expected = [
      'identity', 'preference', 'project', 'decision',
      'fact', 'episode', 'reflection', 'moc', 'index', 'now',
    ]
    expect([...NODE_TYPES].sort()).toEqual([...expected].sort())
  })

  it('has no duplicate entries', () => {
    expect(new Set(NODE_TYPES).size).toBe(NODE_TYPES.length)
  })

  it('preserves canonical declaration order (first: identity, last: now)', () => {
    expect(NODE_TYPES[0]).toBe('identity')
    expect(NODE_TYPES[NODE_TYPES.length - 1]).toBe('now')
  })
})

describe('PRIORITY_ORDER', () => {
  it('high outranks medium outranks low', () => {
    expect(PRIORITY_ORDER.high).toBeGreaterThan(PRIORITY_ORDER.medium)
    expect(PRIORITY_ORDER.medium).toBeGreaterThan(PRIORITY_ORDER.low)
  })

  it('all priorities have positive numeric values', () => {
    expect(PRIORITY_ORDER.high).toBeGreaterThan(0)
    expect(PRIORITY_ORDER.medium).toBeGreaterThan(0)
    expect(PRIORITY_ORDER.low).toBeGreaterThan(0)
  })

  it('covers all Priority values', () => {
    const priorities = ['high', 'medium', 'low'] as const
    for (const p of priorities) {
      expect(typeof PRIORITY_ORDER[p]).toBe('number')
    }
  })

})

// ---------------------------------------------------------------------------
// isCompressionLevel
// ---------------------------------------------------------------------------

describe('isCompressionLevel', () => {
  it('returns true for each valid level (0, 1, 2, 3)', () => {
    expect(isCompressionLevel(0)).toBe(true)
    expect(isCompressionLevel(1)).toBe(true)
    expect(isCompressionLevel(2)).toBe(true)
    expect(isCompressionLevel(3)).toBe(true)
  })

  it('returns false for out-of-range integers', () => {
    expect(isCompressionLevel(-1)).toBe(false)
    expect(isCompressionLevel(4)).toBe(false)
    expect(isCompressionLevel(100)).toBe(false)
  })

  it('returns false for non-integer numbers', () => {
    expect(isCompressionLevel(1.5)).toBe(false)
    expect(isCompressionLevel(0.5)).toBe(false)
  })

  it('returns false for non-number inputs', () => {
    expect(isCompressionLevel(null)).toBe(false)
    expect(isCompressionLevel(undefined)).toBe(false)
    expect(isCompressionLevel('1')).toBe(false)
    expect(isCompressionLevel({})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// createReflectorOutput
// ---------------------------------------------------------------------------

function makeEdit(targetId: string): ReflectorNodeEdit {
  const frontmatter: NodeFrontmatter = {
    id: targetId,
    description: 'test',
    type: 'fact',
    priority: 'medium',
    created: '2024-01-01T00:00:00Z',
    updated: '2024-01-01T00:00:00Z',
  }
  return { targetId, frontmatter, body: '', compressionLevel: 0 }
}

describe('createReflectorOutput', () => {
  it('returns a ReflectorOutput when edits and deletions are disjoint', () => {
    const result = createReflectorOutput([makeEdit('a'), makeEdit('b')], ['c', 'd'], 100)
    expect(result.edits).toHaveLength(2)
    expect(result.deletions).toEqual(['c', 'd'])
    expect(result.tokensUsed).toBe(100)
  })

  it('tokensUsed is preserved exactly in the returned output', () => {
    const result = createReflectorOutput([], [], 9_999)
    expect(result.tokensUsed).toBe(9_999)
  })

  it('empty edits and deletions → accepted', () => {
    const result = createReflectorOutput([], [], 0)
    expect(result.edits).toHaveLength(0)
    expect(result.deletions).toHaveLength(0)
  })

  it('node ID in both edits and deletions → throws ReflectorInvariantError', () => {
    expect(() => createReflectorOutput([makeEdit('x')], ['x'], 10)).toThrow(ReflectorInvariantError)
    expect(() => createReflectorOutput([makeEdit('x')], ['x'], 10)).toThrow(/invariant violation/)
  })

  it('multiple overlapping IDs → error message lists all of them', () => {
    expect(() =>
      createReflectorOutput([makeEdit('a'), makeEdit('b')], ['a', 'b'], 10)
    ).toThrow(/a.*b|b.*a/)
  })

  it('ReflectorInvariantError exposes overlappingIds', () => {
    let err: ReflectorInvariantError | null = null
    try { createReflectorOutput([makeEdit('x'), makeEdit('y')], ['x'], 10) }
    catch (e) { if (e instanceof ReflectorInvariantError) err = e }
    expect(err?.overlappingIds).toEqual(['x'])
  })

  it('negative tokensUsed → throws ReflectorInvariantError (kind: negative-tokens)', () => {
    expect(() => createReflectorOutput([], [], -1)).toThrow(ReflectorInvariantError)
    expect(() => createReflectorOutput([], [], -1)).toThrow(/tokensUsed must be >= 0/)
    let err: ReflectorInvariantError | null = null
    try { createReflectorOutput([], [], -1) }
    catch (e) { if (e instanceof ReflectorInvariantError) err = e }
    expect(err?.kind).toBe('negative-tokens')
  })

  it('targetId and frontmatter.id mismatch → throws ReflectorInvariantError (kind: id-mismatch)', () => {
    const mismatchedEdit: ReflectorNodeEdit = {
      targetId: 'a',
      frontmatter: { ...makeEdit('b').frontmatter, id: 'b' },
      body: '',
      compressionLevel: 0,
    }
    expect(() => createReflectorOutput([mismatchedEdit], [], 0)).toThrow(ReflectorInvariantError)
    expect(() => createReflectorOutput([mismatchedEdit], [], 0)).toThrow(
      /targetId\/frontmatter\.id mismatch/
    )
    let err: ReflectorInvariantError | null = null
    try { createReflectorOutput([mismatchedEdit], [], 0) }
    catch (e) { if (e instanceof ReflectorInvariantError) err = e }
    expect(err?.kind).toBe('id-mismatch')
  })

  it('multiple targetId/frontmatter.id mismatches → error message includes all pairs', () => {
    const editA: ReflectorNodeEdit = {
      targetId: 'a',
      frontmatter: { ...makeEdit('x').frontmatter, id: 'x' },
      body: '',
      compressionLevel: 0,
    }
    const editB: ReflectorNodeEdit = {
      targetId: 'b',
      frontmatter: { ...makeEdit('y').frontmatter, id: 'y' },
      body: '',
      compressionLevel: 0,
    }
    expect(() => createReflectorOutput([editA, editB], [], 0)).toThrow(ReflectorInvariantError)
    expect(() => createReflectorOutput([editA, editB], [], 0)).toThrow(/a≠x/)
    expect(() => createReflectorOutput([editA, editB], [], 0)).toThrow(/b≠y/)
  })

  it('ReflectorInvariantError.name is "ReflectorInvariantError"', () => {
    let err: ReflectorInvariantError | null = null
    try { createReflectorOutput([makeEdit('x')], ['x'], 10) }
    catch (e) { if (e instanceof ReflectorInvariantError) err = e }
    expect(err?.name).toBe('ReflectorInvariantError')
  })

  it('overlap error has kind: overlap', () => {
    let err: ReflectorInvariantError | null = null
    try { createReflectorOutput([makeEdit('x')], ['x'], 10) }
    catch (e) { if (e instanceof ReflectorInvariantError) err = e }
    expect(err?.kind).toBe('overlap')
  })

  it('id-mismatch error has empty overlappingIds', () => {
    const mismatchedEdit: ReflectorNodeEdit = {
      targetId: 'a',
      frontmatter: { ...makeEdit('b').frontmatter, id: 'b' },
      body: '',
      compressionLevel: 0,
    }
    let err: ReflectorInvariantError | null = null
    try { createReflectorOutput([mismatchedEdit], [], 0) }
    catch (e) { if (e instanceof ReflectorInvariantError) err = e }
    expect(err?.overlappingIds).toEqual([])
  })

  it('negative-tokens error has empty overlappingIds', () => {
    let err: ReflectorInvariantError | null = null
    try { createReflectorOutput([], [], -1) }
    catch (e) { if (e instanceof ReflectorInvariantError) err = e }
    expect(err?.overlappingIds).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// createOmgSessionState
// ---------------------------------------------------------------------------

describe('createOmgSessionState', () => {
  const valid = {
    lastObservedAtMs: 1_000,
    pendingMessageTokens: 500,
    totalObservationTokens: 10_000,
    observationBoundaryMessageIndex: 42,
    nodeCount: 15,
  }

  it('returns the validated state for all-positive fields', () => {
    expect(createOmgSessionState(valid)).toEqual(valid)
  })

  it('all-zero fields → accepted', () => {
    const state = createOmgSessionState({
      lastObservedAtMs: 0,
      pendingMessageTokens: 0,
      totalObservationTokens: 0,
      observationBoundaryMessageIndex: 0,
      nodeCount: 0,
    })
    expect(state.lastObservedAtMs).toBe(0)
    expect(state.totalObservationTokens).toBe(0)
  })

  it.each([
    ['lastObservedAtMs', { ...valid, lastObservedAtMs: -1 }],
    ['pendingMessageTokens', { ...valid, pendingMessageTokens: -1 }],
    ['totalObservationTokens', { ...valid, totalObservationTokens: -1 }],
    ['observationBoundaryMessageIndex', { ...valid, observationBoundaryMessageIndex: -1 }],
    ['nodeCount', { ...valid, nodeCount: -1 }],
  ])('negative %s → throws OmgSessionStateError mentioning the field', (field, fields) => {
    expect(() => createOmgSessionState(fields)).toThrow(OmgSessionStateError)
    expect(() => createOmgSessionState(fields)).toThrow(field)
  })

  it('totalObservationTokens equal to previous → accepted (not a decrease)', () => {
    expect(() => createOmgSessionState(valid, 10_000)).not.toThrow()
  })

  it('totalObservationTokens greater than previous → accepted', () => {
    expect(() => createOmgSessionState(valid, 9_000)).not.toThrow()
  })

  it('totalObservationTokens less than previous → throws OmgSessionStateError', () => {
    expect(() => createOmgSessionState(valid, 11_000)).toThrow(OmgSessionStateError)
    expect(() => createOmgSessionState(valid, 11_000)).toThrow(/must not decrease/)
  })

  it('monotonicity error message includes both the new and previous token counts', () => {
    let err: OmgSessionStateError | null = null
    try { createOmgSessionState({ ...valid, totalObservationTokens: 5_000 }, 11_000) }
    catch (e) { if (e instanceof OmgSessionStateError) err = e }
    expect(err?.message).toContain('5000')
    expect(err?.message).toContain('11000')
  })

  it('no previousTotalObservationTokens → monotonicity not checked', () => {
    expect(() => createOmgSessionState({ ...valid, totalObservationTokens: 999_999 })).not.toThrow()
  })

  it('OmgSessionStateError.name is "OmgSessionStateError"', () => {
    let err: OmgSessionStateError | null = null
    try { createOmgSessionState({ ...valid, nodeCount: -1 }) }
    catch (e) { if (e instanceof OmgSessionStateError) err = e }
    expect(err?.name).toBe('OmgSessionStateError')
  })

  it('instanceof check works correctly (prototype chain)', () => {
    let err: unknown
    try { createOmgSessionState({ ...valid, nodeCount: -1 }) }
    catch (e) { err = e }
    expect(err).toBeInstanceOf(OmgSessionStateError)
    expect(err).toBeInstanceOf(Error)
  })
})
