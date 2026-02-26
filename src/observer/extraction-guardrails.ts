/**
 * Upstream extraction guardrails for the observer stage.
 *
 * Two layers of protection against repeated/overlapping source content:
 *   1. Pre-extraction: detects overlapping source windows via shingle fingerprints
 *   2. Post-extraction: suppresses near-duplicate candidates against recent nodes
 *
 * Zero LLM cost — all operations are pure heuristic.
 */
import type { Message, ExtractCandidate } from '../types.js'
import type { RegistryNodeEntry } from '../graph/registry.js'
import type { OmgConfig } from '../config.js'
import { buildFingerprint, computeOverlap, type SourceFingerprint } from './source-fingerprint.js'
import { combinedSimilarity } from '../dedup/similarity.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Decision from the pre-extraction overlap check. */
export interface GuardrailDecision {
  readonly action: 'proceed' | 'truncate' | 'skip'
  readonly overlapScore: number
  readonly originalMessageCount: number
  readonly filteredMessageCount: number
}

/** Result from the post-extraction candidate suppression. */
export interface SuppressionResult {
  readonly survivors: readonly ExtractCandidate[]
  readonly suppressed: readonly string[]
}

// ---------------------------------------------------------------------------
// Pre-extraction: source overlap detection
// ---------------------------------------------------------------------------

/**
 * Checks whether the current message window overlaps with recent observation
 * windows. Returns a decision on how to proceed.
 *
 * - overlap > skipThreshold → skip extraction entirely
 * - overlap > truncateThreshold → truncate to non-overlapping messages
 * - otherwise → proceed normally
 */
export function checkSourceOverlap(
  messages: readonly Message[],
  recentFingerprints: readonly SourceFingerprint[],
  config: OmgConfig,
): GuardrailDecision {
  const guardrailConfig = config.extractionGuardrails

  if (!guardrailConfig.enabled || recentFingerprints.length === 0 || messages.length === 0) {
    return {
      action: 'proceed',
      overlapScore: 0,
      originalMessageCount: messages.length,
      filteredMessageCount: messages.length,
    }
  }

  const currentFingerprint = buildFingerprint(messages)

  // Find maximum overlap against any recent fingerprint
  let maxOverlap = 0
  for (const recent of recentFingerprints) {
    const overlap = computeOverlap(currentFingerprint, recent)
    if (overlap > maxOverlap) maxOverlap = overlap
  }

  if (maxOverlap >= guardrailConfig.skipOverlapThreshold) {
    return {
      action: 'skip',
      overlapScore: maxOverlap,
      originalMessageCount: messages.length,
      filteredMessageCount: 0,
    }
  }

  if (maxOverlap >= guardrailConfig.truncateOverlapThreshold) {
    // Linear scan from full window downward to find the largest non-overlapping suffix.
    const truncatedCount = findNonOverlappingSuffix(messages, recentFingerprints, guardrailConfig.truncateOverlapThreshold)
    return {
      action: 'truncate',
      overlapScore: maxOverlap,
      originalMessageCount: messages.length,
      filteredMessageCount: truncatedCount,
    }
  }

  return {
    action: 'proceed',
    overlapScore: maxOverlap,
    originalMessageCount: messages.length,
    filteredMessageCount: messages.length,
  }
}

/**
 * Finds the largest trailing suffix of messages whose overlap with recent
 * fingerprints falls below the given threshold. Scans from the full window
 * downward, returning the first count where overlap is acceptable.
 */
function findNonOverlappingSuffix(
  messages: readonly Message[],
  recentFingerprints: readonly SourceFingerprint[],
  threshold: number,
): number {
  // Start with the full window and shrink until overlap is acceptable
  for (let count = messages.length; count >= 1; count--) {
    const suffix = messages.slice(messages.length - count)
    const fp = buildFingerprint(suffix)

    let maxOverlap = 0
    for (const recent of recentFingerprints) {
      const overlap = computeOverlap(fp, recent)
      if (overlap > maxOverlap) maxOverlap = overlap
    }

    if (maxOverlap < threshold) {
      return count
    }
  }

  // All messages overlap — return minimum of 1 to avoid empty extraction
  return 1
}

// ---------------------------------------------------------------------------
// Post-extraction: candidate suppression
// ---------------------------------------------------------------------------

/**
 * Suppresses candidates that are near-duplicates of recently written nodes.
 * Uses combinedSimilarity (key + description) against registry entries
 * for nodes written in recent observation cycles.
 */
export function suppressDuplicateCandidates(
  candidates: readonly ExtractCandidate[],
  recentNodeIds: readonly string[],
  registryEntries: readonly [string, RegistryNodeEntry][],
  config: OmgConfig,
): SuppressionResult {
  const guardrailConfig = config.extractionGuardrails

  if (!guardrailConfig.enabled || recentNodeIds.length === 0) {
    return { survivors: candidates, suppressed: [] }
  }

  // Build lookup of recent entries
  const recentEntryMap = new Map<string, RegistryNodeEntry>()
  for (const [id, entry] of registryEntries) {
    if (recentNodeIds.includes(id)) {
      recentEntryMap.set(id, entry)
    }
  }

  if (recentEntryMap.size === 0) {
    return { survivors: candidates, suppressed: [] }
  }

  const survivors: ExtractCandidate[] = []
  const suppressed: string[] = []

  for (const candidate of candidates) {
    let isDuplicate = false

    for (const [, recentEntry] of recentEntryMap) {
      const sim = combinedSimilarity(
        candidate.description,
        recentEntry.description,
        candidate.canonicalKey,
        recentEntry.canonicalKey ?? '',
      )

      if (sim >= guardrailConfig.candidateSuppressionThreshold) {
        isDuplicate = true
        break
      }
    }

    if (isDuplicate) {
      suppressed.push(candidate.canonicalKey)
    } else {
      survivors.push(candidate)
    }
  }

  return { survivors, suppressed }
}

// ---------------------------------------------------------------------------
// Fingerprint management
// ---------------------------------------------------------------------------

/**
 * Updates the rolling window of recent source fingerprints.
 * Appends the new fingerprint and trims to the configured window size.
 */
export function updateRecentFingerprints(
  existing: readonly SourceFingerprint[],
  newFingerprint: SourceFingerprint,
  windowSize: number,
): readonly SourceFingerprint[] {
  const updated = [...existing, newFingerprint]
  if (updated.length > windowSize) {
    return updated.slice(updated.length - windowSize)
  }
  return updated
}
