/**
 * Phase 6 — Context injection live tests.
 *
 * Tests `beforeAgentStart()` with the real Secretary workspace.
 * Zero LLM cost — reads graph files and scores/renders only.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import {
  requireLiveEnv,
  readOpenClawConfig,
  writeArtifact,
  SECRETARY_WORKSPACE,
  ARTIFACTS_DIR,
} from './helpers.js'

let beforeAgentStart: typeof import('../../src/hooks/before-agent-start.js')['beforeAgentStart']
let parseConfig: typeof import('../../src/config.js')['parseConfig']

const omgRoot = path.join(SECRETARY_WORKSPACE, 'memory/omg')

beforeAll(async () => {
  requireLiveEnv()

  const hookMod = await import('../../src/hooks/before-agent-start.js')
  beforeAgentStart = hookMod.beforeAgentStart

  const configMod = await import('../../src/config.js')
  parseConfig = configMod.parseConfig
})

// ---------------------------------------------------------------------------
// Shared context builder
// ---------------------------------------------------------------------------

function buildCtx(prompt: string) {
  const openclawConfig = readOpenClawConfig()
  const config = parseConfig(openclawConfig.pluginConfig)
  return {
    event: { prompt },
    ctx: {
      workspaceDir: SECRETARY_WORKSPACE,
      sessionKey: 'live-test:phase-6',
      config,
      memoryTools: null,
    },
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — Context injection
// ---------------------------------------------------------------------------

describe('Phase 6 — Context injection', () => {
  it('returns context block for a relevant prompt', async () => {
    const { event, ctx } = buildCtx(
      'What are my coding preferences and recent TypeScript decisions?'
    )
    const result = await beforeAgentStart(event, ctx)

    expect(result).toBeDefined()
    expect(result!.prependContext.length).toBeGreaterThan(0)
    console.log(`[context] prependContext length: ${result!.prependContext.length} chars`)
  })

  it('context block has correct XML wrapper', async () => {
    const { event, ctx } = buildCtx(
      'What are my coding preferences and recent TypeScript decisions?'
    )
    const result = await beforeAgentStart(event, ctx)

    expect(result).toBeDefined()
    expect(result!.prependContext).toContain('<omg-context>')
    expect(result!.prependContext).toContain('</omg-context>')
  })

  it('context includes Memory Index section', async () => {
    const { event, ctx } = buildCtx(
      'What are my coding preferences and recent TypeScript decisions?'
    )
    const result = await beforeAgentStart(event, ctx)

    expect(result).toBeDefined()
    expect(result!.prependContext).toContain('## Memory Index')
  })

  it('context includes at least one node annotation', async () => {
    const { event, ctx } = buildCtx(
      'What are my coding preferences and recent TypeScript decisions?'
    )
    const result = await beforeAgentStart(event, ctx)

    expect(result).toBeDefined()
    // Renderer annotates each injected node with <!-- omg/ prefix
    expect(result!.prependContext).toMatch(/<!-- omg\//)
  })

  it('context is within size budget', async () => {
    const { event, ctx } = buildCtx(
      'What are my coding preferences and recent TypeScript decisions?'
    )
    const result = await beforeAgentStart(event, ctx)

    expect(result).toBeDefined()
    expect(result!.prependContext.length).toBeLessThan(100_000)
  })

  it('non-matching prompt still returns context (index.md always injected)', async () => {
    const { event, ctx } = buildCtx('Tell me a joke')
    const result = await beforeAgentStart(event, ctx)

    // index.md is always injected — even irrelevant prompts get context
    expect(result).toBeDefined()
    expect(result!.prependContext.length).toBeGreaterThan(0)
  })

  it('write context artifact for human inspection', async () => {
    const { event, ctx } = buildCtx(
      'What are my coding preferences and recent TypeScript decisions?'
    )
    const result = await beforeAgentStart(event, ctx)

    if (result) {
      const artifactPath = writeArtifact('context-injection.txt', result.prependContext)
      console.log(`[context] Artifact written to ${artifactPath}`)
    }

    console.log(`[artifacts] Written to ${ARTIFACTS_DIR}`)
    expect(result).toBeDefined()
  })
})
