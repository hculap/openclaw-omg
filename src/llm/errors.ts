/**
 * Typed LLM error classes for the OMG plugin.
 *
 * These replace the ad-hoc string pattern matching used previously and give
 * callers (bootstrap retry loop, tests) a reliable way to distinguish error
 * categories without parsing error messages.
 */

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitError'
  }
}

export class GatewayUnreachableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GatewayUnreachableError'
  }
}

export class PipelineAbortedError extends Error {
  constructor() {
    super('Bootstrap pipeline aborted: rate limit threshold reached')
    this.name = 'PipelineAbortedError'
  }
}

const RATE_LIMIT_PATTERNS = ['rate limit', 'rate_limit', 'too many requests', '429'] as const
const UNREACHABLE_PATTERNS = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'fetch failed', 'Connection error'] as const

export function classifyGatewayError(message: string): 'rate-limit' | 'unreachable' | 'other' {
  const lower = message.toLowerCase()
  if (RATE_LIMIT_PATTERNS.some((p) => lower.includes(p.toLowerCase()))) return 'rate-limit'
  if (UNREACHABLE_PATTERNS.some((p) => message.includes(p))) return 'unreachable'
  return 'other'
}
