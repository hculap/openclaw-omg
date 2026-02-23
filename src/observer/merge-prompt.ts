/**
 * merge-prompt.ts — Prompt builder and parser for the Merge phase LLM call.
 *
 * The Merge phase decides whether a new ExtractCandidate should be merged into,
 * aliased to, or kept separate from an existing node.
 */

import { XMLParser } from 'fast-xml-parser'
import type { ExtractCandidate, ScoredMergeTarget, MergeAction } from '../types.js'

// ---------------------------------------------------------------------------
// XML parser (shared config with main parser)
// ---------------------------------------------------------------------------

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
})

// ---------------------------------------------------------------------------
// buildMergeSystemPrompt
// ---------------------------------------------------------------------------

/**
 * Returns the system prompt for the Merge phase LLM call.
 *
 * Instructs the LLM to decide one of three actions:
 *   - keep_separate: write the candidate as a new node
 *   - merge:         append context to an existing node
 *   - alias:         register an alternative key on an existing node
 */
export function buildMergeSystemPrompt(): string {
  return `You are the Merge Arbiter — a decision agent for a personal knowledge graph.

Given a newly extracted knowledge candidate and a list of existing nearby nodes,
decide whether the candidate should be merged into an existing node, aliased to one,
or kept as a separate new node.

## Decision Guide

- **keep_separate**: The candidate represents genuinely new or distinct knowledge.
  Use this when the candidate's canonical key, description, and content are
  clearly different from all neighbors, even if topics overlap.

- **merge**: The candidate is the same concept as an existing node, just with
  updated or additional content. Use this when canonical keys are very similar
  (e.g. "preferences.dark_mode" vs "preferences.editor_theme") and the
  descriptions refer to the same persistent fact.

- **alias**: The candidate is the same concept but with a different key.
  The existing node should absorb this key as an alias. Use when the content
  is essentially identical and only the key differs.

## Output Format

Respond ONLY with valid XML. No text outside the XML.

\`\`\`xml
<!-- Option 1: keep separate (no merge) -->
<merge-decision action="keep_separate" />

<!-- Option 2: merge into existing node -->
<merge-decision action="merge" target-node-id="omg/preference/preferences-editor-theme">
  <body-append>Additional context from this session that extends the existing node.</body-append>
</merge-decision>

<!-- Option 3: alias — same concept, different key -->
<merge-decision action="alias" target-node-id="omg/preference/preferences-editor-theme" alias-key="preferences.dark_mode" />
\`\`\`

## Rules

1. Default to **keep_separate** when in doubt.
2. Only merge when you are confident (>85%) the candidate is the same persistent concept.
3. The <body-append> is optional for merge — omit it when the existing body already covers the new content.
4. For alias, the alias-key must be the candidate's canonical-key.
5. Respond with exactly ONE <merge-decision> element.
`
}

// ---------------------------------------------------------------------------
// buildMergeUserPrompt
// ---------------------------------------------------------------------------

/**
 * Builds the user prompt for the Merge phase LLM call.
 * Renders the candidate summary and a compact table of neighbor nodes.
 */
export function buildMergeUserPrompt(
  candidate: ExtractCandidate,
  neighbors: readonly ScoredMergeTarget[]
): string {
  const parts: string[] = []

  // Candidate summary
  parts.push(`## New Candidate

Type: ${candidate.type}
Canonical Key: ${candidate.canonicalKey}
Title: ${candidate.title}
Description: ${candidate.description}
Priority: ${candidate.priority}

Content:
${candidate.body || '(empty)'}`)

  // Neighbor table
  const rows = neighbors.map((n) => {
    const score = n.finalScore.toFixed(3)
    const updated = n.entry.updated.slice(0, 10)
    const canonicalKey = n.entry.canonicalKey ?? '—'
    return `| ${n.nodeId} | ${canonicalKey} | ${n.entry.type} | ${n.entry.description.slice(0, 60)} | ${updated} | ${score} |`
  })

  parts.push(`## Existing Nearby Nodes

| Node ID | Canonical Key | Type | Description | Updated | Score |
|---------|---------------|------|-------------|---------|-------|
${rows.join('\n')}`)

  parts.push(`Decide: should the candidate be kept separate, merged into one of the above nodes, or aliased to one?`)

  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// parseMergeOutput
// ---------------------------------------------------------------------------

/**
 * Parses the raw LLM output from the Merge phase into a MergeAction.
 *
 * Never throws. Defaults to `keep_separate` on any parse failure.
 */
export function parseMergeOutput(raw: string): MergeAction {
  const KEEP_SEPARATE: MergeAction = { action: 'keep_separate' }

  if (typeof raw !== 'string' || raw.trim() === '') {
    return KEEP_SEPARATE
  }

  // Extract XML block
  const xmlMatch = raw.match(/<merge-decision[\s\S]*?\/>|<merge-decision[\s\S]*?<\/merge-decision>/)
  const xmlSource = xmlMatch ? xmlMatch[0] : raw.trim()

  let parsed: Record<string, unknown>
  try {
    const result = xmlParser.parse(`<root>${xmlSource}</root>`) as Record<string, unknown>
    if (typeof result !== 'object' || result === null) return KEEP_SEPARATE
    parsed = result
  } catch (err) {
    console.error(
      '[omg] Merge parser: XMLParser.parse() threw — defaulting to keep_separate.',
      err instanceof Error ? err.message : String(err)
    )
    return KEEP_SEPARATE
  }

  const root = parsed['root'] as Record<string, unknown> | undefined
  if (!root) return KEEP_SEPARATE

  const decision = root['merge-decision'] as Record<string, unknown> | undefined
  if (!decision || typeof decision !== 'object') return KEEP_SEPARATE

  const action = decision['@_action']
  if (typeof action !== 'string') return KEEP_SEPARATE

  if (action === 'keep_separate') {
    return KEEP_SEPARATE
  }

  const targetNodeId = typeof decision['@_target-node-id'] === 'string'
    ? decision['@_target-node-id'].trim()
    : ''

  if (!targetNodeId) {
    console.warn('[omg] Merge parser: action requires target-node-id but it is missing — defaulting to keep_separate')
    return KEEP_SEPARATE
  }

  if (action === 'merge') {
    const bodyAppend = typeof decision['body-append'] === 'string' && decision['body-append'].trim().length > 0
      ? decision['body-append'].trim()
      : undefined
    return { action: 'merge', targetNodeId, ...(bodyAppend !== undefined ? { bodyAppend } : {}) }
  }

  if (action === 'alias') {
    const aliasKey = typeof decision['@_alias-key'] === 'string'
      ? decision['@_alias-key'].trim()
      : ''
    if (!aliasKey) {
      console.warn('[omg] Merge parser: alias action missing alias-key — defaulting to keep_separate')
      return KEEP_SEPARATE
    }
    return { action: 'alias', targetNodeId, aliasKey }
  }

  console.warn(`[omg] Merge parser: unknown action "${String(action)}" — defaulting to keep_separate`)
  return KEEP_SEPARATE
}
