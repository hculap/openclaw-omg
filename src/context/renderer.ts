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
 * ## Memory Index
 * {index content}
 *
 * ## Current State        ← omitted when nowNode is null
 * {now node body}
 *
 * ## Relevant Knowledge   ← omitted when both mocs and nodes are empty
 * ### {node description}
 * {node body}
 * ...
 * </omg-context>
 * ```
 */
export function renderContextBlock(slice: GraphContextSlice): string {
  const sections: string[] = []

  // Memory Index — always present
  sections.push(`## Memory Index\n${slice.index}`)

  // Current State — only when nowNode is present
  if (slice.nowNode !== null) {
    sections.push(`## Current State\n${slice.nowNode.body}`)
  }

  // Relevant Knowledge — only when there is something to show
  const knowledgeItems = [...slice.mocs, ...slice.nodes]
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
