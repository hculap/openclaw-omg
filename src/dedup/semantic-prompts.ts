/**
 * Prompt builders for semantic dedup LLM calls.
 *
 * The LLM compares a block of candidate nodes and identifies semantic
 * duplicates that heuristic similarity missed. Returns structured JSON.
 */
import type { SemanticBlock } from './semantic-types.js'

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Returns the static system prompt for semantic dedup LLM calls.
 */
export function buildSemanticDedupSystemPrompt(): string {
  return `You are a semantic deduplication analyst for a personal knowledge graph.

Your task is to analyze a block of knowledge nodes and identify which ones are **semantic duplicates** — nodes that describe the same concept, event, or fact using different wording.

## Rules

1. **Only merge true semantic duplicates**: Two nodes are duplicates if they capture the SAME piece of knowledge, even if worded differently. Related but distinct concepts should NOT be merged.
2. **Pick the best keeper**: The keeper should be the most complete, well-written, and accurate node in the group.
3. **Report similarity score**: Rate 0–100 how semantically similar the merged nodes are to the keeper.
   - 90–100: Nearly identical content, just different wording
   - 80–89: Same core concept with minor differences in scope
   - 70–79: Overlapping but with meaningful differences (borderline)
   - Below 70: Not duplicates — do NOT suggest merging
4. **Preserve distinct nuances**: If two nodes cover the same topic but contain genuinely different information or perspectives, keep them separate.
5. **Be conservative**: When in doubt, keep nodes separate. False merges lose information.

## Output Format

Respond with valid JSON only. No explanations outside JSON.

\`\`\`json
{
  "suggestions": [
    {
      "keepNodeId": "omg/preference.dark-mode",
      "mergeNodeIds": ["omg/preference.dark-theme"],
      "similarityScore": 92,
      "rationale": "Both describe the same dark mode preference with different key names"
    }
  ]
}
\`\`\`

If no semantic duplicates are found, return:
\`\`\`json
{"suggestions": []}
\`\`\`

Important: Each node can appear in at most ONE suggestion (either as keeper or merge target).`
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

/**
 * Builds the user prompt for a single semantic dedup block.
 * Includes node metadata AND truncated body excerpts for semantic comparison.
 */
export function buildSemanticDedupUserPrompt(
  block: SemanticBlock,
  nodeContents: ReadonlyMap<string, string>,
  maxBodyChars: number,
): string {
  const parts: string[] = []

  parts.push(`## Semantic Dedup Block — Domain: ${block.domain}`)
  parts.push(`Analyze these ${block.nodeIds.length} nodes for semantic duplicates.\n`)

  for (const nodeId of block.nodeIds) {
    const entry = block.entries.get(nodeId)
    if (!entry) continue

    const body = nodeContents.get(nodeId) ?? ''
    const truncatedBody = body.length > maxBodyChars
      ? body.slice(0, maxBodyChars) + '...[truncated]'
      : body

    parts.push(`### ${nodeId}`)
    parts.push(`- **type**: ${entry.type}`)
    parts.push(`- **description**: ${entry.description}`)
    if (entry.canonicalKey) parts.push(`- **key**: ${entry.canonicalKey}`)
    if (entry.tags && entry.tags.length > 0) parts.push(`- **tags**: ${entry.tags.join(', ')}`)
    parts.push(`- **updated**: ${entry.updated}`)
    if (truncatedBody.trim()) {
      parts.push(`\n\`\`\`\n${truncatedBody}\n\`\`\``)
    }
    parts.push('')
  }

  return parts.join('\n')
}
