import { describe, it, expect, vi, beforeEach } from 'vitest'
import { vol } from 'memfs'
import type { LlmClient } from '../../src/llm/client.js'
import type { GraphNode } from '../../src/types.js'
import { parseConfig } from '../../src/config.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

const { runReflection } = await import('../../src/reflector/reflector.js')

const WORKSPACE = '/workspace'
const OMG_ROOT = `${WORKSPACE}/memory/omg`

function makeConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    reflection: { observationTokenThreshold: 40_000 },
    injection: { maxContextTokens: 10_000 },
    ...overrides,
  })
}

function makeMockLlm(xmlResponse?: string): LlmClient {
  const defaultResponse = `
    <reflection>
      <reflection-nodes>
        <node compression-level="0">
          <id>omg/reflection/test-synthesis</id>
          <description>Test synthesis</description>
          <sources>omg/preference-dark-mode</sources>
          <body>## Test\nSynthesised content.</body>
        </node>
      </reflection-nodes>
      <archive-nodes>
        <node-id>omg/preference-dark-mode</node-id>
      </archive-nodes>
      <moc-updates>
        <moc domain="reflections" nodeId="omg/reflection/test-synthesis" action="add" />
      </moc-updates>
      <node-updates></node-updates>
    </reflection>
  `
  return {
    generate: vi.fn().mockResolvedValue({
      content: xmlResponse ?? defaultResponse,
      usage: { inputTokens: 500, outputTokens: 200 },
    }),
  }
}

function makeObservationNode(id: string, body = 'Some observation body content.'): GraphNode {
  return {
    frontmatter: {
      id,
      description: `Node ${id}`,
      type: 'preference',
      priority: 'medium',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    },
    body,
    filePath: `${OMG_ROOT}/nodes/preference/${id.replace(/\//g, '-')}.md`,
  }
}

beforeEach(() => {
  vol.reset()
  vol.fromJSON({
    [`${OMG_ROOT}/nodes/preference/preference-dark-mode-2026-01-01.md`]: `---
id: omg/preference-dark-mode
description: User prefers dark mode
type: preference
priority: medium
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
---
The user prefers dark mode in all editors.`,
    [`${OMG_ROOT}/nodes/fact/fact-something-2026-01-01.md`]: `---
id: omg/fact-something
description: Some fact
type: fact
priority: low
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
---
A standalone fact.`,
  })
})

// ---------------------------------------------------------------------------
// Guard: empty input
// ---------------------------------------------------------------------------

describe('runReflection — empty nodes guard', () => {
  it('returns empty output immediately when observationNodes is empty', async () => {
    const llm = makeMockLlm()
    const result = await runReflection({
      observationNodes: [],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    expect(result.edits).toHaveLength(0)
    expect(result.deletions).toHaveLength(0)
    expect(result.tokensUsed).toBe(0)
    expect(llm.generate).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// LLM error handling
// ---------------------------------------------------------------------------

describe('runReflection — LLM error', () => {
  it('returns empty output when LLM throws', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const llm: LlmClient = {
      generate: vi.fn().mockRejectedValue(new Error('Network timeout')),
    }

    const result = await runReflection({
      observationNodes: [makeObservationNode('omg/preference/dark-mode')],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    expect(result.edits).toHaveLength(0)
    expect(result.deletions).toHaveLength(0)
    expect(result.tokensUsed).toBe(0)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('LLM call failed'),
      expect.anything(),
    )
    errorSpy.mockRestore()
  })

  it('does not throw when LLM fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const llm: LlmClient = {
      generate: vi.fn().mockRejectedValue(new Error('Server error')),
    }

    await expect(
      runReflection({
        observationNodes: [makeObservationNode('omg/preference/dark-mode')],
        config: makeConfig(),
        llmClient: llm,
        omgRoot: OMG_ROOT,
        sessionKey: 'test',
      })
    ).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// L0 sufficient — no retry
// ---------------------------------------------------------------------------

describe('runReflection — L0 sufficient', () => {
  it('calls LLM exactly once when L0 output fits within threshold', async () => {
    // Short body — well within 10,000 token threshold
    const llm = makeMockLlm()
    const config = makeConfig({ injection: { maxContextTokens: 10_000 } })

    await runReflection({
      observationNodes: [makeObservationNode('omg/preference/dark-mode')],
      config,
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    expect(llm.generate).toHaveBeenCalledTimes(1)
    // Should have been called at compression level 0
    const callArgs = (llm.generate as ReturnType<typeof vi.fn>).mock.calls[0]![0]
    expect(callArgs.user).toContain('## Compression Level\n0')
  })

  it('writes reflection nodes to disk', async () => {
    const llm = makeMockLlm()
    const { fs } = await import('memfs')

    await runReflection({
      observationNodes: [makeObservationNode('omg/preference/dark-mode')],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    // Check that a reflection file was created
    const reflectionsDir = `${OMG_ROOT}/reflections`
    const files = fs.readdirSync(reflectionsDir) as string[]
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((f) => f.includes('reflection') && f.endsWith('.md'))).toBe(true)
  })

  it('returns edits with the written reflection node', async () => {
    const llm = makeMockLlm()

    const result = await runReflection({
      observationNodes: [makeObservationNode('omg/preference/dark-mode')],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    expect(result.edits).toHaveLength(1)
    expect(result.edits[0]!.targetId).toBe('omg/reflection/test-synthesis')
  })

  it('returns archive IDs in deletions', async () => {
    const llm = makeMockLlm()

    const result = await runReflection({
      observationNodes: [makeObservationNode('omg/preference/dark-mode')],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    expect(result.deletions).toContain('omg/preference-dark-mode')
  })

  it('sets archived: true on archived nodes', async () => {
    const llm = makeMockLlm()
    const { fs } = await import('memfs')

    await runReflection({
      observationNodes: [makeObservationNode('omg/preference/dark-mode')],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    const nodeContent = fs.readFileSync(
      `${OMG_ROOT}/nodes/preference/preference-dark-mode-2026-01-01.md`,
      'utf-8',
    ) as string
    expect(nodeContent).toContain('archived: true')
  })
})

// ---------------------------------------------------------------------------
// Progressive compression — L0 too large → L1 fits
// ---------------------------------------------------------------------------

describe('runReflection — progressive compression', () => {
  it('escalates to L1 when L0 output is too large', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Config with threshold of 5 tokens: L0 body (100 chars = 25 tokens) doesn't fit,
    // L1 body ('ok' = 1 token) fits.
    const config = makeConfig({ injection: { maxContextTokens: 5 } })

    // L0 response: large body; L1 response: tiny body that fits
    const largeBody = 'x'.repeat(100) // 25 tokens — does not fit within 5
    const smallBody = 'ok' // 1 token — fits within 5

    const generateMock = vi.fn()
      .mockResolvedValueOnce({
        // L0 call
        content: `<reflection>
          <reflection-nodes>
            <node compression-level="0">
              <id>omg/reflection/large</id>
              <description>Large node</description>
              <sources></sources>
              <body>${largeBody}</body>
            </node>
          </reflection-nodes>
          <archive-nodes></archive-nodes>
          <moc-updates></moc-updates>
          <node-updates></node-updates>
        </reflection>`,
        usage: { inputTokens: 100, outputTokens: 100 },
      })
      .mockResolvedValueOnce({
        // L1 call
        content: `<reflection>
          <reflection-nodes>
            <node compression-level="1">
              <id>omg/reflection/small</id>
              <description>Small node</description>
              <sources></sources>
              <body>${smallBody}</body>
            </node>
          </reflection-nodes>
          <archive-nodes></archive-nodes>
          <moc-updates></moc-updates>
          <node-updates></node-updates>
        </reflection>`,
        usage: { inputTokens: 80, outputTokens: 80 },
      })

    const llm: LlmClient = { generate: generateMock }

    const result = await runReflection({
      observationNodes: [makeObservationNode('omg/preference/dark-mode')],
      config,
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
      maxCompressionLevel: 3,
    })

    expect(generateMock).toHaveBeenCalledTimes(2)
    // The L1 call should have compression level 1 in the user prompt
    const l1Call = generateMock.mock.calls[1]![0]
    expect(l1Call.user).toContain('## Compression Level\n1')
    // The result should be from the L1 response
    expect(result.edits[0]!.targetId).toBe('omg/reflection/small')

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Escalating to level 1'))
    warnSpy.mockRestore()
  })

  it('applies L3 result with warning when all levels exceed threshold', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Very low threshold — all levels will exceed it (100-char bodies = 25 tokens > 5)
    const config = makeConfig({ injection: { maxContextTokens: 5 } })

    const alwaysLargeResponse = (level: number) => `<reflection>
      <reflection-nodes>
        <node compression-level="${level}">
          <id>omg/reflection/always-large-${level}</id>
          <description>Always large at level ${level}</description>
          <sources></sources>
          <body>${'x'.repeat(100)}</body>
        </node>
      </reflection-nodes>
      <archive-nodes></archive-nodes>
      <moc-updates></moc-updates>
      <node-updates></node-updates>
    </reflection>`

    const generateMock = vi.fn()
      .mockResolvedValueOnce({ content: alwaysLargeResponse(0), usage: { inputTokens: 100, outputTokens: 100 } })
      .mockResolvedValueOnce({ content: alwaysLargeResponse(1), usage: { inputTokens: 90, outputTokens: 90 } })
      .mockResolvedValueOnce({ content: alwaysLargeResponse(2), usage: { inputTokens: 80, outputTokens: 80 } })
      .mockResolvedValueOnce({ content: alwaysLargeResponse(3), usage: { inputTokens: 70, outputTokens: 70 } })

    const llm: LlmClient = { generate: generateMock }

    const result = await runReflection({
      observationNodes: [makeObservationNode('omg/preference/dark-mode')],
      config,
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
      maxCompressionLevel: 3,
    })

    // Should have tried all 4 levels (0, 1, 2, 3)
    expect(generateMock).toHaveBeenCalledTimes(4)
    // Result should be from L3 (best-effort)
    expect(result.edits[0]!.targetId).toBe('omg/reflection/always-large-3')
    // Warning about exceeding threshold should be logged
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('best-effort'))

    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// MOC updates applied
// ---------------------------------------------------------------------------

describe('runReflection — MOC updates', () => {
  it('creates a MOC file when moc-updates are present', async () => {
    const llm = makeMockLlm()
    const { fs } = await import('memfs')

    await runReflection({
      observationNodes: [makeObservationNode('omg/preference/dark-mode')],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    const mocPath = `${OMG_ROOT}/mocs/moc-reflections.md`
    expect(fs.existsSync(mocPath)).toBe(true)
    const content = fs.readFileSync(mocPath, 'utf-8') as string
    expect(content).toContain('omg/reflection/test-synthesis')
  })
})

// ---------------------------------------------------------------------------
// applyNodeFieldUpdate — field dispatch paths
// ---------------------------------------------------------------------------

describe('runReflection — node-updates: body field', () => {
  it('sets body when action is "set"', async () => {
    const nodeId = 'omg/fact-something'
    const nodeFile = `${OMG_ROOT}/nodes/fact/fact-something-2026-01-01.md`
    const llm = makeMockLlm(`
      <reflection>
        <reflection-nodes></reflection-nodes>
        <archive-nodes></archive-nodes>
        <moc-updates></moc-updates>
        <node-updates>
          <update targetId="${nodeId}" field="body" action="set">Replaced body content.</update>
        </node-updates>
      </reflection>`)
    const { fs } = await import('memfs')

    await runReflection({
      observationNodes: [makeObservationNode(nodeId)],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    const content = fs.readFileSync(nodeFile, 'utf-8') as string
    expect(content).toContain('Replaced body content.')
    expect(content).not.toContain('A standalone fact.')
  })

  it('appends to body when action is "add"', async () => {
    const nodeId = 'omg/fact-something'
    const nodeFile = `${OMG_ROOT}/nodes/fact/fact-something-2026-01-01.md`
    const llm = makeMockLlm(`
      <reflection>
        <reflection-nodes></reflection-nodes>
        <archive-nodes></archive-nodes>
        <moc-updates></moc-updates>
        <node-updates>
          <update targetId="${nodeId}" field="body" action="add">Appended line.</update>
        </node-updates>
      </reflection>`)
    const { fs } = await import('memfs')

    await runReflection({
      observationNodes: [makeObservationNode(nodeId)],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    const content = fs.readFileSync(nodeFile, 'utf-8') as string
    expect(content).toContain('A standalone fact.')
    expect(content).toContain('Appended line.')
  })
})

describe('runReflection — node-updates: tags field', () => {
  it('adds a tag when action is "add"', async () => {
    const nodeId = 'omg/fact-something'
    const nodeFile = `${OMG_ROOT}/nodes/fact/fact-something-2026-01-01.md`
    const llm = makeMockLlm(`
      <reflection>
        <reflection-nodes></reflection-nodes>
        <archive-nodes></archive-nodes>
        <moc-updates></moc-updates>
        <node-updates>
          <update targetId="${nodeId}" field="tags" action="add">important</update>
        </node-updates>
      </reflection>`)
    const { fs } = await import('memfs')

    await runReflection({
      observationNodes: [makeObservationNode(nodeId)],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    const content = fs.readFileSync(nodeFile, 'utf-8') as string
    expect(content).toContain('important')
  })

  it('sets tags when action is "set"', async () => {
    const nodeId = 'omg/fact-something'
    const nodeFile = `${OMG_ROOT}/nodes/fact/fact-something-2026-01-01.md`
    const llm = makeMockLlm(`
      <reflection>
        <reflection-nodes></reflection-nodes>
        <archive-nodes></archive-nodes>
        <moc-updates></moc-updates>
        <node-updates>
          <update targetId="${nodeId}" field="tags" action="set">alpha, beta</update>
        </node-updates>
      </reflection>`)
    const { fs } = await import('memfs')

    await runReflection({
      observationNodes: [makeObservationNode(nodeId)],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    const content = fs.readFileSync(nodeFile, 'utf-8') as string
    expect(content).toContain('alpha')
    expect(content).toContain('beta')
  })

  it('removes a tag when action is "remove"', async () => {
    // Set up node with tags to remove
    vol.fromJSON({
      ...vol.toJSON(),
      [`${OMG_ROOT}/nodes/fact/fact-tagged-2026-01-01.md`]: `---
id: omg/fact-tagged
description: Tagged fact
type: fact
priority: medium
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
tags:
  - removeme
  - keepme
---
Tagged content.`,
    })
    const nodeId = 'omg/fact-tagged'
    const nodeFile = `${OMG_ROOT}/nodes/fact/fact-tagged-2026-01-01.md`
    const llm = makeMockLlm(`
      <reflection>
        <reflection-nodes></reflection-nodes>
        <archive-nodes></archive-nodes>
        <moc-updates></moc-updates>
        <node-updates>
          <update targetId="${nodeId}" field="tags" action="remove">removeme</update>
        </node-updates>
      </reflection>`)
    const { fs } = await import('memfs')

    await runReflection({
      observationNodes: [makeObservationNode(nodeId)],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    const content = fs.readFileSync(nodeFile, 'utf-8') as string
    expect(content).not.toContain('removeme')
    expect(content).toContain('keepme')
  })
})

describe('runReflection — node-updates: priority field', () => {
  it('sets priority when action is "set"', async () => {
    const nodeId = 'omg/fact-something'
    const nodeFile = `${OMG_ROOT}/nodes/fact/fact-something-2026-01-01.md`
    const llm = makeMockLlm(`
      <reflection>
        <reflection-nodes></reflection-nodes>
        <archive-nodes></archive-nodes>
        <moc-updates></moc-updates>
        <node-updates>
          <update targetId="${nodeId}" field="priority" action="set">high</update>
        </node-updates>
      </reflection>`)
    const { fs } = await import('memfs')

    await runReflection({
      observationNodes: [makeObservationNode(nodeId)],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    const content = fs.readFileSync(nodeFile, 'utf-8') as string
    expect(content).toContain('priority: high')
  })
})

// ---------------------------------------------------------------------------
// tokensUsed in output
// ---------------------------------------------------------------------------

describe('runReflection — tokensUsed', () => {
  it('returns tokensUsed from the LLM response', async () => {
    const llm: LlmClient = {
      generate: vi.fn().mockResolvedValue({
        content: `<reflection>
          <reflection-nodes>
            <node compression-level="0">
              <id>omg/reflection/test</id>
              <description>Test</description>
              <sources></sources>
              <body>Short body.</body>
            </node>
          </reflection-nodes>
          <archive-nodes></archive-nodes>
          <moc-updates></moc-updates>
          <node-updates></node-updates>
        </reflection>`,
        usage: { inputTokens: 300, outputTokens: 150 },
      }),
    }

    const result = await runReflection({
      observationNodes: [makeObservationNode('omg/preference/dark-mode')],
      config: makeConfig(),
      llmClient: llm,
      omgRoot: OMG_ROOT,
      sessionKey: 'test',
    })

    expect(result.tokensUsed).toBe(450) // 300 + 150
  })
})
