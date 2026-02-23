/**
 * now-renderer.ts — Deterministic renderer for the [[omg/now]] node.
 *
 * Converts a structured NowPatch into a reproducible markdown string,
 * replacing the previous free-form LLM-written now-update.
 *
 * Properties:
 *   - Idempotent: same inputs → same output
 *   - Size-capped: max 60 lines / 2000 chars (open_loops truncated from end)
 *   - suggestedLinks resolved from canonicalKey → wikilink via computeNodeId
 */

import type { NowPatch } from '../types.js'
import { computeNodeId } from '../utils/id.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_LINES = 60
const MAX_CHARS = 2000

/**
 * Maps canonical key prefixes to node types for wikilink resolution.
 * Extend this map when new node types with canonical-key prefixes are added.
 */
const PREFIX_TO_TYPE: Readonly<Record<string, string>> = {
  preferences: 'preference',
  projects: 'project',
  identity: 'identity',
  decisions: 'decision',
  facts: 'fact',
  episodes: 'episode',
}

// ---------------------------------------------------------------------------
// resolveCanonicalKeyToWikilink
// ---------------------------------------------------------------------------

/**
 * Resolves a canonical key (e.g. "preferences.editor_theme") to an OMG
 * wikilink (e.g. "[[omg/preference/preferences-editor-theme]]").
 *
 * Returns null when the key prefix is not recognised (cannot infer type).
 */
export function resolveCanonicalKeyToWikilink(canonicalKey: string): string | null {
  if (!canonicalKey || !canonicalKey.includes('.')) return null

  const prefix = canonicalKey.slice(0, canonicalKey.indexOf('.'))
  const type = PREFIX_TO_TYPE[prefix]
  if (!type) return null

  const nodeId = computeNodeId(type, canonicalKey)
  return `[[${nodeId}]]`
}

// ---------------------------------------------------------------------------
// renderNowPatch
// ---------------------------------------------------------------------------

/**
 * Renders a NowPatch into a markdown string suitable for the [[omg/now]] node body.
 *
 * Sections rendered (in order):
 *   ## Current Focus — the focus sentence
 *   ## Open Loops    — bullet list of open_loops (truncated to fit budget)
 *   ## Recent Nodes  — wikilinks from recentNodeIds
 *   ## Related       — wikilinks resolved from suggestedLinks canonical keys
 *
 * Size cap: max 60 lines / 2000 chars. Open loops are truncated from the
 * end if the budget would be exceeded.
 */
export function renderNowPatch(patch: NowPatch, recentNodeIds: readonly string[]): string {
  const parts: string[] = []

  // ## Current Focus
  parts.push(`## Current Focus\n${patch.focus}`)

  // ## Open Loops (truncated to fit budget)
  if (patch.openLoops.length > 0) {
    const loops = patch.openLoops.map((l) => `- ${l}`)
    parts.push(`## Open Loops\n${loops.join('\n')}`)
  }

  // ## Recent Nodes
  if (recentNodeIds.length > 0) {
    const links = recentNodeIds.map((id) => `- [[${id}]]`)
    parts.push(`## Recent Nodes\n${links.join('\n')}`)
  }

  // ## Related — resolve canonical keys to wikilinks
  const resolvedLinks = patch.suggestedLinks
    .map(resolveCanonicalKeyToWikilink)
    .filter((l): l is string => l !== null)
  if (resolvedLinks.length > 0) {
    parts.push(`## Related\n${resolvedLinks.map((l) => `- ${l}`).join('\n')}`)
  }

  const raw = parts.join('\n\n')
  return applyBudget(raw)
}

// ---------------------------------------------------------------------------
// shouldUpdateNow
// ---------------------------------------------------------------------------

/**
 * Returns true when the now node should be (re)written.
 *
 * Triggers:
 *   (a) currentContent is null (first write)
 *   (b) rendered content would differ from currentContent
 *   (c) open_loops changed (detected by comparing rendered open loops section)
 *
 * The caller should additionally gate on `nodesChanged > 0 || openLoopsChanged`
 * before calling this, to avoid LLM and write overhead on quiet turns.
 */
export function shouldUpdateNow(currentContent: string | null, patch: NowPatch): boolean {
  if (currentContent === null) return true

  // Check if focus changed
  const focusLine = `## Current Focus\n${patch.focus}`
  if (!currentContent.includes(focusLine)) return true

  // Check if open loops changed (compare rendered loops section)
  if (patch.openLoops.length > 0) {
    const loopLines = patch.openLoops.map((l) => `- ${l}`).join('\n')
    const loopSection = `## Open Loops\n${loopLines}`
    if (!currentContent.includes(loopSection)) return true
  } else if (currentContent.includes('## Open Loops')) {
    // Had open loops, now none
    return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Applies the line and character budget to rendered content.
 * Truncates trailing lines if over budget.
 */
function applyBudget(content: string): string {
  if (content.length <= MAX_CHARS && content.split('\n').length <= MAX_LINES) {
    return content
  }

  const lines = content.split('\n')
  const truncatedLines = lines.slice(0, MAX_LINES)
  const truncated = truncatedLines.join('\n')

  if (truncated.length <= MAX_CHARS) {
    console.warn(`[omg] now-renderer: content truncated to ${MAX_LINES} lines (was ${lines.length} lines)`)
    return truncated
  }

  console.warn(
    `[omg] now-renderer: content truncated to ${MAX_CHARS} chars after line truncation ` +
    `(was ${truncated.length} chars, ${lines.length} lines)`
  )
  return truncated.slice(0, MAX_CHARS)
}
