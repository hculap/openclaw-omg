import type { GraphContextSlice, GraphNode } from '../types.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders a `GraphContextSlice` into a formatted string suitable for injection
 * into the user turn of an agent prompt.
 *
 * Output structure:
 * ```
 * <omg-context>
 * ## Current State        ← omitted when nowNode is null
 * {now node body}
 *
 * ## Relevant Knowledge   ← omitted when both mocs and nodes are empty
 * ### {node description}
 * {node body}
 * ...
 * </omg-context>
 * ```
 *
 * Note: index.md is no longer rendered — it consumed ~264 tokens per turn
 * with zero actionable value for agents (static directory scaffold).
 * MOC nodes are rendered with compressed bodies (link-list → domain summary
 * line) to avoid injecting 100+ unresolvable wikilinks.
 */
export function renderContextBlock(slice: GraphContextSlice): string {
  const sections: string[] = []

  // Current State — only when nowNode is present
  if (slice.nowNode !== null) {
    sections.push(`## Current State\n${slice.nowNode.body}`)
  }

  // Relevant Knowledge — only when there is something to show
  const knowledgeItems = [...slice.mocs.map(compressMocNode), ...slice.nodes]
  if (knowledgeItems.length > 0) {
    const rendered = knowledgeItems.map(renderNode).join('\n\n')
    sections.push(`## Relevant Knowledge\n${rendered}`)
  }

  return `<omg-context>\n${sections.join('\n\n')}\n</omg-context>`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderNode(node: GraphNode): string {
  const { id, description, type, priority } = node.frontmatter
  const meta = `<!-- ${id} | ${type} | ${priority} -->`
  return `### ${description}\n${meta}\n${node.body}`
}

/**
 * Compresses a MOC node's body from a list of 100+ wikilinks into a concise
 * domain summary. The wikilink list consumed ~1,000-1,500 tokens of budget
 * while providing near-zero actionable value (agents cannot resolve wikilinks).
 *
 * The compressed body extracts node slugs from wikilinks and produces a single
 * summary line: "Domain: {domain} — {N} nodes: {top slugs...}"
 */
function compressMocNode(node: GraphNode): GraphNode {
  const wikilinks = node.body.match(/\[\[([^\]]+)\]\]/g) ?? []
  if (wikilinks.length === 0) return node

  const slugs = wikilinks.map((link) => {
    const inner = link.slice(2, -2)
    const lastSlash = inner.lastIndexOf('/')
    return lastSlash === -1 ? inner : inner.slice(lastSlash + 1)
  })

  const domain = node.frontmatter.id.replace(/^omg\/moc-/, '').replace(/-/g, ' ')
  const preview = slugs.slice(0, 8).join(', ')
  const suffix = slugs.length > 8 ? `, ... (+${slugs.length - 8} more)` : ''
  const compressedBody = `Domain: ${domain} — ${slugs.length} nodes: ${preview}${suffix}`

  return {
    ...node,
    body: compressedBody,
  }
}
