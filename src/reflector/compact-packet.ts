/**
 * Builds compact node representations for cluster-first reflection.
 *
 * Instead of sending full node bodies to the LLM, compact packets contain
 * only the essential metadata and a summary of the body — significantly
 * reducing token usage per cluster.
 */

import type { GraphNode } from '../types.js'

/** A compact representation of a node for reflection input. */
export interface CompactNodePacket {
  readonly canonicalKey: string
  readonly type: string
  readonly description: string
  readonly summaryLines: readonly string[]
  readonly recentUpdates: readonly string[]
  readonly keyLinks: readonly string[]
}

/** Maximum number of summary lines to include from the body. */
const MAX_SUMMARY_LINES = 10

/** Maximum number of links to include. */
const MAX_KEY_LINKS = 5

/** Maximum number of recent update bullets to include. */
const MAX_RECENT_UPDATES = 3

/**
 * Builds a compact packet from a full GraphNode.
 *
 * Extracts the first ~10 non-empty lines of the body as summary,
 * the last 1-3 bullets from an `## Updates` section (if present),
 * and the first 5 links from frontmatter.
 */
export function buildCompactPacket(node: GraphNode): CompactNodePacket {
  const fm = node.frontmatter
  const bodyLines = node.body.split('\n').filter((line) => line.trim().length > 0)

  // Extract summary lines (first N non-empty lines)
  const summaryLines = bodyLines.slice(0, MAX_SUMMARY_LINES)

  // Extract recent updates from ## Updates section
  const recentUpdates = extractRecentUpdates(node.body)

  // Extract first N links
  const keyLinks = (fm.links ?? []).slice(0, MAX_KEY_LINKS)

  return {
    canonicalKey: fm.canonicalKey ?? fm.id,
    type: fm.type,
    description: fm.description,
    summaryLines,
    recentUpdates,
    keyLinks: [...keyLinks],
  }
}

/**
 * Extracts the last N bullet points from the `## Updates` section of a body.
 */
function extractRecentUpdates(body: string): readonly string[] {
  const updatesMatch = body.match(/##\s+Updates\s*\n([\s\S]*?)(?:\n##\s|\n*$)/)
  if (!updatesMatch) return []

  const section = updatesMatch[1] ?? ''
  const bullets = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- ') || line.startsWith('* '))

  return bullets.slice(-MAX_RECENT_UPDATES)
}

/**
 * Serializes an array of compact packets into a string for LLM prompt injection.
 *
 * Format: one fenced block per packet with key metadata fields.
 */
export function serializeCompactPackets(packets: readonly CompactNodePacket[]): string {
  return packets.map((packet) => {
    const parts: string[] = []
    parts.push(`### ${packet.canonicalKey} (${packet.type})`)
    parts.push(`**Description:** ${packet.description}`)

    if (packet.summaryLines.length > 0) {
      parts.push(`**Summary:**\n${packet.summaryLines.join('\n')}`)
    }

    if (packet.recentUpdates.length > 0) {
      parts.push(`**Recent updates:**\n${packet.recentUpdates.join('\n')}`)
    }

    if (packet.keyLinks.length > 0) {
      parts.push(`**Links:** ${packet.keyLinks.join(', ')}`)
    }

    return parts.join('\n')
  }).join('\n\n---\n\n')
}
