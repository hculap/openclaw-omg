/**
 * memory-search.ts — OpenClaw memory_search/memory_get tool integration.
 *
 * Provides a thin wrapper around OpenClaw's runtime memory tools for use as a
 * semantic boosting signal within the OMG context selector. When the tools are
 * unavailable the module degrades gracefully — callers receive null and fall
 * back to registry-only scoring.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single result returned by OpenClaw's memory_search tool. */
export interface MemorySearchResult {
  readonly filePath: string
  readonly score: number
  readonly snippet: string
}

/** Full response from OpenClaw's memory_search tool. */
export interface MemorySearchResponse {
  readonly results: readonly MemorySearchResult[]
  /** When true the memory plugin is disabled; treat as empty. */
  readonly disabled?: boolean
}

/** Response from OpenClaw's memory_get tool. */
export interface MemoryGetResponse {
  readonly filePath: string
  readonly content: string
}

/** Callable interface to the wrapped memory tools. */
export interface MemoryTools {
  /** Run a semantic search. Returns null on any failure. */
  search(query: string): Promise<MemorySearchResponse | null>
  /** Retrieve a specific file's content. Returns null on any failure. */
  get(filePath: string): Promise<MemoryGetResponse | null>
}

/** Normalized search hit with score in [0, 1] after min-max normalization. */
export interface SemanticCandidate {
  readonly filePath: string
  readonly semanticScore: number
  readonly snippet: string
}

// ---------------------------------------------------------------------------
// Internal interface for OpenClaw's runtime tool factory
// ---------------------------------------------------------------------------

interface MemoryToolInstance {
  execute(input: unknown): Promise<unknown>
}

interface MemoryToolOptions {
  config?: unknown
  agentSessionKey?: string
}

interface RuntimeTools {
  createMemorySearchTool?: (options?: MemoryToolOptions) => MemoryToolInstance | null
  createMemoryGetTool?: (options?: MemoryToolOptions) => MemoryToolInstance | null
}

// ---------------------------------------------------------------------------
// createMemoryTools
// ---------------------------------------------------------------------------

/**
 * Probes `api.runtime?.tools` for OpenClaw's memory tool factories and wraps
 * them in a typed, error-safe interface.
 *
 * Returns null when:
 *   - `api.runtime` or `api.runtime.tools` is absent
 *   - `createMemorySearchTool` is not a function
 *   - `createMemorySearchTool()` returns null (plugin not active)
 */
export function createMemoryTools(api: { config?: unknown; runtime?: { tools?: RuntimeTools } }): MemoryTools | null {
  const tools = api.runtime?.tools
  if (!tools) return null

  if (typeof tools.createMemorySearchTool !== 'function') return null

  const toolOptions: MemoryToolOptions = { config: api.config }
  const searchTool = tools.createMemorySearchTool(toolOptions)
  if (!searchTool) return null

  const getTool = typeof tools.createMemoryGetTool === 'function'
    ? tools.createMemoryGetTool(toolOptions)
    : null

  return {
    async search(query: string): Promise<MemorySearchResponse | null> {
      try {
        const response = await searchTool.execute({ query })
        return response as MemorySearchResponse
      } catch {
        return null
      }
    },

    async get(filePath: string): Promise<MemoryGetResponse | null> {
      if (!getTool) return null
      try {
        const response = await getTool.execute({ filePath })
        return response as MemoryGetResponse
      } catch {
        return null
      }
    },
  }
}

// ---------------------------------------------------------------------------
// buildSearchQuery
// ---------------------------------------------------------------------------

const MAX_QUERY_CHARS = 500

/**
 * Builds a semantic search query from the current turn's prompt, now.md
 * content, and extracted keywords.
 *
 * The query is truncated to ~500 chars to keep latency predictable.
 */
export function buildSearchQuery(
  prompt: string,
  nowContent: string | null,
  keywords: ReadonlySet<string>
): string {
  const parts: string[] = []

  if (prompt.length > 0) {
    parts.push(prompt.slice(0, 300))
  }

  if (nowContent !== null && nowContent.length > 0) {
    // Extract first meaningful line as "current task" signal
    const firstLine = nowContent.split('\n').find((l) => l.trim().length > 3 && !l.startsWith('#'))
    if (firstLine) {
      parts.push(`current task: ${firstLine.trim()}`)
    }
  }

  if (keywords.size > 0) {
    parts.push([...keywords].slice(0, 10).join(' '))
  }

  return parts.join(' ').slice(0, MAX_QUERY_CHARS)
}

// ---------------------------------------------------------------------------
// buildSemanticCandidates
// ---------------------------------------------------------------------------

/**
 * Converts a raw MemorySearchResponse into normalized SemanticCandidates.
 *
 * - Skips disabled responses
 * - Filters out results with empty filePaths
 * - Deduplicates by filePath, keeping the highest raw score per path
 * - Normalizes scores to [0, 1] via min-max scaling
 */
export function buildSemanticCandidates(
  response: MemorySearchResponse,
  minScore: number = 0
): readonly SemanticCandidate[] {
  if (response.disabled) return []
  if (response.results.length === 0) return []

  // Filter empty paths
  const valid = response.results.filter((r) => r.filePath.length > 0)
  if (valid.length === 0) return []

  // Deduplicate by filePath, keeping best (highest) score
  const best = new Map<string, MemorySearchResult>()
  for (const result of valid) {
    const existing = best.get(result.filePath)
    if (!existing || result.score > existing.score) {
      best.set(result.filePath, result)
    }
  }

  const deduped = [...best.values()]

  // Min-max normalization
  const scores = deduped.map((r) => r.score)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min

  const normalized = deduped.map((r) => ({
    filePath: r.filePath,
    snippet: r.snippet,
    // When all scores are equal (range === 0, e.g. single result), normalize to 1.0
    // so the result still contributes as a semantic signal.
    semanticScore: range === 0 ? 1.0 : (r.score - min) / range,
  }))

  // Apply minScore threshold on normalised scores
  return minScore > 0 ? normalized.filter((c) => c.semanticScore >= minScore) : normalized
}
