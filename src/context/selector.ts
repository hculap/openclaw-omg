import type { OmgConfig } from '../config.js'
import type { GraphNode, GraphContextSlice, Message } from '../types.js'
import type { RegistryNodeEntry } from '../graph/registry.js'
import { estimateTokens } from '../utils/tokens.js'

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
}

/**
 * Two-pass context selector using the registry for Pass 1.
 *
 * Pass 1 (no I/O): Score all registry entries by priority, recency, and
 * description/tags keyword match. Select top `MAX_HYDRATION_CANDIDATES`.
 *
 * Pass 2 (I/O): Hydrate top candidates by reading their node bodies.
 * Re-rank within the hydrated set using full body keyword match.
 * Apply budget and count limits to produce the final slice.
 */
export async function selectContextV2(params: SelectionParamsV2): Promise<GraphContextSlice> {
  const { indexContent, nowContent, registryEntries, recentMessages, config, hydrateNode } = params
  const { injection } = config

  const keywords = extractKeywords(recentMessages)

  // --- Pass 1: metadata-only scoring ---
  const scoredEntries = scoreRegistryEntries(registryEntries, keywords)

  // Partition moc vs regular candidates
  const mocCandidates = scoredEntries
    .filter(([, entry]) => entry.type === 'moc')
    .slice(0, injection.maxMocs * 3) // generous budget for hydration

  const regularCandidates = scoredEntries
    .filter(([, entry]) => entry.type !== 'moc' && entry.type !== 'index' && entry.type !== 'now')
    .slice(0, MAX_HYDRATION_CANDIDATES)

  // --- Pass 2: hydrate top candidates ---
  const [hydratedMocs, hydratedRegular] = await Promise.all([
    hydrateEntries(mocCandidates, hydrateNode),
    hydrateEntries(regularCandidates, hydrateNode),
  ])

  // Delegate to selectContext with the hydrated nodes
  return selectContext({
    indexContent,
    nowContent,
    allNodes: [...hydratedMocs, ...hydratedRegular],
    recentMessages,
    config,
  })
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
  const text = (entry.description + ' ' + (entry.tags ?? []).join(' ')).toLowerCase()
  let matches = 0
  for (const kw of keywords) {
    if (text.includes(kw)) matches++
  }
  return 1.0 + matches * 0.5
}

async function hydrateEntries(
  entries: readonly [string, RegistryNodeEntry][],
  hydrateNode: (filePath: string) => Promise<GraphNode | null>
): Promise<GraphNode[]> {
  const results = await Promise.all(
    entries.map(([, entry]) => hydrateNode(entry.filePath))
  )
  return results.filter((n): n is GraphNode => n !== null)
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
  const text = (node.body + ' ' + (node.frontmatter.tags ?? []).join(' ')).toLowerCase()
  let matches = 0
  for (const kw of keywords) {
    if (text.includes(kw)) matches++
  }
  // Base score 1.0 + bonus for keyword hits
  return 1.0 + matches * 0.5
}

function extractKeywords(messages: readonly Message[]): ReadonlySet<string> {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'and',
    'or', 'but', 'if', 'then', 'that', 'this', 'it', 'its', 'i', 'you',
    'me', 'my', 'your', 'we', 'our', 'they', 'them', 'their', 'not',
    'help', 'about', 'what', 'how', 'when', 'where', 'who', 'which',
  ])
  const words = new Set<string>()
  for (const msg of messages) {
    for (const word of msg.content.toLowerCase().split(/\W+/)) {
      if (word.length > 3 && !stopWords.has(word)) {
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
