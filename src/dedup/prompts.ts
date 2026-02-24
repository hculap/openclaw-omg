/**
 * LLM prompt builders for the semantic dedup subsystem.
 */
import type { CandidateCluster } from './candidates.js'

// ---------------------------------------------------------------------------
// NodeSummary — compact representation sent to the LLM
// ---------------------------------------------------------------------------

export interface NodeSummary {
  readonly nodeId: string
  readonly canonicalKey: string
  readonly type: string
  readonly description: string
  readonly updated: string
  readonly tags: readonly string[]
}

// ---------------------------------------------------------------------------
// buildDedupSystemPrompt
// ---------------------------------------------------------------------------

/**
 * Builds the system prompt for the LLM deduplication pass.
 */
export function buildDedupSystemPrompt(): string {
  return `You are a Deduplicator for a knowledge graph. Your task is to identify and merge true semantic duplicates.

RULES:
1. Only merge nodes that represent the SAME real-world concept or fact.
2. Prefer the most complete node as the keeper (keepNodeId).
3. Preserve unique canonical keys from losers as aliases.
4. If nodes have contradictory values, list them in "conflicts" — do NOT merge them.
5. Return ONLY valid JSON matching the schema below. No prose, no rationale, no explanations — not before, not after the JSON. The JSON must be your entire response.

IMPORTANT: Keep all string values short (under 100 characters). Leave optional fields as empty arrays or omit them when not needed. Do NOT generate bodyAppend — it is reserved for future use.

OUTPUT SCHEMA:
{
  "mergePlans": [
    {
      "keepNodeId": "string — ID of the node to keep",
      "keepUid": "",
      "mergeNodeIds": ["string — IDs of nodes to archive"],
      "mergeUids": [],
      "aliasKeys": ["string — canonical keys from losers to add as aliases on keeper"],
      "conflicts": [],
      "patch": {
        "description": "optional — concise improved description under 100 chars",
        "tags": []
      }
    }
  ]
}

If a cluster has NO true duplicates, omit it from mergePlans entirely.`
}

// ---------------------------------------------------------------------------
// buildDedupUserPrompt
// ---------------------------------------------------------------------------

/**
 * Builds the user prompt with cluster data for the LLM to evaluate.
 */
export function buildDedupUserPrompt(clusters: readonly CandidateCluster[]): string {
  if (clusters.length === 0) {
    return 'No candidate clusters to evaluate. Return: {"mergePlans": []}'
  }

  const sections: string[] = []

  clusters.forEach((cluster, clusterIndex) => {
    const lines: string[] = [`## Cluster ${clusterIndex + 1} (similarity: ${cluster.maxScore.toFixed(2)})`]
    lines.push('')
    lines.push('| nodeId | canonicalKey | type | description | updated | tags |')
    lines.push('|--------|-------------|------|-------------|---------|------|')

    for (const nodeId of cluster.nodeIds) {
      const entry = cluster.entries.get(nodeId)
      if (!entry) continue
      const tags = (entry.tags ?? []).join(', ')
      const canonicalKey = entry.canonicalKey ?? '(none)'
      lines.push(`| ${nodeId} | ${canonicalKey} | ${entry.type} | ${entry.description} | ${entry.updated} | ${tags} |`)
    }

    sections.push(lines.join('\n'))
  })

  return `Evaluate these candidate clusters of potentially duplicate graph nodes.
For each cluster with TRUE semantic duplicates, produce a merge plan.
Skip clusters where nodes represent DISTINCT concepts.

${sections.join('\n\n')}

Return your analysis as JSON with "mergePlans" array.`
}
