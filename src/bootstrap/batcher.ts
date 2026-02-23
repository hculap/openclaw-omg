/**
 * batcher.ts — Packs bootstrap source chunks into batches to reduce LLM calls.
 *
 * Each batch concatenates multiple source chunks (up to a character budget)
 * into a single LLM request. The XML parser already handles multiple
 * `<operation>` elements per response, so no downstream changes are needed.
 */

import { EXTRACT_MAX_TOKENS } from '../observer/observer.js'
import type { SourceChunk } from './chunker.js'
import type { Message } from '../types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Extra output tokens per additional chunk beyond the first. */
const TOKENS_PER_EXTRA_CHUNK = 1024

/** Hard cap on output tokens regardless of batch size. */
const MAX_OUTPUT_TOKENS_CAP = 16_384

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A batch of source chunks packed to fit within a character budget. */
export interface SourceBatch {
  readonly chunks: readonly SourceChunk[]
  readonly totalChars: number
  readonly batchIndex: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Packs `chunks` into batches using greedy sequential packing.
 *
 * Walks chunks in order, accumulating into the current batch until adding
 * the next chunk would exceed `budget`. An oversized single chunk that
 * exceeds the budget on its own gets its own batch (never rejected).
 *
 * When `budget` is 0, each chunk becomes its own batch (legacy behavior).
 *
 * O(n) time, preserves source ordering.
 */
export function batchChunks(
  chunks: readonly SourceChunk[],
  budget: number
): readonly SourceBatch[] {
  if (chunks.length === 0) return []

  // budget === 0 disables batching: one chunk per batch
  if (budget === 0) {
    return chunks.map((chunk, i) => ({
      chunks: [chunk],
      totalChars: chunk.text.length,
      batchIndex: i,
    }))
  }

  const batches: SourceBatch[] = []
  let currentChunks: SourceChunk[] = []
  let currentChars = 0

  for (const chunk of chunks) {
    const chunkChars = chunk.text.length

    if (currentChunks.length > 0 && currentChars + chunkChars > budget) {
      // Flush current batch
      batches.push({
        chunks: currentChunks,
        totalChars: currentChars,
        batchIndex: batches.length,
      })
      currentChunks = []
      currentChars = 0
    }

    currentChunks.push(chunk)
    currentChars += chunkChars
  }

  // Flush remaining
  if (currentChunks.length > 0) {
    batches.push({
      chunks: currentChunks,
      totalChars: currentChars,
      batchIndex: batches.length,
    })
  }

  return batches
}

/**
 * Converts a batch of source chunks into a `Message[]` suitable for the
 * Observer LLM. Multiple chunks are concatenated with `---` separators.
 */
export function batchToMessages(batch: SourceBatch): readonly Message[] {
  const parts = batch.chunks.map((chunk) => {
    const label = chunk.chunkIndex > 0
      ? `${chunk.source} (part ${chunk.chunkIndex + 1})`
      : chunk.source
    return `[BOOTSTRAP SOURCE: ${label}]\n${chunk.text}`
  })

  return [
    {
      role: 'user' as const,
      content: parts.join('\n\n---\n\n'),
    },
  ]
}

/**
 * Computes the max output tokens for an LLM call processing `chunkCount` chunks.
 *
 * - Base: {@link EXTRACT_MAX_TOKENS} for the first chunk
 * - Adds {@link TOKENS_PER_EXTRA_CHUNK} per additional chunk
 * - Caps at {@link MAX_OUTPUT_TOKENS_CAP}
 */
export function computeBatchMaxTokens(chunkCount: number): number {
  if (chunkCount <= 0) return EXTRACT_MAX_TOKENS
  if (chunkCount === 1) return EXTRACT_MAX_TOKENS
  const scaled = EXTRACT_MAX_TOKENS + (chunkCount - 1) * TOKENS_PER_EXTRA_CHUNK
  return Math.min(scaled, MAX_OUTPUT_TOKENS_CAP)
}
