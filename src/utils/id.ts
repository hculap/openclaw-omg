import type { NodeType } from '../types.js'

const MAX_SLUG_LENGTH = 50

/**
 * Converts a string to a URL-safe slug.
 * - Lowercases text
 * - Replaces non-alphanumeric chars with hyphens
 * - Collapses multiple hyphens to one
 * - Truncates to MAX_SLUG_LENGTH characters
 * - Trims leading/trailing hyphens after truncation
 */
export function slugify(text: string): string {
  if (text === '') {
    return ''
  }

  const lowered = text.toLowerCase()
  const hyphenated = lowered.replace(/[^a-z0-9]+/g, '-')
  const collapsed = hyphenated.replace(/-+/g, '-')
  const truncated = collapsed.slice(0, MAX_SLUG_LENGTH)
  const trimmed = truncated.replace(/^-+|-+$/g, '')

  return trimmed
}

/**
 * Generates a stable node identifier.
 * Format: `omg/{type}/{slug}`
 *
 * Example: generateNodeId('identity', 'My Preferred Name') → 'omg/identity/my-preferred-name'
 */
export function generateNodeId(type: NodeType, description: string): string {
  const slug = slugify(description)
  return `omg/${type}/${slug}`
}
