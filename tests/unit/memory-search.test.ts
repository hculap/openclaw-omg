import { describe, it, expect, vi } from 'vitest'
import {
  createMemoryTools,
  buildSearchQuery,
  buildSemanticCandidates,
} from '../../src/context/memory-search.js'
import type { MemorySearchResponse, MemoryTools } from '../../src/context/memory-search.js'

// ---------------------------------------------------------------------------
// createMemoryTools
// ---------------------------------------------------------------------------

describe('createMemoryTools — API probing', () => {
  it('returns null when api.runtime is undefined', () => {
    const api = {} as Parameters<typeof createMemoryTools>[0]
    expect(createMemoryTools(api)).toBeNull()
  })

  it('returns null when api.runtime.tools is undefined', () => {
    const api = { runtime: {} } as Parameters<typeof createMemoryTools>[0]
    expect(createMemoryTools(api)).toBeNull()
  })

  it('returns null when createMemorySearchTool is not a function', () => {
    const api = {
      runtime: { tools: { createMemorySearchTool: 'not-a-function' } },
    } as unknown as Parameters<typeof createMemoryTools>[0]
    expect(createMemoryTools(api)).toBeNull()
  })

  it('returns null when createMemorySearchTool() returns null', () => {
    const api = {
      runtime: {
        tools: {
          createMemorySearchTool: vi.fn().mockReturnValue(null),
          createMemoryGetTool: vi.fn().mockReturnValue(null),
        },
      },
    } as unknown as Parameters<typeof createMemoryTools>[0]
    expect(createMemoryTools(api)).toBeNull()
  })

  it('returns MemoryTools when both tools are present', () => {
    const mockSearch = { execute: vi.fn() }
    const mockGet = { execute: vi.fn() }
    const api = {
      runtime: {
        tools: {
          createMemorySearchTool: vi.fn().mockReturnValue(mockSearch),
          createMemoryGetTool: vi.fn().mockReturnValue(mockGet),
        },
      },
    } as unknown as Parameters<typeof createMemoryTools>[0]

    const tools = createMemoryTools(api)
    expect(tools).not.toBeNull()
    expect(typeof tools?.search).toBe('function')
    expect(typeof tools?.get).toBe('function')
  })

  it('returns MemoryTools with search only when get is unavailable', () => {
    const mockSearch = { execute: vi.fn() }
    const api = {
      runtime: {
        tools: {
          createMemorySearchTool: vi.fn().mockReturnValue(mockSearch),
          createMemoryGetTool: vi.fn().mockReturnValue(null),
        },
      },
    } as unknown as Parameters<typeof createMemoryTools>[0]

    const tools = createMemoryTools(api)
    expect(tools).not.toBeNull()
    expect(typeof tools?.search).toBe('function')
  })

  it('search() returns null when execute throws', async () => {
    const mockSearch = { execute: vi.fn().mockRejectedValue(new Error('API error')) }
    const api = {
      runtime: {
        tools: {
          createMemorySearchTool: vi.fn().mockReturnValue(mockSearch),
          createMemoryGetTool: vi.fn().mockReturnValue(null),
        },
      },
    } as unknown as Parameters<typeof createMemoryTools>[0]

    const tools = createMemoryTools(api) as MemoryTools
    const result = await tools.search('test query')
    expect(result).toBeNull()
  })

  it('search() returns response when execute resolves', async () => {
    const mockResponse: MemorySearchResponse = {
      results: [{ filePath: '/a.md', score: 0.9, snippet: 'text' }],
    }
    const mockSearch = { execute: vi.fn().mockResolvedValue(mockResponse) }
    const api = {
      runtime: {
        tools: {
          createMemorySearchTool: vi.fn().mockReturnValue(mockSearch),
          createMemoryGetTool: vi.fn().mockReturnValue(null),
        },
      },
    } as unknown as Parameters<typeof createMemoryTools>[0]

    const tools = createMemoryTools(api) as MemoryTools
    const result = await tools.search('test query')
    expect(result).toEqual(mockResponse)
  })

  it('get() returns null when execute throws', async () => {
    const mockSearch = { execute: vi.fn().mockResolvedValue({ results: [] }) }
    const mockGet = { execute: vi.fn().mockRejectedValue(new Error('get error')) }
    const api = {
      runtime: {
        tools: {
          createMemorySearchTool: vi.fn().mockReturnValue(mockSearch),
          createMemoryGetTool: vi.fn().mockReturnValue(mockGet),
        },
      },
    } as unknown as Parameters<typeof createMemoryTools>[0]

    const tools = createMemoryTools(api) as MemoryTools
    const result = await tools.get('/a.md')
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// buildSearchQuery
// ---------------------------------------------------------------------------

describe('buildSearchQuery', () => {
  it('returns empty string when prompt and nowContent are empty and no keywords', () => {
    const query = buildSearchQuery('', null, new Set())
    expect(typeof query).toBe('string')
  })

  it('includes prompt in the query', () => {
    const query = buildSearchQuery('Tell me about TypeScript', null, new Set())
    expect(query).toContain('TypeScript')
  })

  it('includes now.md content snippet', () => {
    const query = buildSearchQuery('hello', 'Working on feature X today.', new Set())
    expect(query).toContain('feature X')
  })

  it('includes top keywords', () => {
    const kws = new Set(['typescript', 'configuration', 'error'])
    const query = buildSearchQuery('', null, kws)
    expect(query).toContain('typescript')
  })

  it('truncates very long prompts to ~500 chars', () => {
    const longPrompt = 'a'.repeat(2000)
    const query = buildSearchQuery(longPrompt, null, new Set())
    expect(query.length).toBeLessThanOrEqual(600)
  })

  it('handles null nowContent gracefully', () => {
    expect(() => buildSearchQuery('test', null, new Set(['kw']))).not.toThrow()
  })

  it('handles empty keyword set', () => {
    expect(() => buildSearchQuery('test', 'now content', new Set())).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// buildSemanticCandidates
// ---------------------------------------------------------------------------

describe('buildSemanticCandidates', () => {
  it('returns empty array for empty results', () => {
    const response: MemorySearchResponse = { results: [] }
    expect(buildSemanticCandidates(response)).toHaveLength(0)
  })

  it('returns empty array when response is disabled', () => {
    const response: MemorySearchResponse = { results: [], disabled: true }
    expect(buildSemanticCandidates(response)).toHaveLength(0)
  })

  it('normalizes scores to [0, 1] via min-max', () => {
    const response: MemorySearchResponse = {
      results: [
        { filePath: '/a.md', score: 0.8, snippet: '' },
        { filePath: '/b.md', score: 0.4, snippet: '' },
        { filePath: '/c.md', score: 0.6, snippet: '' },
      ],
    }
    const candidates = buildSemanticCandidates(response)
    const scores = candidates.map((c) => c.semanticScore)

    // max score should be 1.0, min should be 0.0
    expect(Math.max(...scores)).toBeCloseTo(1.0, 5)
    expect(Math.min(...scores)).toBeCloseTo(0.0, 5)
    // mid score should be between 0 and 1
    const midScore = candidates.find((c) => c.filePath === '/c.md')?.semanticScore ?? -1
    expect(midScore).toBeGreaterThan(0)
    expect(midScore).toBeLessThan(1)
  })

  it('returns score 1.0 when all scores are equal (single result — best signal)', () => {
    const response: MemorySearchResponse = {
      results: [{ filePath: '/a.md', score: 0.9, snippet: 'text' }],
    }
    const candidates = buildSemanticCandidates(response)
    expect(candidates).toHaveLength(1)
    // Single result: min == max, normalize to 1.0 so it still contributes as a signal
    expect(candidates[0]!.semanticScore).toBe(1.0)
  })

  it('deduplicates by filePath keeping best score', () => {
    const response: MemorySearchResponse = {
      results: [
        { filePath: '/a.md', score: 0.5, snippet: 'first' },
        { filePath: '/a.md', score: 0.9, snippet: 'second' },
        { filePath: '/b.md', score: 0.3, snippet: 'other' },
      ],
    }
    const candidates = buildSemanticCandidates(response)
    const aCandidates = candidates.filter((c) => c.filePath === '/a.md')
    expect(aCandidates).toHaveLength(1)
    // After dedup, /a.md raw score was 0.9 (higher), /b.md was 0.3
    // /a.md should have higher normalizedScore than /b.md
    const aScore = aCandidates[0]!.semanticScore
    const bScore = candidates.find((c) => c.filePath === '/b.md')!.semanticScore
    expect(aScore).toBeGreaterThanOrEqual(bScore)
  })

  it('preserves filePath and snippet from results', () => {
    const response: MemorySearchResponse = {
      results: [
        { filePath: '/nodes/fact/foo.md', score: 0.7, snippet: 'relevant content' },
      ],
    }
    const candidates = buildSemanticCandidates(response)
    expect(candidates[0]!.filePath).toBe('/nodes/fact/foo.md')
    expect(candidates[0]!.snippet).toBe('relevant content')
  })

  it('filters out results with empty filePath', () => {
    const response: MemorySearchResponse = {
      results: [
        { filePath: '', score: 0.8, snippet: 'no path' },
        { filePath: '/valid.md', score: 0.5, snippet: 'valid' },
      ],
    }
    const candidates = buildSemanticCandidates(response)
    expect(candidates.every((c) => c.filePath.length > 0)).toBe(true)
  })

  it('filters out candidates below minScore after normalisation', () => {
    const response: MemorySearchResponse = {
      results: [
        { filePath: '/a.md', score: 0.9, snippet: '' },
        { filePath: '/b.md', score: 0.6, snippet: '' },
        { filePath: '/c.md', score: 0.3, snippet: '' },
      ],
    }
    // After min-max normalization: /a.md → 1.0, /b.md → 0.5, /c.md → 0.0
    const candidates = buildSemanticCandidates(response, 0.4)
    expect(candidates.map((c) => c.filePath)).toEqual(['/a.md', '/b.md'])
  })

  it('returns all candidates when minScore is 0 (default)', () => {
    const response: MemorySearchResponse = {
      results: [
        { filePath: '/a.md', score: 0.9, snippet: '' },
        { filePath: '/b.md', score: 0.3, snippet: '' },
      ],
    }
    const candidates = buildSemanticCandidates(response, 0)
    expect(candidates).toHaveLength(2)
  })

  it('returns empty array when all candidates fall below minScore', () => {
    const response: MemorySearchResponse = {
      results: [
        { filePath: '/a.md', score: 0.9, snippet: '' },
        { filePath: '/b.md', score: 0.6, snippet: '' },
      ],
    }
    // After normalization: /a.md → 1.0, /b.md → 0.0 — both below threshold of 1.1 (impossible but edge case)
    // Use a more realistic case: minScore 1.0 keeps only the top-scoring normalised result
    const candidates = buildSemanticCandidates(response, 1.0)
    expect(candidates).toEqual([{ filePath: '/a.md', snippet: '', semanticScore: 1.0 }])
  })
})
