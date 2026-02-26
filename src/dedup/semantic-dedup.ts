/**
 * Semantic dedup orchestrator.
 *
 * Runs a post-literal semantic dedup pass using LLM-based comparison:
 *   1. Load registry entries → generate candidate blocks
 *   2. For each block, read node bodies → call LLM → parse response
 *   3. Filter by semanticMergeThreshold
 *   4. Execute merges with provenance tracking (mergedFrom)
 *
 * Never throws — errors are collected in the returned result.
 */
import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import type { SemanticDedupResult, SemanticDedupConfig, SemanticMergeSuggestion } from './semantic-types.js'
import { semanticDedupLlmResponseSchema } from './semantic-types.js'
import { getRegistryEntries, getNodeFilePaths } from '../graph/registry.js'
import { generateSemanticBlocks } from './semantic-blocks.js'
import { buildSemanticDedupSystemPrompt, buildBatchedSemanticDedupUserPrompt } from './semantic-prompts.js'
import { executeMerge } from './merge.js'
import { appendAuditEntry } from './audit.js'
import { emitMetric } from '../metrics/index.js'
import { promises as fs } from 'node:fs'
import { parseFrontmatter } from '../utils/frontmatter.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum tokens for a semantic dedup LLM call. */
const SEMANTIC_DEDUP_MAX_TOKENS = 4096

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SemanticDedupParams {
  readonly omgRoot: string
  readonly config: OmgConfig
  readonly llmClient: LlmClient
}

/**
 * Runs one semantic dedup pass against the graph at `omgRoot`.
 * Short-circuits immediately if `config.semanticDedup.enabled` is false.
 * Never throws — errors are collected in the returned result.
 */
export async function runSemanticDedup(params: SemanticDedupParams): Promise<SemanticDedupResult> {
  const { omgRoot, config, llmClient } = params
  const sdConfig: SemanticDedupConfig = config.semanticDedup

  const errors: string[] = []
  let blocksProcessed = 0
  let mergesExecuted = 0
  let nodesArchived = 0
  let tokensUsed = 0

  if (!sdConfig.enabled) {
    return { blocksProcessed, mergesExecuted, nodesArchived, tokensUsed, errors }
  }

  // Step 1: Load registry and generate blocks
  let allEntries: readonly [string, import('../graph/registry.js').RegistryNodeEntry][]
  try {
    allEntries = await getRegistryEntries(omgRoot)
  } catch (err) {
    const msg = `Failed to read registry: ${err instanceof Error ? err.message : String(err)}`
    console.error('[omg] semantic-dedup:', msg)
    errors.push(msg)
    return { blocksProcessed, mergesExecuted, nodesArchived, tokensUsed, errors }
  }

  const blocks = generateSemanticBlocks(allEntries, sdConfig)

  if (blocks.length === 0) {
    console.warn('[omg] semantic-dedup: no candidate blocks — skipping LLM calls')
    return { blocksProcessed, mergesExecuted, nodesArchived, tokensUsed, errors }
  }

  console.warn(`[omg] semantic-dedup: ${blocks.length} block(s) to process (batched into 1 LLM call)`)
  blocksProcessed = blocks.length

  // Step 2: Read all node bodies across all blocks
  const allNodeIds = blocks.flatMap((b) => [...b.nodeIds])
  const nodeContents = new Map<string, string>()
  let filePaths: Map<string, string>
  try {
    filePaths = await getNodeFilePaths(omgRoot, allNodeIds)
  } catch (err) {
    const msg = `Failed to resolve file paths: ${err instanceof Error ? err.message : String(err)}`
    console.error('[omg] semantic-dedup:', msg)
    errors.push(msg)
    return { blocksProcessed, mergesExecuted, nodesArchived, tokensUsed, errors }
  }

  for (const [nodeId, filePath] of filePaths) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const { body } = parseFrontmatter(raw)
      nodeContents.set(nodeId, body.slice(0, sdConfig.maxBodyCharsPerNode))
    } catch (err) {
      console.warn(
        `[omg] semantic-dedup: failed to read node "${nodeId}" at ${filePath} — excluded:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // Step 3: Single batched LLM call for all blocks
  const system = buildSemanticDedupSystemPrompt()
  const user = buildBatchedSemanticDedupUserPrompt(blocks, nodeContents, sdConfig.maxBodyCharsPerNode)

  let responseContent: string
  try {
    const response = await llmClient.generate({ system, user, maxTokens: SEMANTIC_DEDUP_MAX_TOKENS })
    responseContent = response.content
    tokensUsed += response.usage.inputTokens + response.usage.outputTokens
  } catch (err) {
    const msg = `LLM call failed: ${err instanceof Error ? err.message : String(err)}`
    console.error('[omg] semantic-dedup:', msg)
    errors.push(msg)
    return { blocksProcessed, mergesExecuted, nodesArchived, tokensUsed, errors }
  }

  // Step 4: Parse response and execute merges
  const suggestions = parseLlmResponse(responseContent, sdConfig.semanticMergeThreshold)
  if (suggestions === null) {
    const msg = 'Failed to parse batched LLM response'
    console.warn('[omg] semantic-dedup:', msg)
    errors.push(msg)
  } else {
    for (const suggestion of suggestions) {
      try {
        const result = await executeSemantic(suggestion, filePaths, omgRoot)
        mergesExecuted++
        nodesArchived += result.nodesArchived

        try {
          await appendAuditEntry(omgRoot, result.auditEntry)
        } catch (err) {
          const msg = `Failed to append audit for "${suggestion.keepNodeId}": ${err instanceof Error ? err.message : String(err)}`
          console.error('[omg] semantic-dedup:', msg)
          errors.push(msg)
        }
      } catch (err) {
        const msg = `Merge failed for keeper "${suggestion.keepNodeId}": ${err instanceof Error ? err.message : String(err)}`
        console.error('[omg] semantic-dedup:', msg)
        errors.push(msg)
      }
    }
  }

  // Emit metrics
  emitMetric({
    stage: 'semantic-dedup',
    timestamp: new Date().toISOString(),
    data: {
      stage: 'semantic-dedup',
      blocksProcessed,
      mergesExecuted,
      nodesArchived,
      tokensUsed,
    },
  })

  console.warn(
    `[omg] semantic-dedup: completed — ${blocksProcessed} block(s), ` +
      `${mergesExecuted} merge(s), ${nodesArchived} archived, ${tokensUsed} tokens`
  )

  return { blocksProcessed, mergesExecuted, nodesArchived, tokensUsed, errors }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses the LLM response and filters by threshold.
 * Returns null if the response cannot be parsed.
 */
function parseLlmResponse(
  content: string,
  threshold: number,
): readonly SemanticMergeSuggestion[] | null {
  // Strip markdown fences if present
  let jsonContent = content.trim()
  if (jsonContent.startsWith('```')) {
    const afterOpenFence = jsonContent.replace(/^```[^\n]*\n?/, '')
    const closingFenceIdx = afterOpenFence.indexOf('\n```')
    jsonContent = (closingFenceIdx !== -1
      ? afterOpenFence.slice(0, closingFenceIdx)
      : afterOpenFence
    ).trim()
  }
  if (!jsonContent.startsWith('{') && !jsonContent.startsWith('[')) {
    const jsonStart = jsonContent.indexOf('{')
    if (jsonStart !== -1) jsonContent = jsonContent.slice(jsonStart).trim()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonContent)
  } catch (err) {
    console.error(
      `[omg] semantic-dedup: LLM returned non-JSON (${err instanceof Error ? err.message : 'unknown error'}):`,
      content.slice(0, 300),
    )
    return null
  }

  const validation = semanticDedupLlmResponseSchema.safeParse(parsed)
  if (!validation.success) {
    console.error('[omg] semantic-dedup: schema validation failed:', validation.error.message)
    return null
  }

  // Filter by threshold
  return validation.data.suggestions.filter((s) => s.similarityScore >= threshold)
}

/**
 * Executes a single semantic merge: patches the keeper with mergedFrom provenance
 * and archives losers.
 */
async function executeSemantic(
  suggestion: SemanticMergeSuggestion,
  filePaths: Map<string, string>,
  omgRoot: string,
): Promise<{ auditEntry: import('./types.js').DedupAuditEntry; nodesArchived: number }> {
  // Build a MergePlan-compatible structure
  const plan = {
    keepUid: '',
    keepNodeId: suggestion.keepNodeId,
    mergeUids: [] as string[],
    mergeNodeIds: [...suggestion.mergeNodeIds],
    aliasKeys: [] as string[],
    conflicts: [] as string[],
    patch: {
      // No content changes — semantic dedup preserves the keeper as-is
      // The mergedFrom provenance is handled by applyPatch
    },
  }

  return executeMerge(plan, filePaths, omgRoot)
}
