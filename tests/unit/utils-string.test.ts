import { describe, it, expect } from 'vitest'
import { capitalise } from '../../src/utils/string.js'

describe('capitalise', () => {
  it('uppercases the first character of a lowercase string', () => {
    expect(capitalise('identity')).toBe('Identity')
  })

  it('leaves the rest of the string unchanged', () => {
    expect(capitalise('multi word domain')).toBe('Multi word domain')
  })

  it('does not lowercase an already-uppercase remainder', () => {
    expect(capitalise('ALREADY')).toBe('ALREADY')
  })

  it('handles a single character', () => {
    expect(capitalise('a')).toBe('A')
  })

  it('returns an empty string unchanged', () => {
    expect(capitalise('')).toBe('')
  })

  it('handles strings that start with a digit', () => {
    expect(capitalise('42things')).toBe('42things')
  })
})
