import { describe, it, expect } from 'vitest'
import { classifyGatewayError, RateLimitError, GatewayUnreachableError, PipelineAbortedError } from '../../../src/llm/errors.js'

describe('classifyGatewayError', () => {
  it('returns "rate-limit" for messages containing "rate limit"', () => {
    expect(classifyGatewayError('rate limit exceeded')).toBe('rate-limit')
    expect(classifyGatewayError('Rate Limit Exceeded')).toBe('rate-limit') // case-insensitive
  })

  it('returns "rate-limit" for messages containing "rate_limit" (underscore variant)', () => {
    expect(classifyGatewayError('error: rate_limit reached')).toBe('rate-limit')
  })

  it('returns "rate-limit" for messages containing "too many requests"', () => {
    expect(classifyGatewayError('Too Many Requests')).toBe('rate-limit')
  })

  it('returns "rate-limit" for messages containing "429"', () => {
    expect(classifyGatewayError('HTTP 429 from upstream')).toBe('rate-limit')
  })

  it('returns "unreachable" for ECONNREFUSED', () => {
    expect(classifyGatewayError('ECONNREFUSED 127.0.0.1:18789')).toBe('unreachable')
  })

  it('returns "unreachable" for ECONNRESET', () => {
    expect(classifyGatewayError('socket hang up — ECONNRESET')).toBe('unreachable')
  })

  it('returns "unreachable" for ETIMEDOUT', () => {
    expect(classifyGatewayError('ETIMEDOUT connecting to gateway')).toBe('unreachable')
  })

  it('returns "unreachable" for ENOTFOUND', () => {
    expect(classifyGatewayError('ENOTFOUND localhost')).toBe('unreachable')
  })

  it('returns "unreachable" for "fetch failed"', () => {
    expect(classifyGatewayError('fetch failed')).toBe('unreachable')
  })

  it('returns "unreachable" for "Connection error" prefix (case-sensitive)', () => {
    expect(classifyGatewayError('Connection error: upstream refused')).toBe('unreachable')
  })

  it('returns "other" for unrecognised messages', () => {
    expect(classifyGatewayError('internal server error')).toBe('other')
    expect(classifyGatewayError('unexpected response format')).toBe('other')
    expect(classifyGatewayError('')).toBe('other')
  })

  it('rate-limit takes priority over unreachable when both patterns present', () => {
    // RATE_LIMIT_PATTERNS are checked first
    expect(classifyGatewayError('rate limit: ECONNREFUSED')).toBe('rate-limit')
  })
})

describe('error classes', () => {
  it('RateLimitError has name "RateLimitError" and is instanceof Error', () => {
    const err = new RateLimitError('limited')
    expect(err.name).toBe('RateLimitError')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('limited')
  })

  it('GatewayUnreachableError has name "GatewayUnreachableError"', () => {
    const err = new GatewayUnreachableError('down')
    expect(err.name).toBe('GatewayUnreachableError')
    expect(err).toBeInstanceOf(Error)
  })

  it('PipelineAbortedError has name "PipelineAbortedError" and fixed message', () => {
    const err = new PipelineAbortedError()
    expect(err.name).toBe('PipelineAbortedError')
    expect(err.message).toContain('rate limit')
  })
})
