import { describe, it, expect } from 'vitest'
import { toolResultPersist } from '../../src/hooks/tool-result-persist.js'

// ---------------------------------------------------------------------------
// toolResultPersist — synchronous hook
// ---------------------------------------------------------------------------

describe('toolResultPersist — memory_search tool', () => {
  it('extracts omg/ node references from memory_search result text', () => {
    const event = {
      toolName: 'memory_search',
      result: {
        content: [{ type: 'text', text: 'Found nodes: omg/fact/typescript-types and omg/preference/editor-dark-mode' }],
      },
    }

    const tagged = toolResultPersist(event)

    expect(tagged).toBeDefined()
    expect(tagged?.referencedNodeIds).toContain('omg/fact/typescript-types')
    expect(tagged?.referencedNodeIds).toContain('omg/preference/editor-dark-mode')
  })

  it('returns empty referencedNodeIds when result has no omg/ paths', () => {
    const event = {
      toolName: 'memory_search',
      result: {
        content: [{ type: 'text', text: 'No relevant memories found.' }],
      },
    }

    const tagged = toolResultPersist(event)
    expect(tagged?.referencedNodeIds).toEqual([])
  })

  it('handles result with multiple omg/ references across content blocks', () => {
    const event = {
      toolName: 'memory_search',
      result: {
        content: [
          { type: 'text', text: 'Reference: omg/identity/user-profile' },
          { type: 'text', text: 'Also: omg/project/main-app' },
        ],
      },
    }

    const tagged = toolResultPersist(event)
    expect(tagged?.referencedNodeIds).toContain('omg/identity/user-profile')
    expect(tagged?.referencedNodeIds).toContain('omg/project/main-app')
  })

  it('deduplicates repeated node references', () => {
    const event = {
      toolName: 'memory_search',
      result: {
        content: [{ type: 'text', text: 'omg/fact/typescript-types omg/fact/typescript-types' }],
      },
    }

    const tagged = toolResultPersist(event)
    const count = tagged?.referencedNodeIds.filter((id) => id === 'omg/fact/typescript-types').length
    expect(count).toBe(1)
  })
})

describe('toolResultPersist — non-memory_search tools', () => {
  it('returns undefined for bash tool', () => {
    const event = { toolName: 'bash', result: { output: 'hello world' } }
    expect(toolResultPersist(event)).toBeUndefined()
  })

  it('returns undefined for web_fetch tool', () => {
    const event = { toolName: 'web_fetch', result: { content: 'omg/fact/something' } }
    expect(toolResultPersist(event)).toBeUndefined()
  })

  it('returns undefined for read_file tool even if result contains omg/ paths', () => {
    const event = {
      toolName: 'read_file',
      result: { content: 'omg/fact/typescript-types referenced here' },
    }
    expect(toolResultPersist(event)).toBeUndefined()
  })
})

describe('toolResultPersist — error resilience', () => {
  it('never throws for malformed result', () => {
    const event = { toolName: 'memory_search', result: null }
    expect(() => toolResultPersist(event)).not.toThrow()
  })

  it('never throws for missing result content', () => {
    const event = { toolName: 'memory_search', result: {} }
    expect(() => toolResultPersist(event)).not.toThrow()
  })

  it('never throws for undefined result', () => {
    const event = { toolName: 'memory_search', result: undefined }
    expect(() => toolResultPersist(event)).not.toThrow()
  })
})
