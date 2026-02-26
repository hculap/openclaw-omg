/**
 * Shingle-based fingerprinting for source overlap detection.
 *
 * Uses 5-word sliding window shingles to build a set-based fingerprint
 * of message content. Jaccard similarity of shingle sets measures overlap
 * between observation windows.
 *
 * Zero LLM cost — all operations are pure heuristic.
 */
import type { Message } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A serializable fingerprint of a set of messages. */
export interface SourceFingerprint {
  /** Shingle hashes stored as an array for JSON serialization. */
  readonly shingleHashes: readonly number[]
  readonly messageCount: number
  readonly totalChars: number
  readonly timestamp: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of words per shingle. */
const SHINGLE_SIZE = 5

// ---------------------------------------------------------------------------
// Shingle extraction
// ---------------------------------------------------------------------------

/**
 * Tokenizes text into lowercase words, splitting on non-letter/non-digit
 * Unicode boundaries.
 */
function tokenizeWords(text: string): readonly string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0)
}

/**
 * Generates shingle hashes from word tokens using a simple hash function.
 * Returns a Set of 32-bit integer hashes for efficient Jaccard computation.
 */
function shingleHashes(words: readonly string[]): Set<number> {
  const result = new Set<number>()
  if (words.length < SHINGLE_SIZE) {
    // For short texts, use whatever words are available as a single shingle
    if (words.length > 0) {
      result.add(simpleHash(words.join(' ')))
    }
    return result
  }

  for (let i = 0; i <= words.length - SHINGLE_SIZE; i++) {
    const shingle = words.slice(i, i + SHINGLE_SIZE).join(' ')
    result.add(simpleHash(shingle))
  }
  return result
}

/**
 * Simple non-cryptographic hash for shingle strings.
 * djb2 variant — fast, low collision for short strings.
 */
function simpleHash(s: string): number {
  let hash = 5381
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0
  }
  return hash
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Builds a fingerprint from a list of messages.
 * Concatenates all message content and generates shingle hashes.
 */
export function buildFingerprint(messages: readonly Message[]): SourceFingerprint {
  const combined = messages.map((m) => m.content).join('\n')
  const words = tokenizeWords(combined)
  const hashes = shingleHashes(words)

  return {
    shingleHashes: [...hashes],
    messageCount: messages.length,
    totalChars: combined.length,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Computes the Jaccard similarity between two fingerprints.
 * Returns a value in [0, 1] where 1 means identical shingle sets.
 */
export function computeOverlap(a: SourceFingerprint, b: SourceFingerprint): number {
  const setA = new Set(a.shingleHashes)
  const setB = new Set(b.shingleHashes)

  if (setA.size === 0 && setB.size === 0) return 0

  let intersectionCount = 0
  for (const hash of setA) {
    if (setB.has(hash)) intersectionCount++
  }

  const unionCount = setA.size + setB.size - intersectionCount
  return unionCount === 0 ? 0 : intersectionCount / unionCount
}
