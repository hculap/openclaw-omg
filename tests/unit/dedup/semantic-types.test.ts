import { describe, it, expect } from 'vitest'
import { semanticDedupLlmResponseSchema, semanticMergeSuggestionSchema } from '../../../src/dedup/semantic-types.js'

describe('semanticMergeSuggestionSchema', () => {
  it('validates a correct suggestion', () => {
    const result = semanticMergeSuggestionSchema.safeParse({
      keepNodeId: 'omg/fact.dark-mode',
      mergeNodeIds: ['omg/fact.dark-theme'],
      similarityScore: 92,
      rationale: 'Both describe dark mode preference',
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty keepNodeId', () => {
    const result = semanticMergeSuggestionSchema.safeParse({
      keepNodeId: '',
      mergeNodeIds: ['omg/fact.test'],
      similarityScore: 90,
      rationale: 'test',
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty mergeNodeIds', () => {
    const result = semanticMergeSuggestionSchema.safeParse({
      keepNodeId: 'omg/fact.test',
      mergeNodeIds: [],
      similarityScore: 90,
      rationale: 'test',
    })
    expect(result.success).toBe(false)
  })

  it('rejects similarityScore above 100', () => {
    const result = semanticMergeSuggestionSchema.safeParse({
      keepNodeId: 'omg/fact.test',
      mergeNodeIds: ['omg/fact.other'],
      similarityScore: 101,
      rationale: 'test',
    })
    expect(result.success).toBe(false)
  })

  it('rejects similarityScore below 0', () => {
    const result = semanticMergeSuggestionSchema.safeParse({
      keepNodeId: 'omg/fact.test',
      mergeNodeIds: ['omg/fact.other'],
      similarityScore: -1,
      rationale: 'test',
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer similarityScore', () => {
    const result = semanticMergeSuggestionSchema.safeParse({
      keepNodeId: 'omg/fact.test',
      mergeNodeIds: ['omg/fact.other'],
      similarityScore: 90.5,
      rationale: 'test',
    })
    expect(result.success).toBe(false)
  })
})

describe('semanticDedupLlmResponseSchema', () => {
  it('validates response with suggestions', () => {
    const result = semanticDedupLlmResponseSchema.safeParse({
      suggestions: [{
        keepNodeId: 'omg/fact.a',
        mergeNodeIds: ['omg/fact.b'],
        similarityScore: 95,
        rationale: 'Same fact',
      }],
    })
    expect(result.success).toBe(true)
  })

  it('validates empty suggestions array', () => {
    const result = semanticDedupLlmResponseSchema.safeParse({ suggestions: [] })
    expect(result.success).toBe(true)
  })

  it('rejects missing suggestions field', () => {
    const result = semanticDedupLlmResponseSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('rejects malformed suggestion in array', () => {
    const result = semanticDedupLlmResponseSchema.safeParse({
      suggestions: [{ keepNodeId: 'test' }],
    })
    expect(result.success).toBe(false)
  })
})
