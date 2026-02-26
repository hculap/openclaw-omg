import { describe, it, expect, vi, beforeEach } from 'vitest'
import { vol } from 'memfs'
import { parseConfig } from '../../../src/config.js'
import { clearRegistryCache } from '../../../src/graph/registry.js'
import type { LlmClient } from '../../../src/llm/client.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

const { runSemanticDedup } = await import('../../../src/dedup/semantic-dedup.js')

const OMG_ROOT = '/workspace/memory/omg'

function makeMockLlm(responseContent: string = '{"suggestions":[]}'): LlmClient {
  return {
    generate: vi.fn().mockResolvedValue({
      content: responseContent,
      usage: { inputTokens: 100, outputTokens: 50 },
    }),
  }
}

beforeEach(() => {
  vol.reset()
  clearRegistryCache()
  vol.fromJSON({ [`${OMG_ROOT}/.keep`]: '' })
})

describe('runSemanticDedup', () => {
  it('short-circuits when disabled', async () => {
    const config = parseConfig({ semanticDedup: { enabled: false } })
    const result = await runSemanticDedup({ omgRoot: OMG_ROOT, config, llmClient: makeMockLlm() })
    expect(result.blocksProcessed).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  it('returns zero-cost result when no entries', async () => {
    const config = parseConfig({ semanticDedup: { enabled: true } })
    const result = await runSemanticDedup({ omgRoot: OMG_ROOT, config, llmClient: makeMockLlm() })
    expect(result.blocksProcessed).toBe(0)
    expect(result.mergesExecuted).toBe(0)
  })

  it('produces no merges when LLM returns empty suggestions', async () => {
    const config = parseConfig({
      semanticDedup: {
        enabled: true,
        heuristicPrefilterThreshold: 0.1,
      },
    })

    // Create two similar nodes
    vol.fromJSON({
      [`${OMG_ROOT}/nodes/fact/fact.similar-a-2026-01-15.md`]: `---
id: omg/fact.similar-a
description: User prefers dark mode theme
type: fact
priority: medium
created: 2026-01-01T00:00:00Z
updated: 2026-01-15T00:00:00Z
canonicalKey: facts.similar-a
---
Dark mode preference.`,
      [`${OMG_ROOT}/nodes/fact/fact.similar-b-2026-01-15.md`]: `---
id: omg/fact.similar-b
description: User prefers dark mode in editor
type: fact
priority: medium
created: 2026-01-01T00:00:00Z
updated: 2026-01-15T00:00:00Z
canonicalKey: facts.similar-b
---
Editor dark mode.`,
    })

    const llm = makeMockLlm('{"suggestions":[]}')
    const result = await runSemanticDedup({ omgRoot: OMG_ROOT, config, llmClient: llm })
    expect(result.mergesExecuted).toBe(0)
  })

  it('filters suggestions below semanticMergeThreshold', async () => {
    const config = parseConfig({
      semanticDedup: {
        enabled: true,
        heuristicPrefilterThreshold: 0.1,
        semanticMergeThreshold: 90,
      },
    })

    vol.fromJSON({
      [`${OMG_ROOT}/nodes/fact/fact.low-sim-a-2026-01-15.md`]: `---
id: omg/fact.low-sim-a
description: A similar fact variant one
type: fact
priority: medium
created: 2026-01-01T00:00:00Z
updated: 2026-01-15T00:00:00Z
canonicalKey: facts.low-sim-a
---
Content A.`,
      [`${OMG_ROOT}/nodes/fact/fact.low-sim-b-2026-01-15.md`]: `---
id: omg/fact.low-sim-b
description: A similar fact variant two
type: fact
priority: medium
created: 2026-01-01T00:00:00Z
updated: 2026-01-15T00:00:00Z
canonicalKey: facts.low-sim-b
---
Content B.`,
    })

    // LLM returns suggestion with score 70, below threshold of 90
    const llm = makeMockLlm(JSON.stringify({
      suggestions: [{
        keepNodeId: 'omg/fact.low-sim-a',
        mergeNodeIds: ['omg/fact.low-sim-b'],
        similarityScore: 70,
        rationale: 'Somewhat similar',
      }],
    }))

    const result = await runSemanticDedup({ omgRoot: OMG_ROOT, config, llmClient: llm })
    // Suggestion was filtered because 70 < 90
    expect(result.mergesExecuted).toBe(0)
  })

  it('collects errors without throwing on LLM failure', async () => {
    const config = parseConfig({
      semanticDedup: {
        enabled: true,
        heuristicPrefilterThreshold: 0.1,
      },
    })

    vol.fromJSON({
      [`${OMG_ROOT}/nodes/fact/fact.err-a-2026-01-15.md`]: `---
id: omg/fact.err-a
description: Error test fact alpha
type: fact
priority: medium
created: 2026-01-01T00:00:00Z
updated: 2026-01-15T00:00:00Z
canonicalKey: facts.err-a
---
Content.`,
      [`${OMG_ROOT}/nodes/fact/fact.err-b-2026-01-15.md`]: `---
id: omg/fact.err-b
description: Error test fact beta
type: fact
priority: medium
created: 2026-01-01T00:00:00Z
updated: 2026-01-15T00:00:00Z
canonicalKey: facts.err-b
---
Content.`,
    })

    const llm: LlmClient = {
      generate: vi.fn().mockRejectedValue(new Error('LLM boom')),
    }

    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runSemanticDedup({ omgRoot: OMG_ROOT, config, llmClient: llm })
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toContain('LLM')
  })
})
