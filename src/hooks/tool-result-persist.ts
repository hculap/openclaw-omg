// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ToolResultPersistEvent {
  readonly toolName: string
  readonly result: unknown
}

export interface ToolResultPersistResult {
  readonly referencedNodeIds: readonly string[]
}

/**
 * OpenClaw `tool_result_persist` hook — tags `memory_search` results with the
 * OMG node IDs they reference, for use in context scoring on the next turn.
 *
 * Synchronous — runs on the transcript write hot path.
 * Never throws — returns undefined on any error or non-matching tool.
 *
 * Returns a result tag object when `memory_search` references OMG nodes,
 * otherwise returns `undefined` to leave the result unchanged.
 */
export function toolResultPersist(
  event: ToolResultPersistEvent
): ToolResultPersistResult | undefined {
  if (event.toolName !== 'memory_search') return undefined

  try {
    const text = extractResultText(event.result)
    const nodeIds = extractOmgNodeIds(text)
    return { referencedNodeIds: nodeIds }
  } catch (err) {
    console.error('[omg] tool_result_persist: failed to extract node IDs from memory_search result:', err)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** OMG node ID pattern: starts with omg/, followed by path segments. */
const OMG_NODE_ID_RE = /omg\/[a-z0-9][a-z0-9_/-]*/g

function extractOmgNodeIds(text: string): string[] {
  const matches = text.match(OMG_NODE_ID_RE) ?? []
  return [...new Set(matches)]
}

function extractResultText(result: unknown): string {
  if (result === null || result === undefined) return ''
  if (typeof result === 'string') return result
  if (typeof result !== 'object') return String(result)

  const obj = result as Record<string, unknown>

  // Handle { content: Array<{ type, text }> } shape (OpenClaw standard)
  if (Array.isArray(obj['content'])) {
    return (obj['content'] as unknown[])
      .map((block) => {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>
          return typeof b['text'] === 'string' ? b['text'] : ''
        }
        return ''
      })
      .join(' ')
  }

  return JSON.stringify(result)
}
