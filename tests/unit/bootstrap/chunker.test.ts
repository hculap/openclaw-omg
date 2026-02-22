import { describe, it, expect } from 'vitest'
import { chunkText, chunkToMessages, estimateChunkTokens, CHUNK_TOKEN_BUDGET } from '../../../src/bootstrap/chunker.js'

// ---------------------------------------------------------------------------
// chunkText
// ---------------------------------------------------------------------------

describe('chunkText', () => {
  it('returns an empty array for empty input', () => {
    expect(chunkText('', 'test-source')).toEqual([])
  })

  it('returns an empty array for whitespace-only input', () => {
    expect(chunkText('   \n\t  ', 'test-source')).toEqual([])
  })

  it('returns a single chunk for text within budget', () => {
    const text = 'Hello world'
    const chunks = chunkText(text, 'test.md')
    expect(chunks).toHaveLength(1)
    const first = chunks.at(0)
    expect(first).toBeDefined()
    expect(first!.source).toBe('test.md')
    expect(first!.text).toBe(text.trim())
    expect(first!.chunkIndex).toBe(0)
  })

  it('splits text that exceeds the character budget into multiple chunks', () => {
    // CHUNK_TOKEN_BUDGET tokens × 4 chars = charBudget
    const charBudget = CHUNK_TOKEN_BUDGET * 4
    const text = 'a'.repeat(charBudget + 10)
    const chunks = chunkText(text, 'big.md')
    expect(chunks).toHaveLength(2)
    const first = chunks.at(0)!
    const second = chunks.at(1)!
    expect(first.chunkIndex).toBe(0)
    expect(second.chunkIndex).toBe(1)
    expect(first.text.length).toBe(charBudget)
    expect(second.text.length).toBe(10)
  })

  it('assigns correct source to all chunks', () => {
    const charBudget = CHUNK_TOKEN_BUDGET * 4
    const text = 'x'.repeat(charBudget * 3)
    const chunks = chunkText(text, 'multi.md')
    expect(chunks).toHaveLength(3)
    for (const chunk of chunks) {
      expect(chunk.source).toBe('multi.md')
    }
  })

  it('trims leading/trailing whitespace from the full text before splitting', () => {
    const inner = 'content'
    const chunks = chunkText(`  ${inner}  `, 'source')
    expect(chunks.at(0)!.text).toBe(inner)
  })

  it('sets chunkIndex sequentially from 0', () => {
    const charBudget = CHUNK_TOKEN_BUDGET * 4
    const text = 'y'.repeat(charBudget * 4)
    const chunks = chunkText(text, 'seq.md')
    chunks.forEach((c, i) => expect(c.chunkIndex).toBe(i))
  })
})

// ---------------------------------------------------------------------------
// chunkToMessages
// ---------------------------------------------------------------------------

describe('chunkToMessages', () => {
  it('wraps a chunk as a user message with BOOTSTRAP SOURCE label', () => {
    const chunk = { source: 'memory/MEMORY.md', text: 'some content', chunkIndex: 0 }
    const messages = chunkToMessages(chunk)
    expect(messages).toHaveLength(1)
    const msg = messages.at(0)!
    expect(msg.role).toBe('user')
    expect(msg.content).toContain('[BOOTSTRAP SOURCE: memory/MEMORY.md]')
    expect(msg.content).toContain('some content')
  })

  it('includes part number in label for chunkIndex > 0', () => {
    const chunk = { source: 'big-file.md', text: 'part two', chunkIndex: 1 }
    const messages = chunkToMessages(chunk)
    expect(messages.at(0)!.content).toContain('(part 2)')
  })

  it('does not include part number for chunkIndex 0', () => {
    const chunk = { source: 'file.md', text: 'first', chunkIndex: 0 }
    const messages = chunkToMessages(chunk)
    expect(messages.at(0)!.content).not.toContain('(part')
  })

  it('separates label from text with two newlines', () => {
    const chunk = { source: 'src', text: 'body', chunkIndex: 0 }
    const messages = chunkToMessages(chunk)
    expect(messages.at(0)!.content).toBe('[BOOTSTRAP SOURCE: src]\n\nbody')
  })
})

// ---------------------------------------------------------------------------
// estimateChunkTokens
// ---------------------------------------------------------------------------

describe('estimateChunkTokens', () => {
  it('returns ceiling of text.length / 4', () => {
    const chunk = { source: 's', text: 'abcd', chunkIndex: 0 }
    expect(estimateChunkTokens(chunk)).toBe(1)
  })

  it('rounds up for non-divisible lengths', () => {
    const chunk = { source: 's', text: 'abc', chunkIndex: 0 }
    expect(estimateChunkTokens(chunk)).toBe(1)
  })

  it('returns 0 for empty text', () => {
    const chunk = { source: 's', text: '', chunkIndex: 0 }
    expect(estimateChunkTokens(chunk)).toBe(0)
  })
})
