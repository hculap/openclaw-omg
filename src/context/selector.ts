import type { OmgConfig } from '../config.js'
import type { GraphNode, GraphContextSlice, Message } from '../types.js'
import type { RegistryNodeEntry } from '../graph/registry.js'
import type { MemoryTools, SemanticCandidate } from './memory-search.js'
import { buildSearchQuery, buildSemanticCandidates } from './memory-search.js'
import { estimateTokens } from '../utils/tokens.js'
import { emitMetric } from '../metrics/index.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SelectionParams {
  /** Full content of index.md (always injected). */
  readonly indexContent: string
  /** Full content of now.md, or null if it doesn't exist. */
  readonly nowContent: string | null
  /** All nodes currently in the graph (moc + regular). */
  readonly allNodes: readonly GraphNode[]
  /** Recent conversation messages used for keyword scoring. */
  readonly recentMessages: readonly Message[]
  readonly config: OmgConfig
}

/**
 * Selects a ranked, budget-constrained slice of graph context for injection.
 *
 * Selection pipeline:
 *   1. Always include index + now node (budget permitting)
 *   2. Split allNodes into mocs and regular nodes
 *   3. Score and rank each group
 *   4. Enforce maxMocs / maxNodes counts
 *   5. Force-include pinned nodes
 *   6. Enforce token budget (drop lowest-scored nodes first)
 */
export function selectContext(params: SelectionParams): GraphContextSlice {
  const { indexContent, nowContent, allNodes, recentMessages, config } = params
  const { injection } = config

  const keywords = extractKeywords(recentMessages)

  // Partition nodes
  const mocNodes = allNodes.filter((n) => n.frontmatter.type === 'moc')
  const regularNodes = allNodes.filter(
    (n) => n.frontmatter.type !== 'moc' && n.frontmatter.type !== 'index' && n.frontmatter.type !== 'now'
  )

  // Score and rank
  const scoredMocs = scoreNodes(mocNodes, keywords).slice(0, injection.maxMocs)
  const scoredRegular = scoreNodes(regularNodes, keywords)

  // Collect pinned nodes (always included, de-duped)
  const pinnedIds = new Set(injection.pinnedNodes)
  const pinnedNodes = regularNodes.filter((n) => pinnedIds.has(n.frontmatter.id))
  const pinnedIdSet = new Set(pinnedNodes.map((n) => n.frontmatter.id))

  // Non-pinned regular nodes up to maxNodes
  const nonPinned = scoredRegular
    .filter((n) => !pinnedIdSet.has(n.frontmatter.id))
    .slice(0, Math.max(0, injection.maxNodes - pinnedNodes.length))

  // Enforce token budget
  // Deduct pinned node costs upfront — they are always included regardless of budget.
  const pinnedCost = pinnedNodes.reduce((sum, n) => sum + estimateTokens(nodeText(n)), 0)
  let budget = injection.maxContextTokens
  budget -= estimateTokens(indexContent)
  if (nowContent !== null) budget -= estimateTokens(nowContent)
  budget -= pinnedCost

  const selectedMocs = fitInBudget(scoredMocs, budget / 2)
  budget -= selectedMocs.reduce((sum, n) => sum + estimateTokens(nodeText(n)), 0)

  const selectedNonPinned = fitInBudget(nonPinned, budget)
  const selectedNodes = [...pinnedNodes, ...selectedNonPinned]

  // Compute estimated tokens
  const estTokens =
    estimateTokens(indexContent) +
    (nowContent !== null ? estimateTokens(nowContent) : 0) +
    selectedMocs.reduce((sum, n) => sum + estimateTokens(nodeText(n)), 0) +
    selectedNodes.reduce((sum, n) => sum + estimateTokens(nodeText(n)), 0)

  const nowNode = nowContent !== null
    ? buildNowNode(nowContent)
    : null

  return {
    index: indexContent,
    nowNode,
    mocs: selectedMocs,
    nodes: selectedNodes,
    estimatedTokens: estTokens,
  }
}

// ---------------------------------------------------------------------------
// Two-pass context selection (registry-based)
// ---------------------------------------------------------------------------

/** Max candidates to hydrate in Pass 2. */
const MAX_HYDRATION_CANDIDATES = 200

export interface SelectionParamsV2 {
  /** Full content of index.md (always injected). */
  readonly indexContent: string
  /** Full content of now.md, or null if it doesn't exist. */
  readonly nowContent: string | null
  /** Registry entries for all nodes (id + metadata, no body). */
  readonly registryEntries: readonly [string, RegistryNodeEntry][]
  /** Recent conversation messages used for keyword scoring. */
  readonly recentMessages: readonly Message[]
  readonly config: OmgConfig
  /**
   * Async function that reads a node body given its file path.
   * Injected for testability — production callers use `readGraphNode`.
   */
  readonly hydrateNode: (filePath: string) => Promise<GraphNode | null>
  /**
   * Optional memory tool interface for semantic boosting.
   * When null (or undefined), scoring falls back to registry-only.
   */
  readonly memoryTools?: MemoryTools | null
}

/**
 * Two-pass context selector using the registry for Pass 1, with optional
 * semantic boosting via OpenClaw's memory_search tool.
 *
 * Pass 1 (no I/O): Score all registry entries by priority, recency, and
 * description/tags keyword match. Select top `MAX_HYDRATION_CANDIDATES`.
 * If `memoryTools` is provided and `config.injection.semantic.enabled` is true,
 * a memory_search call runs in parallel with Pass 1 scoring.
 *
 * Pass 2 (I/O): Hydrate top candidates by reading their node bodies.
 * Re-rank within the hydrated set using full body keyword match.
 * Apply budget and count limits to produce the final slice.
 */
export async function selectContextV2(params: SelectionParamsV2): Promise<GraphContextSlice> {
  const { indexContent, nowContent, registryEntries, recentMessages, config, hydrateNode, memoryTools } = params
  const { injection } = config

  const keywords = extractKeywords(recentMessages)

  // --- Pass 1: metadata-only scoring (+ optional parallel memory_search) ---
  const shouldUseSemantic = memoryTools != null && injection.semantic.enabled

  const [scoredEntries, semanticCandidates] = await Promise.all([
    Promise.resolve(scoreRegistryEntries(registryEntries, keywords)),
    shouldUseSemantic
      ? runMemorySearch(memoryTools!, injection.semantic.maxResults, injection.semantic.minScore, recentMessages, nowContent, keywords)
      : Promise.resolve([] as readonly SemanticCandidate[]),
  ])

  // Build filePath → semanticScore map for use after hydration
  const semanticByPath = new Map<string, number>()
  for (const candidate of semanticCandidates) {
    semanticByPath.set(candidate.filePath, candidate.semanticScore)
  }

  // Merge semantic scores into registry scores for candidate selection
  const boostedEntries = semanticCandidates.length > 0
    ? mergeSemantic(scoredEntries, semanticCandidates, injection.semantic.weight)
    : scoredEntries

  // Partition moc vs regular candidates
  const mocCandidates = boostedEntries
    .filter(([, entry]) => entry.type === 'moc')
    .slice(0, injection.maxMocs * 3) // generous budget for hydration

  const regularCandidates = boostedEntries
    .filter(([, entry]) => entry.type !== 'moc' && entry.type !== 'index' && entry.type !== 'now')
    .slice(0, MAX_HYDRATION_CANDIDATES)

  // --- Pass 2: hydrate top candidates ---
  const [hydratedMocs, hydratedRegular] = await Promise.all([
    hydrateEntries(mocCandidates, hydrateNode),
    hydrateEntries(regularCandidates, hydrateNode),
  ])

  // When no semantic signal, delegate to selectContext directly
  if (semanticByPath.size === 0 || injection.semantic.weight === 0) {
    const result = selectContext({
      indexContent,
      nowContent,
      allNodes: [...hydratedMocs, ...hydratedRegular],
      recentMessages,
      config,
    })
    emitSelectorMetrics(result, semanticCandidates.length)
    return result
  }

  // With semantic signal: apply hybrid scoring on hydrated nodes, then use
  // selectContext-like logic with the pre-sorted nodes
  const result = selectContextWithSemanticBoost({
    indexContent,
    nowContent,
    hydratedMocs,
    hydratedRegular,
    recentMessages,
    config,
    semanticByPath,
    semanticWeight: injection.semantic.weight,
  })
  emitSelectorMetrics(result, semanticCandidates.length)
  return result
}

function emitSelectorMetrics(slice: GraphContextSlice, memorySearchHitCount: number): void {
  const allNodes = [...slice.mocs, ...slice.nodes]
  if (slice.nowNode) allNodes.push(slice.nowNode)

  const injectedChars = slice.index.length +
    allNodes.reduce((sum, n) => sum + n.body.length + n.frontmatter.description.length, 0)

  const selectedNodeCountByType: Record<string, number> = {}
  const selectedNodeCountByDomain: Record<string, number> = {}

  for (const node of allNodes) {
    const type = node.frontmatter.type
    selectedNodeCountByType[type] = (selectedNodeCountByType[type] ?? 0) + 1

    // Domain from first omg/moc-* link
    const links = node.frontmatter.links ?? []
    const mocLink = links.find((l) => l.startsWith('omg/moc-'))
    const domain = mocLink ? mocLink.replace('omg/moc-', '') : 'misc'
    selectedNodeCountByDomain[domain] = (selectedNodeCountByDomain[domain] ?? 0) + 1
  }

  emitMetric({
    stage: 'selector',
    timestamp: new Date().toISOString(),
    data: {
      stage: 'selector',
      injectedChars,
      injectedTokens: slice.estimatedTokens,
      selectedNodeCountByType,
      selectedNodeCountByDomain,
      memorySearchHitCount,
    },
  })
}

/**
 * Runs the memory_search tool and returns normalized semantic candidates.
 * Returns an empty array on any failure (graceful degradation).
 */
async function runMemorySearch(
  memoryTools: MemoryTools,
  maxResults: number,
  minScore: number,
  recentMessages: readonly Message[],
  nowContent: string | null,
  keywords: ReadonlySet<string>
): Promise<readonly SemanticCandidate[]> {
  try {
    const lastUserMsg = [...recentMessages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const query = buildSearchQuery(lastUserMsg, nowContent, keywords)

    const response = await memoryTools.search(query.length > 0 ? `${query} limit:${maxResults}` : `limit:${maxResults}`)
    if (!response) return []

    return buildSemanticCandidates(response, minScore)
  } catch (error) {
    console.error(
      '[omg] runMemorySearch: memory_search failed — falling back to registry-only scoring.',
      error instanceof Error ? error.message : String(error)
    )
    return []
  }
}

/**
 * Variant of selectContext that applies semantic boosting to the final node scoring.
 * Used when semantic candidates are available.
 */
function selectContextWithSemanticBoost(params: {
  indexContent: string
  nowContent: string | null
  hydratedMocs: GraphNode[]
  hydratedRegular: GraphNode[]
  recentMessages: readonly Message[]
  config: OmgConfig
  semanticByPath: Map<string, number>
  semanticWeight: number
}): GraphContextSlice {
  const { indexContent, nowContent, hydratedMocs, hydratedRegular, recentMessages, config, semanticByPath, semanticWeight } = params
  const { injection } = config

  const keywords = extractKeywords(recentMessages)

  // Score with hybrid formula: baseScore + weight * semanticScore
  const scoredMocs = scoreNodesWithSemantic(hydratedMocs, keywords, semanticByPath, semanticWeight)
    .slice(0, injection.maxMocs)

  const scoredRegular = scoreNodesWithSemantic(hydratedRegular, keywords, semanticByPath, semanticWeight)

  // Collect pinned nodes (always included, de-duped)
  const pinnedIds = new Set(injection.pinnedNodes)
  const pinnedNodes = hydratedRegular.filter((n) => pinnedIds.has(n.frontmatter.id))
  const pinnedIdSet = new Set(pinnedNodes.map((n) => n.frontmatter.id))

  const nonPinned = scoredRegular
    .filter((n) => !pinnedIdSet.has(n.frontmatter.id))
    .slice(0, Math.max(0, injection.maxNodes - pinnedNodes.length))

  // Enforce token budget
  const pinnedCost = pinnedNodes.reduce((sum, n) => sum + estimateTokens(nodeText(n)), 0)
  let budget = injection.maxContextTokens
  budget -= estimateTokens(indexContent)
  if (nowContent !== null) budget -= estimateTokens(nowContent)
  budget -= pinnedCost

  const selectedMocs = fitInBudget(scoredMocs, budget / 2)
  budget -= selectedMocs.reduce((sum, n) => sum + estimateTokens(nodeText(n)), 0)

  const selectedNonPinned = fitInBudget(nonPinned, budget)
  const selectedNodes = [...pinnedNodes, ...selectedNonPinned]

  const estTokens =
    estimateTokens(indexContent) +
    (nowContent !== null ? estimateTokens(nowContent) : 0) +
    selectedMocs.reduce((sum, n) => sum + estimateTokens(nodeText(n)), 0) +
    selectedNodes.reduce((sum, n) => sum + estimateTokens(nodeText(n)), 0)

  const nowNode = nowContent !== null ? buildNowNode(nowContent) : null

  return {
    index: indexContent,
    nowNode,
    mocs: selectedMocs,
    nodes: selectedNodes,
    estimatedTokens: estTokens,
  }
}

function scoreNodesWithSemantic(
  nodes: readonly GraphNode[],
  keywords: ReadonlySet<string>,
  semanticByPath: Map<string, number>,
  semanticWeight: number
): GraphNode[] {
  return [...nodes]
    .map((node) => {
      const baseScore = computeScore(node, keywords)
      const semanticScore = semanticByPath.get(node.filePath) ?? 0
      return { node, score: baseScore + semanticWeight * semanticScore }
    })
    .sort((a, b) => b.score - a.score)
    .map(({ node }) => node)
}

/**
 * Merges semantic scores into registry entry scores.
 *
 * Formula: finalScore = registryScore + weight * semanticScore
 *
 * Only registry entries whose filePath appears in the semantic candidates are
 * boosted. Entries not in the semantic result set keep their original score.
 * Semantic candidates whose filePath is not in the registry are ignored — the
 * OMG plugin only injects nodes it owns.
 */
function mergeSemantic(
  scoredEntries: readonly [string, RegistryNodeEntry][],
  semanticCandidates: readonly SemanticCandidate[],
  weight: number
): [string, RegistryNodeEntry][] {
  if (weight === 0) return [...scoredEntries]

  // Build a lookup map: filePath → normalizedSemanticScore
  const semanticByPath = new Map<string, number>()
  for (const candidate of semanticCandidates) {
    semanticByPath.set(candidate.filePath, candidate.semanticScore)
  }

  // Re-score entries (we need to reconstruct scores to apply boost)
  // We store the computed semantic boost alongside each entry, then re-sort
  const withBoost = scoredEntries.map(([id, entry], idx): { entry: [string, RegistryNodeEntry]; boostPos: number } => {
    const semanticScore = semanticByPath.get(entry.filePath) ?? 0
    // Use negative index as base rank (higher in scoredEntries = lower idx = better rank).
    // Boost shifts rank: semanticScore * weight is added as negative offset (less negative = better).
    const boostPos = idx - semanticScore * weight * scoredEntries.length
    return { entry: [id, entry], boostPos }
  })

  return withBoost
    .sort((a, b) => a.boostPos - b.boostPos)
    .map(({ entry }) => entry)
}

function scoreRegistryEntries(
  entries: readonly [string, RegistryNodeEntry][],
  keywords: ReadonlySet<string>
): [string, RegistryNodeEntry][] {
  return [...entries]
    .map((entry) => ({ entry, score: computeRegistryScore(entry[1], keywords) }))
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry)
}

function computeRegistryScore(entry: RegistryNodeEntry, keywords: ReadonlySet<string>): number {
  const priorityWeight = PRIORITY_WEIGHT[entry.priority] ?? 1.0
  const recencyFactor = computeRecencyFactor(entry.updated)
  const keywordMatch = computeRegistryKeywordMatch(entry, keywords)
  return keywordMatch * priorityWeight * recencyFactor
}

function computeRegistryKeywordMatch(entry: RegistryNodeEntry, keywords: ReadonlySet<string>): number {
  if (keywords.size === 0) return 1.0
  const tags = (entry.tags ?? []).map((t) => t.toLowerCase())
  const text = (entry.description + ' ' + tags.join(' ')).toLowerCase()
  let matches = 0
  for (const kw of keywords) {
    if (text.includes(kw) || prefixMatchesTags(kw, tags)) matches++
  }
  return 1.0 + matches * 0.5
}

async function hydrateEntries(
  entries: readonly [string, RegistryNodeEntry][],
  hydrateNode: (filePath: string) => Promise<GraphNode | null>
): Promise<GraphNode[]> {
  const results = await Promise.allSettled(
    entries.map(([, entry]) => hydrateNode(entry.filePath))
  )
  return results.flatMap((result) => {
    if (result.status === 'rejected') {
      console.error('[omg] hydrateEntries: failed to read node:', result.reason)
      return []
    }
    return result.value !== null ? [result.value] : []
  })
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const PRIORITY_WEIGHT: Record<string, number> = {
  high: 1.5,
  medium: 1.0,
  low: 0.7,
}

function scoreNodes(nodes: readonly GraphNode[], keywords: ReadonlySet<string>): GraphNode[] {
  return [...nodes]
    .map((node) => ({ node, score: computeScore(node, keywords) }))
    .sort((a, b) => b.score - a.score)
    .map(({ node }) => node)
}

function computeScore(node: GraphNode, keywords: ReadonlySet<string>): number {
  const priorityWeight = PRIORITY_WEIGHT[node.frontmatter.priority] ?? 1.0
  const recencyFactor = computeRecencyFactor(node.frontmatter.updated)
  const keywordMatch = computeKeywordMatch(node, keywords)
  return keywordMatch * priorityWeight * recencyFactor
}

function computeRecencyFactor(updatedIso: string): number {
  const ts = new Date(updatedIso).getTime()
  if (isNaN(ts)) {
    console.error(`[omg] selectContext: invalid 'updated' date on node: ${JSON.stringify(updatedIso)} — defaulting recency factor to 0.5`)
    return 0.5
  }
  const ageDays = (Date.now() - ts) / 86_400_000
  return Math.max(0.5, 1.0 - ageDays * 0.02)
}

function computeKeywordMatch(node: GraphNode, keywords: ReadonlySet<string>): number {
  if (keywords.size === 0) return 1.0
  const tags = (node.frontmatter.tags ?? []).map((t) => t.toLowerCase())
  const text = (node.body + ' ' + tags.join(' ')).toLowerCase()
  let matches = 0
  for (const kw of keywords) {
    if (text.includes(kw) || prefixMatchesTags(kw, tags)) matches++
  }
  // Base score 1.0 + bonus for keyword hits
  return 1.0 + matches * 0.5
}

/**
 * Returns true if the keyword shares a common prefix with any tag, using an
 * adaptive prefix length: `max(3, floor(min(kwLen, tagLen) * 0.75))`.
 *
 * Short stems (3-4 chars) need only 3 matching chars — critical for Polish
 * words like żona whose inflections (żony, żonie, żonę) share only a 3-char
 * stem. Longer words require proportionally longer prefixes.
 *
 * False positives (e.g. dark↔dart sharing "dar") are acceptable because prefix
 * matching only provides an additive score boost, not exclusive selection.
 */
function prefixMatchesTags(keyword: string, tags: readonly string[]): boolean {
  for (const tag of tags) {
    const prefixLen = Math.max(3, Math.floor(Math.min(keyword.length, tag.length) * 0.75))
    if (keyword.length < prefixLen || tag.length < prefixLen) continue
    if (tag.startsWith(keyword.slice(0, prefixLen)) || keyword.startsWith(tag.slice(0, prefixLen))) {
      return true
    }
  }
  return false
}

/** High-frequency English function words (> 3 chars) that add noise to keyword matching. */
const STOPWORDS = new Set([
  'about', 'also', 'been', 'came', 'come', 'could', 'does', 'each',
  'even', 'from', 'gave', 'goes', 'gone', 'have', 'help', 'here',
  'into', 'just', 'know', 'like', 'made', 'make', 'many', 'more',
  'most', 'much', 'must', 'need', 'only', 'over', 'said', 'same',
  'shall', 'should', 'show', 'some', 'such', 'take', 'tell', 'than',
  'that', 'them', 'then', 'there', 'these', 'they', 'this', 'very',
  'want', 'were', 'what', 'when', 'where', 'which', 'will', 'with',
  'would', 'your',
])

function extractKeywords(messages: readonly Message[]): ReadonlySet<string> {
  const words = new Set<string>()
  for (const msg of messages) {
    for (const word of msg.content.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (word.length > 3 && !STOPWORDS.has(word)) {
        words.add(word)
      }
    }
  }
  return words
}

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

function fitInBudget(nodes: readonly GraphNode[], budget: number): GraphNode[] {
  const result: GraphNode[] = []
  let remaining = budget
  for (const node of nodes) {
    const cost = estimateTokens(nodeText(node))
    if (remaining <= 0) break
    if (cost <= remaining) {
      result.push(node)
      remaining -= cost
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeText(node: GraphNode): string {
  return node.frontmatter.description + '\n' + node.body
}

function buildNowNode(content: string): GraphNode {
  const now = new Date().toISOString()
  return {
    frontmatter: {
      id: 'omg/now',
      description: 'Current state snapshot',
      type: 'now',
      priority: 'high',
      created: now,
      updated: now,
    },
    body: content,
    // Synthetic in-memory node — not backed by a file on disk.
    filePath: '',
  }
}
