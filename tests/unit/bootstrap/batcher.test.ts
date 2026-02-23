import { describe, it, expect } from 'vitest'
import { batchChunks, batchToMessages, computeBatchMaxTokens } from '../../../src/bootstrap/batcher.js'
import { EXTRACT_MAX_TOKENS } from '../../../src/observer/observer.js'
import type { SourceChunk } from '../../../src/bootstrap/chunker.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(text: string, source = 'test.md', chunkIndex = 0): SourceChunk {
  return { source, text, chunkIndex }
}

// ---------------------------------------------------------------------------
// batchChunks
// ---------------------------------------------------------------------------

describe('batchChunks', () => {
  it('returns an empty array for empty input', () => {
    expect(batchChunks([], 24_000)).toEqual([])
  })

  it('packs all chunks into a single batch when total chars fit within budget', () => {
    const chunks = [
      makeChunk('a'.repeat(5_000), 'a.md'),
      makeChunk('b'.repeat(5_000), 'b.md'),
      makeChunk('c'.repeat(5_000), 'c.md'),
    ]
    const batches = batchChunks(chunks, 24_000)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.chunks).toHaveLength(3)
    expect(batches[0]!.totalChars).toBe(15_000)
    expect(batches[0]!.batchIndex).toBe(0)
  })

  it('splits into multiple batches when chunks exceed budget', () => {
    const chunks = [
      makeChunk('a'.repeat(10_000), 'a.md'),
      makeChunk('b'.repeat(10_000), 'b.md'),
      makeChunk('c'.repeat(10_000), 'c.md'),
    ]
    // Budget 20k: first two chunks (10k+10k=20k) fit, third gets its own batch
    const batches = batchChunks(chunks, 20_000)
    expect(batches).toHaveLength(2)
    expect(batches[0]!.chunks).toHaveLength(2)
    expect(batches[1]!.chunks).toHaveLength(1)
  })

  it('gives an oversized single chunk its own batch', () => {
    const chunks = [
      makeChunk('a'.repeat(5_000), 'small.md'),
      makeChunk('b'.repeat(50_000), 'huge.md'),
      makeChunk('c'.repeat(5_000), 'small2.md'),
    ]
    const batches = batchChunks(chunks, 10_000)
    expect(batches).toHaveLength(3)
    expect(batches[0]!.chunks).toHaveLength(1)
    expect(batches[0]!.chunks[0]!.source).toBe('small.md')
    expect(batches[1]!.chunks).toHaveLength(1)
    expect(batches[1]!.chunks[0]!.source).toBe('huge.md')
    expect(batches[2]!.chunks).toHaveLength(1)
    expect(batches[2]!.chunks[0]!.source).toBe('small2.md')
  })

  it('handles exact boundary — chunk fits exactly at budget', () => {
    const chunks = [
      makeChunk('a'.repeat(12_000), 'a.md'),
      makeChunk('b'.repeat(12_000), 'b.md'),
    ]
    const batches = batchChunks(chunks, 24_000)
    expect(batches).toHaveLength(1)
    expect(batches[0]!.totalChars).toBe(24_000)
  })

  it('starts a new batch when adding one more char would exceed budget', () => {
    const chunks = [
      makeChunk('a'.repeat(12_000), 'a.md'),
      makeChunk('b'.repeat(12_001), 'b.md'),
    ]
    const batches = batchChunks(chunks, 24_000)
    expect(batches).toHaveLength(2)
  })

  it('budget=0 disables batching (one chunk per batch)', () => {
    const chunks = [
      makeChunk('a', 'a.md'),
      makeChunk('b', 'b.md'),
      makeChunk('c', 'c.md'),
    ]
    const batches = batchChunks(chunks, 0)
    expect(batches).toHaveLength(3)
    for (let i = 0; i < batches.length; i++) {
      expect(batches[i]!.chunks).toHaveLength(1)
      expect(batches[i]!.batchIndex).toBe(i)
    }
  })

  it('preserves source ordering across batches', () => {
    const chunks = [
      makeChunk('a'.repeat(8_000), 'first.md'),
      makeChunk('b'.repeat(8_000), 'second.md'),
      makeChunk('c'.repeat(8_000), 'third.md'),
      makeChunk('d'.repeat(8_000), 'fourth.md'),
    ]
    const batches = batchChunks(chunks, 15_000)
    const allSources = batches.flatMap((b) => b.chunks.map((c) => c.source))
    expect(allSources).toEqual(['first.md', 'second.md', 'third.md', 'fourth.md'])
  })

  it('assigns sequential batchIndex values', () => {
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk('x'.repeat(5_000), `file${i}.md`)
    )
    const batches = batchChunks(chunks, 10_000)
    batches.forEach((b, i) => expect(b.batchIndex).toBe(i))
  })
})

// ---------------------------------------------------------------------------
// batchToMessages
// ---------------------------------------------------------------------------

describe('batchToMessages', () => {
  it('returns a single user message for a single-chunk batch', () => {
    const batch = {
      chunks: [makeChunk('hello world', 'test.md')],
      totalChars: 11,
      batchIndex: 0,
    }
    const messages = batchToMessages(batch)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content).toContain('[BOOTSTRAP SOURCE: test.md]')
    expect(messages[0]!.content).toContain('hello world')
  })

  it('concatenates multiple chunks with --- separator', () => {
    const batch = {
      chunks: [
        makeChunk('text one', 'a.md'),
        makeChunk('text two', 'b.md'),
      ],
      totalChars: 16,
      batchIndex: 0,
    }
    const messages = batchToMessages(batch)
    expect(messages).toHaveLength(1)
    const content = messages[0]!.content
    expect(content).toContain('[BOOTSTRAP SOURCE: a.md]')
    expect(content).toContain('[BOOTSTRAP SOURCE: b.md]')
    expect(content).toContain('---')
    expect(content).toContain('text one')
    expect(content).toContain('text two')
  })

  it('includes part number for chunks with chunkIndex > 0', () => {
    const batch = {
      chunks: [makeChunk('part two content', 'big.md', 1)],
      totalChars: 16,
      batchIndex: 0,
    }
    const messages = batchToMessages(batch)
    expect(messages[0]!.content).toContain('(part 2)')
  })

  it('does not include part number for chunkIndex 0', () => {
    const batch = {
      chunks: [makeChunk('first chunk', 'file.md', 0)],
      totalChars: 11,
      batchIndex: 0,
    }
    const messages = batchToMessages(batch)
    expect(messages[0]!.content).not.toContain('(part')
  })

  it('preserves chunk ordering in the concatenated message', () => {
    const batch = {
      chunks: [
        makeChunk('FIRST', 'a.md'),
        makeChunk('SECOND', 'b.md'),
        makeChunk('THIRD', 'c.md'),
      ],
      totalChars: 15,
      batchIndex: 0,
    }
    const content = batchToMessages(batch)[0]!.content
    const firstPos = content.indexOf('FIRST')
    const secondPos = content.indexOf('SECOND')
    const thirdPos = content.indexOf('THIRD')
    expect(firstPos).toBeLessThan(secondPos)
    expect(secondPos).toBeLessThan(thirdPos)
  })
})

// ---------------------------------------------------------------------------
// computeBatchMaxTokens
// ---------------------------------------------------------------------------

describe('computeBatchMaxTokens', () => {
  it('returns EXTRACT_MAX_TOKENS for a single chunk', () => {
    expect(computeBatchMaxTokens(1)).toBe(EXTRACT_MAX_TOKENS)
  })

  it('returns EXTRACT_MAX_TOKENS for zero chunks (edge case)', () => {
    expect(computeBatchMaxTokens(0)).toBe(EXTRACT_MAX_TOKENS)
  })

  it('scales up by 1024 per additional chunk', () => {
    const result = computeBatchMaxTokens(3)
    expect(result).toBe(EXTRACT_MAX_TOKENS + 2 * 1024)
  })

  it('caps at 16384', () => {
    expect(computeBatchMaxTokens(100)).toBe(16_384)
  })

  it('returns exactly 16384 at the boundary', () => {
    // EXTRACT_MAX_TOKENS=4096, so 4096 + (n-1)*1024 = 16384 → n-1 = 12 → n = 13
    expect(computeBatchMaxTokens(13)).toBe(16_384)
    expect(computeBatchMaxTokens(14)).toBe(16_384)
  })

  it('returns EXTRACT_MAX_TOKENS for negative input (defensive)', () => {
    expect(computeBatchMaxTokens(-1)).toBe(EXTRACT_MAX_TOKENS)
  })
})
