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
3. Preserve all unique information from losers as aliases, merged tags, or bodyAppend.
4. If nodes have contradictory values, list them in "conflicts" — do NOT merge them.
5. Return ONLY valid JSON matching the schema below. No prose.

OUTPUT SCHEMA:
{
  "mergePlans": [
    {
      "keepNodeId": "string — ID of the node to keep",
      "keepUid": "string — UID of the keeper (leave empty if unknown)",
      "mergeNodeIds": ["string — IDs of nodes to archive (losers)"],
      "mergeUids": ["string — UIDs of losers (leave empty if unknown)"],
      "aliasKeys": ["string — canonical keys from losers to add as aliases on keeper"],
      "conflicts": ["string — describe any conflicting values found"],
      "patch": {
        "description": "optional — improved description for keeper",
        "tags": ["optional — union of tags from all nodes"],
        "links": ["optional — union of links from all nodes"],
        "bodyAppend": "optional — content from losers to append to keeper body"
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
