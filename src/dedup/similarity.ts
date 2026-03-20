/**
 * Pure-function string similarity utilities for the dedup subsystem.
 * Zero dependencies beyond Node built-ins.
 */

// ---------------------------------------------------------------------------
// extractTrigrams
// ---------------------------------------------------------------------------

/**
 * Extracts character trigrams from text, returning a multiset (Map<trigram, count>).
 * Strings shorter than 3 characters produce an empty map.
 */
export function extractTrigrams(text: string): Map<string, number> {
  const result = new Map<string, number>()
  if (text.length < 3) return result

  for (let i = 0; i <= text.length - 3; i++) {
    const trigram = text.slice(i, i + 3)
    result.set(trigram, (result.get(trigram) ?? 0) + 1)
  }
  return result
}

// ---------------------------------------------------------------------------
// trigramJaccard
// ---------------------------------------------------------------------------

/**
 * Computes multiset Jaccard similarity on character trigrams.
 * Range [0, 1]. Returns 0 if both strings produce no trigrams.
 */
export function trigramJaccard(a: string, b: string): number {
  const ta = extractTrigrams(a.toLowerCase())
  const tb = extractTrigrams(b.toLowerCase())

  if (ta.size === 0 && tb.size === 0) return 0

  let intersection = 0
  let union = 0

  const allKeys = new Set([...ta.keys(), ...tb.keys()])
  for (const key of allKeys) {
    const ca = ta.get(key) ?? 0
    const cb = tb.get(key) ?? 0
    intersection += Math.min(ca, cb)
    union += Math.max(ca, cb)
  }

  return union === 0 ? 0 : intersection / union
}

// ---------------------------------------------------------------------------
// tokenize
// ---------------------------------------------------------------------------

/**
 * Tokenizes text into a set of lowercase words, splitting on non-letter/non-digit
 * Unicode boundaries. Filters tokens ≤ 2 chars to reduce noise from articles and
 * prepositions across languages without requiring a language-specific stopword list.
 */
export function tokenize(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u)
  const result = new Set<string>()
  for (const word of words) {
    if (word.length > 2) {
      result.add(word)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// tokenSetJaccard
// ---------------------------------------------------------------------------

/**
 * Computes set Jaccard similarity on word tokens.
 * Range [0, 1]. Returns 0 if both strings produce no tokens.
 */
export function tokenSetJaccard(a: string, b: string): number {
  const ta = tokenize(a)
  const tb = tokenize(b)

  if (ta.size === 0 && tb.size === 0) return 0

  let intersectionCount = 0
  for (const token of ta) {
    if (tb.has(token)) intersectionCount++
  }

  const unionCount = ta.size + tb.size - intersectionCount
  return unionCount === 0 ? 0 : intersectionCount / unionCount
}

// ---------------------------------------------------------------------------
// combinedSimilarity
// ---------------------------------------------------------------------------

/**
 * Combined similarity score: 0.4 * tokenSetJaccard(desc) + 0.6 * trigramJaccard(key).
 * Keys are weighted higher because they are more stable than free-form descriptions.
 * Range [0, 1].
 */
export function combinedSimilarity(
  descA: string,
  descB: string,
  keyA: string,
  keyB: string
): number {
  const descScore = tokenSetJaccard(descA, descB)
  const keyScore = trigramJaccard(keyA, keyB)
  return 0.4 * descScore + 0.6 * keyScore
}

// ---------------------------------------------------------------------------
// keyPrefix
// ---------------------------------------------------------------------------

/**
 * Returns the bucket prefix of a canonical key for dedup grouping.
 *
 * Strategy:
 *   1. If the key contains a dot, return the first dot-segment.
 *      E.g. "preferences.editor_theme" → "preferences".
 *   2. If the key has no dot but contains hyphens, return the first two
 *      hyphen-segments. E.g. "facts-szymon-haircut-march-2026" → "facts-szymon".
 *      This prevents dotless keys from forming singleton buckets that can
 *      never be compared against anything.
 *   3. Returns empty string for empty input.
 */
export function keyPrefix(canonicalKey: string): string {
  if (canonicalKey === '') return ''
  const dotIndex = canonicalKey.indexOf('.')
  if (dotIndex !== -1) return canonicalKey.slice(0, dotIndex)

  // No dot: use first two hyphen-delimited segments as prefix
  const segments = canonicalKey.split('-')
  return segments.length >= 2
    ? `${segments[0]}-${segments[1]}`
    : canonicalKey
}
