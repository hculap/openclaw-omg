import { createHash } from 'node:crypto'
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

/**
 * Computes a deterministic 12-character hex uid from scope, type, and canonicalKey.
 * Format: sha256(`${scope}:${type}:${canonicalKey}`).slice(0, 12)
 *
 * Example: computeUid('/workspace/proj', 'preference', 'preferences.editor_theme') → 'a3f8c2d91e47'
 */
export function computeUid(scope: string, type: string, canonicalKey: string): string {
  const input = `${scope}:${type}:${canonicalKey}`
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 12)
}

/**
 * Computes a deterministic node ID from type and canonicalKey.
 * Format: `omg/{type}/{slugify(canonicalKey)}`
 *
 * Example: computeNodeId('preference', 'preferences.editor_theme') → 'omg/preference/preferences-editor-theme'
 */
export function computeNodeId(type: string, canonicalKey: string): string {
  const slug = slugify(canonicalKey)
  return `omg/${type}/${slug}`
}

/**
 * Computes a deterministic relative file path from type and canonicalKey.
 * Format: `nodes/{type}/{slugify(canonicalKey)}.md`
 *
 * Example: computeNodePath('preference', 'preferences.editor_theme') → 'nodes/preference/preferences-editor-theme.md'
 */
export function computeNodePath(type: string, canonicalKey: string): string {
  const slug = slugify(canonicalKey)
  return `nodes/${type}/${slug}.md`
}
