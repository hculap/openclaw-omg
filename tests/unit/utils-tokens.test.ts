import { describe, it, expect } from 'vitest'
import { estimateTokens, fitsInBudget } from '../../src/utils/tokens.js'

describe('estimateTokens', () => {
  it('empty string returns 0 tokens', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('4-char string returns 1 token', () => {
    expect(estimateTokens('abcd')).toBe(1)
  })

  it('string of 400 chars returns 100 tokens', () => {
    const text = 'a'.repeat(400)
    expect(estimateTokens(text)).toBe(100)
  })

  it('rounds up: 5-char string returns 2 tokens', () => {
    expect(estimateTokens('abcde')).toBe(2)
  })

  it('1-char string returns 1 token', () => {
    expect(estimateTokens('x')).toBe(1)
  })

  it('exactly 8 chars returns 2 tokens', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
  })
})

describe('fitsInBudget', () => {
  it('returns true when tokens are within budget', () => {
    const text = 'a'.repeat(100) // 25 tokens
    expect(fitsInBudget(text, 50)).toBe(true)
  })

  it('returns false when tokens exceed budget', () => {
    const text = 'a'.repeat(400) // 100 tokens
    expect(fitsInBudget(text, 50)).toBe(false)
  })

  it('returns true when tokens are exactly at budget', () => {
    const text = 'a'.repeat(400) // exactly 100 tokens
    expect(fitsInBudget(text, 100)).toBe(true)
  })

  it('empty string fits in any budget >= 0', () => {
    expect(fitsInBudget('', 0)).toBe(true)
  })

  it('returns false when budget is 0 and text is non-empty', () => {
    expect(fitsInBudget('a', 0)).toBe(false)
  })
})
