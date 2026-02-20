const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g

/**
 * Extracts all [[...]] wikilinks from content.
 * Returns deduplicated inner text without brackets.
 *
 * Example: '[[foo]] and [[bar]]' → ['foo', 'bar']
 */
export function extractWikilinks(content: string): string[] {
  const matches: string[] = []
  const seen = new Set<string>()

  for (const match of content.matchAll(WIKILINK_PATTERN)) {
    const inner = match[1]
    if (inner !== undefined && !seen.has(inner)) {
      seen.add(inner)
      matches.push(inner)
    }
  }

  return matches
}

/**
 * Appends `- [[target]]` on a new line if not already present.
 * Idempotent: if target already present, returns content unchanged.
 */
export function insertWikilink(content: string, target: string): string {
  const linkLine = `- [[${target}]]`

  if (content.includes(linkLine)) {
    return content
  }

  if (content === '') {
    return linkLine
  }

  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content
  return `${normalized}\n${linkLine}`
}

/**
 * Removes the line `- [[target]]` from content.
 * If not present, returns content unchanged.
 */
export function removeWikilink(content: string, target: string): string {
  const linkLine = `- [[${target}]]`

  if (!content.includes(linkLine)) {
    return content
  }

  const lines = content.split('\n')
  const filtered = lines.filter((line) => line !== linkLine)
  return filtered.join('\n')
}
