import type { OmgConfig } from '../config.js'
import { listAllNodes } from '../graph/node-reader.js'
import { resolveOmgRoot } from '../utils/paths.js'
import { selectContext } from '../context/selector.js'
import { renderContextBlock } from '../context/renderer.js'
import { readFileOrNull } from '../utils/fs.js'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BeforeAgentStartEvent {
  readonly prompt: string
}

export interface BeforeAgentStartContext {
  readonly workspaceDir: string
  readonly sessionKey: string
  readonly config: OmgConfig
}

export interface BeforeAgentStartResult {
  readonly prependContext: string
}

/**
 * OpenClaw `before_agent_start` hook — injects relevant memory context into
 * the user turn before the agent processes its prompt.
 *
 * Returns `{ prependContext }` to be prepended to the user message, or
 * `undefined` when the graph is empty and there is nothing to inject.
 *
 * Never throws — returns undefined on any error.
 */
export async function beforeAgentStart(
  event: BeforeAgentStartEvent,
  ctx: BeforeAgentStartContext
): Promise<BeforeAgentStartResult | undefined> {
  try {
    const { workspaceDir, config } = ctx
    const omgRoot = resolveOmgRoot(workspaceDir, config)

    const [indexContent, nowContent, allNodes] = await Promise.all([
      readFileOrNull(path.join(omgRoot, 'index.md')),
      readFileOrNull(path.join(omgRoot, 'now.md')),
      listAllNodes(omgRoot).catch((err) => {
        console.error('[omg] before_agent_start: failed to list graph nodes:', err)
        return []
      }),
    ])

    // Nothing to inject when graph doesn't exist yet
    if (indexContent === null && allNodes.length === 0) {
      return undefined
    }

    const recentMessages = event.prompt
      ? [{ role: 'user' as const, content: event.prompt }]
      : []

    const slice = selectContext({
      indexContent: indexContent ?? '',
      nowContent,
      allNodes,
      recentMessages,
      config,
    })

    const prependContext = renderContextBlock(slice)
    return { prependContext }
  } catch (err) {
    console.error('[omg] before_agent_start failed — context injection skipped:', err)
    return undefined
  }
}

