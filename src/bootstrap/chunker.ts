/**
 * chunker.ts — Text chunking utilities for bootstrap source ingestion.
 *
 * Splits raw text from sources into chunks that fit within the LLM token
 * budget used for observation calls.
 */

import { estimateTokens } from '../utils/tokens.js'
import type { Message } from '../types.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum tokens per chunk, matching the observer's effective input budget. */
export const CHUNK_TOKEN_BUDGET = 6_000

/** Equivalent character budget (4 chars per token × budget). */
const CHUNK_CHAR_BUDGET = CHUNK_TOKEN_BUDGET * 4

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single text chunk produced from a source document. */
export interface SourceChunk {
  /** Label identifying the origin of this chunk (e.g. file path or log name). */
  readonly source: string
  /** The text content of this chunk. */
  readonly text: string
  /** 0-based index of this chunk within its source document. */
  readonly chunkIndex: number
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Splits `text` into chunks of up to {@link CHUNK_TOKEN_BUDGET} tokens each.
 *
 * Splitting is character-based (4 chars per token heuristic). Each chunk
 * records the source label and its 0-based index within the source document.
 *
 * Returns an empty array for empty or whitespace-only input.
 */
export function chunkText(text: string, source: string): readonly SourceChunk[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return []
  }

  const chunks: SourceChunk[] = []
  let offset = 0
  let chunkIndex = 0

  while (offset < trimmed.length) {
    const slice = trimmed.slice(offset, offset + CHUNK_CHAR_BUDGET)
    chunks.push({ source, text: slice, chunkIndex })
    offset += CHUNK_CHAR_BUDGET
    chunkIndex++
  }

  return chunks
}

/**
 * Wraps a {@link SourceChunk} as an observation message array, formatted
 * for consumption by the Observer LLM.
 *
 * The chunk is labelled with its source so the LLM knows where the content
 * came from.
 */
export function chunkToMessages(chunk: SourceChunk): readonly Message[] {
  const label = chunk.chunkIndex > 0
    ? `${chunk.source} (part ${chunk.chunkIndex + 1})`
    : chunk.source

  return [
    {
      role: 'user',
      content: `[BOOTSTRAP SOURCE: ${label}]\n\n${chunk.text}`,
    },
  ]
}

/**
 * Returns the estimated token count for a {@link SourceChunk}.
 * Convenience wrapper around {@link estimateTokens}.
 */
export function estimateChunkTokens(chunk: SourceChunk): number {
  return estimateTokens(chunk.text)
}
