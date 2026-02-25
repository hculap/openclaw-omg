/**
 * Phase 10 — Parser Recovery live tests.
 *
 * Validates the parser recovery features against real LLM output:
 *   1. Captures raw LLM XML response from the gateway
 *   2. Mutates it to simulate common malformations (uppercase types,
 *      missing keys, wrong root elements)
 *   3. Feeds the mutated XML through the parser and verifies recovery
 *   4. Also tests that unmodified LLM output still parses correctly
 *
 * This tests the DoD requirement: "Feed real chunk data through the
 * observer and verify nodes are generated correctly."
 *
 * COST: 1 Sonnet call ≈ $0.05-$0.10.
 */

import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  requireLiveEnv,
  readOpenClawConfig,
  wrapGenerateFnWithTracker,
  llmTracker,
  ensureArtifactsDir,
  ARTIFACTS_DIR,
} from './helpers.js'

let parseExtractOutput: typeof import('../../src/observer/parser.js')['parseExtractOutput']
let parseExtractOutputWithDiagnostics: typeof import('../../src/observer/parser.js')['parseExtractOutputWithDiagnostics']
let buildExtractSystemPrompt: typeof import('../../src/observer/prompts.js')['buildExtractSystemPrompt']
let buildExtractUserPrompt: typeof import('../../src/observer/prompts.js')['buildExtractUserPrompt']
let createLlmClient: typeof import('../../src/llm/client.js')['createLlmClient']
let createGatewayCompletionsGenerateFn: typeof import('../../src/llm/gateway-completions.js')['createGatewayCompletionsGenerateFn']

/** Raw LLM response captured from the gateway. */
let capturedRawXml = ''

/** Accumulates test output for artifact dump. */
const testLog: string[] = []
function log(msg: string): void {
  testLog.push(msg)
  console.log(msg)
}

beforeAll(async () => {
  requireLiveEnv()

  const parser = await import('../../src/observer/parser.js')
  parseExtractOutput = parser.parseExtractOutput
  parseExtractOutputWithDiagnostics = parser.parseExtractOutputWithDiagnostics

  const prompts = await import('../../src/observer/prompts.js')
  buildExtractSystemPrompt = prompts.buildExtractSystemPrompt
  buildExtractUserPrompt = prompts.buildExtractUserPrompt

  const client = await import('../../src/llm/client.js')
  createLlmClient = client.createLlmClient

  const gateway = await import('../../src/llm/gateway-completions.js')
  createGatewayCompletionsGenerateFn = gateway.createGatewayCompletionsGenerateFn
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildRawGenerateFn() {
  const openclawConfig = readOpenClawConfig()
  const rawFn = createGatewayCompletionsGenerateFn({
    port: 18789,
    authToken: openclawConfig.gatewayAuthToken,
  })
  return wrapGenerateFnWithTracker(rawFn, 'phase-10-recovery')
}

// ---------------------------------------------------------------------------
// Step 1: Capture real LLM XML output
// ---------------------------------------------------------------------------

describe('Phase 10 — Capture real LLM response', () => {
  it('sends messages to gateway and captures raw XML response', async () => {
    const generateFn = buildRawGenerateFn()

    const system = buildExtractSystemPrompt()
    const user = buildExtractUserPrompt({
      nowNode: null,
      messages: [
        {
          role: 'user' as const,
          content: [
            'My name is Alice, I live in Berlin with my dog Max.',
            'I always use VS Code with the Monokai theme.',
            'I decided to use Rust for the new backend rewrite.',
            'TypeScript with strict mode is my go-to for frontend work.',
          ].join(' '),
        },
        {
          role: 'assistant' as const,
          content: 'Thanks for sharing all that context! I\'ll remember your preferences and decisions.',
        },
      ],
    })

    const response = await generateFn({ system, user, maxTokens: 4096 })
    capturedRawXml = response.content

    log(`[recovery] Captured raw LLM response (${capturedRawXml.length} chars)`)
    log(`[recovery] First 500 chars:\n${capturedRawXml.slice(0, 500)}`)

    // Basic sanity: response should contain XML-like content
    expect(capturedRawXml.length).toBeGreaterThan(50)
    expect(capturedRawXml).toMatch(/<operation/)
  }, 120_000)
})

// ---------------------------------------------------------------------------
// Step 2: Verify unmodified response parses correctly
// ---------------------------------------------------------------------------

describe('Phase 10 — Baseline: unmodified LLM response', () => {
  it('parses the real LLM response without recovery needed', () => {
    const { output, diagnostics } = parseExtractOutputWithDiagnostics(capturedRawXml)

    log(`[recovery] Baseline: ${diagnostics.accepted}/${diagnostics.totalCandidates} accepted`)
    for (const c of output.candidates) {
      log(`[recovery]   - ${c.type}/${c.canonicalKey}: ${c.title}`)
    }

    expect(output.candidates.length).toBeGreaterThan(0)
    expect(diagnostics.rejected).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Step 3: Mutate and test recovery
// ---------------------------------------------------------------------------

describe('Phase 10 — Recovery: mutated LLM responses', () => {
  it('recovers when type attributes are uppercased', () => {
    // Mutate: replace type="identity" → type="Identity", type="preference" → type="PREFERENCE", etc.
    const mutated = capturedRawXml
      .replace(/type="identity"/gi, 'type="Identity"')
      .replace(/type="preference"/gi, 'type="PREFERENCE"')
      .replace(/type="fact"/gi, 'type="Fact"')
      .replace(/type="decision"/gi, 'type="DECISION"')
      .replace(/type="project"/gi, 'type="Project"')
      .replace(/type="episode"/gi, 'type="Episode"')

    const { output: baseline } = parseExtractOutputWithDiagnostics(capturedRawXml)
    const { output: recovered, diagnostics } = parseExtractOutputWithDiagnostics(mutated)

    log(`[recovery] Uppercase types: ${diagnostics.accepted}/${diagnostics.totalCandidates} accepted`)
    for (const c of recovered.candidates) {
      log(`[recovery]   - ${c.type}/${c.canonicalKey}: ${c.title}`)
    }

    // Should recover the same number of candidates as the baseline
    expect(recovered.candidates.length).toBe(baseline.candidates.length)
    expect(diagnostics.rejected).toHaveLength(0)

    // All types should be lowercase after coercion
    for (const c of recovered.candidates) {
      expect(c.type).toMatch(/^[a-z]+$/)
    }
  })

  it('recovers when <canonical-key> elements are removed (has title)', () => {
    // Mutate: strip all <canonical-key>...</canonical-key> elements
    const mutated = capturedRawXml.replace(/<canonical-key>[^<]*<\/canonical-key>/g, '')

    const { output: baseline } = parseExtractOutputWithDiagnostics(capturedRawXml)
    const { output: recovered, diagnostics } = parseExtractOutputWithDiagnostics(mutated)

    log(`[recovery] Missing keys: ${diagnostics.accepted}/${diagnostics.totalCandidates} accepted`)
    for (const c of recovered.candidates) {
      log(`[recovery]   - ${c.type}/${c.canonicalKey}: ${c.title}`)
    }

    // Candidates that had titles should be recovered with generated keys
    // Some may be lost if they also lacked titles
    const candidatesWithTitles = baseline.candidates.filter(c => c.title.trim().length > 0)
    expect(recovered.candidates.length).toBe(candidatesWithTitles.length)

    // Generated keys should follow the type.slug pattern
    for (const c of recovered.candidates) {
      expect(c.canonicalKey).toMatch(/^[a-z]+\.[a-z0-9_]+$/)
    }
  })

  it('recovers when <observations> root is replaced with <operations> only', () => {
    // Mutate: strip <observations> wrapper, keep just <operations>...</operations>
    const opsMatch = capturedRawXml.match(/<operations[\s\S]*?<\/operations>/)
    if (!opsMatch) {
      console.log('[recovery] SKIP: no <operations> block found in raw response')
      return
    }

    const mutated = opsMatch[0] // bare <operations> without <observations> wrapper

    const { output: baseline } = parseExtractOutputWithDiagnostics(capturedRawXml)
    const { output: recovered, diagnostics } = parseExtractOutputWithDiagnostics(mutated)

    log(`[recovery] Alt root <operations>: ${diagnostics.accepted}/${diagnostics.totalCandidates} accepted`)

    // Should recover same candidates
    expect(recovered.candidates.length).toBe(baseline.candidates.length)
  })

  it('recovers when <observations> is replaced with <output>', () => {
    // Mutate: rename <observations> → <output>
    const mutated = capturedRawXml
      .replace(/<observations/g, '<output')
      .replace(/<\/observations>/g, '</output>')

    const { output: baseline } = parseExtractOutputWithDiagnostics(capturedRawXml)
    const { output: recovered, diagnostics } = parseExtractOutputWithDiagnostics(mutated)

    log(`[recovery] Alt root <output>: ${diagnostics.accepted}/${diagnostics.totalCandidates} accepted`)

    expect(recovered.candidates.length).toBe(baseline.candidates.length)
  })

  it('recovers when <observations> is replaced with <response>', () => {
    // Mutate: rename <observations> → <response>
    const mutated = capturedRawXml
      .replace(/<observations/g, '<response')
      .replace(/<\/observations>/g, '</response>')

    const { output: baseline } = parseExtractOutputWithDiagnostics(capturedRawXml)
    const { output: recovered, diagnostics } = parseExtractOutputWithDiagnostics(mutated)

    log(`[recovery] Alt root <response>: ${diagnostics.accepted}/${diagnostics.totalCandidates} accepted`)

    expect(recovered.candidates.length).toBe(baseline.candidates.length)
  })

  it('recovers from combined mutations: uppercase types + missing keys + alt root', () => {
    // Strip <observations> wrapper
    const opsMatch = capturedRawXml.match(/<operations[\s\S]*?<\/operations>/)
    if (!opsMatch) {
      console.log('[recovery] SKIP: no <operations> block found in raw response')
      return
    }

    // Apply all mutations at once
    const mutated = opsMatch[0]
      .replace(/type="identity"/gi, 'type="IDENTITY"')
      .replace(/type="preference"/gi, 'type="Preferences"')
      .replace(/type="fact"/gi, 'type="Facts"')
      .replace(/type="decision"/gi, 'type="Decision"')
      .replace(/type="project"/gi, 'type="Projects"')
      .replace(/type="episode"/gi, 'type="EPISODE"')
      .replace(/<canonical-key>[^<]*<\/canonical-key>/g, '')

    const { output: baseline } = parseExtractOutputWithDiagnostics(capturedRawXml)
    const { output: recovered, diagnostics } = parseExtractOutputWithDiagnostics(mutated)

    log(`[recovery] Combined mutations: ${diagnostics.accepted}/${diagnostics.totalCandidates} accepted`)
    for (const c of recovered.candidates) {
      log(`[recovery]   - ${c.type}/${c.canonicalKey}: ${c.title}`)
    }

    // Should recover candidates that had titles (key generated from type+title)
    const candidatesWithTitles = baseline.candidates.filter(c => c.title.trim().length > 0)
    expect(recovered.candidates.length).toBe(candidatesWithTitles.length)
    expect(diagnostics.rejected).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

describe('Phase 10 — Summary', () => {
  it('writes recovery test artifact with all results', () => {
    log(`[recovery] ${llmTracker.summary()}`)

    ensureArtifactsDir()
    const artifactPath = path.join(ARTIFACTS_DIR, 'parser-recovery-results.txt')
    fs.writeFileSync(artifactPath, testLog.join('\n'))
    log(`[recovery] Artifact written: ${artifactPath}`)
  })
})
