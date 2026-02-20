import { parse as yamlParse, stringify as yamlStringify } from 'yaml'

const FRONTMATTER_DELIMITER = '---'
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/

/**
 * Result of parsing a markdown document with optional YAML frontmatter.
 */
export interface ParsedFrontmatter {
  readonly frontmatter: Record<string, unknown>
  readonly body: string
}

/**
 * Parses a string in "---\n{yaml}\n---\n{body}" format.
 *
 * If no frontmatter block is present, returns an empty frontmatter
 * object and the full input as body.
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (raw === '') {
    return { frontmatter: {}, body: '' }
  }

  const match = FRONTMATTER_PATTERN.exec(raw)
  if (match === null) {
    return { frontmatter: {}, body: raw }
  }

  const yamlBlock = match[1] ?? ''
  const body = match[2] ?? ''

  const parsed = yamlParse(yamlBlock) as unknown
  const frontmatter =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}

  return { frontmatter, body }
}

/**
 * Produces a "---\n{yaml}\n---\n{body}" string from frontmatter and body.
 */
export function serializeFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  const yaml = yamlStringify(frontmatter).trimEnd()
  return `${FRONTMATTER_DELIMITER}\n${yaml}\n${FRONTMATTER_DELIMITER}\n${body}`
}
