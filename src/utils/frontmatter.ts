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
 *
 * @throws If the YAML block is malformed or parses to a non-object type
 *   (e.g. a YAML array or scalar at the root level).
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (raw === '') {
    return { frontmatter: {}, body: '' }
  }

  const match = FRONTMATTER_PATTERN.exec(raw)
  if (match === null) {
    return { frontmatter: {}, body: raw }
  }

  const yamlBlock = match[1]
  const body = match[2]

  if (yamlBlock === undefined || body === undefined) {
    throw new Error('[omg] Internal: frontmatter regex match missing capture groups')
  }

  const parsed = yamlParse(yamlBlock) as unknown

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `YAML frontmatter parsed to ${Array.isArray(parsed) ? 'array' : typeof parsed} instead of object`
    )
  }

  return { frontmatter: parsed as Record<string, unknown>, body }
}

/**
 * Produces a "---\n{yaml}\n---\n{body}" string from frontmatter and body.
 *
 * @throws If the frontmatter object cannot be serialized to YAML (e.g. circular references).
 */
export function serializeFrontmatter(
  frontmatter: Record<string, unknown>,
  body: string
): string {
  let yaml: string
  try {
    yaml = yamlStringify(frontmatter).trimEnd()
  } catch (err) {
    throw new Error(
      `Failed to serialize frontmatter: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return `${FRONTMATTER_DELIMITER}\n${yaml}\n${FRONTMATTER_DELIMITER}\n${body}`
}
