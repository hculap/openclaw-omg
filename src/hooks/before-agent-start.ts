import type { OmgConfig } from '../config.js'
import type { MemoryTools } from '../context/memory-search.js'
import { readGraphNode } from '../graph/node-reader.js'
import { getNodeCount, getRegistryEntries, type RegistryNodeEntry } from '../graph/registry.js'
import { resolveOmgRoot } from '../utils/paths.js'
import { selectContextV2 } from '../context/selector.js'
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
  /** Optional memory tool interface for semantic boosting. null = registry-only. */
  readonly memoryTools?: MemoryTools | null
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
    const { workspaceDir, config, memoryTools } = ctx
    const omgRoot = resolveOmgRoot(workspaceDir, config)

    const [indexContent, nowContent, nodeCount, registryEntries] = await Promise.all([
      readFileOrNull(path.join(omgRoot, 'index.md')),
      readFileOrNull(path.join(omgRoot, 'now.md')),
      getNodeCount(omgRoot).catch(() => 0),
      getRegistryEntries(omgRoot, { archived: false }).catch((err) => {
        console.error('[omg] before_agent_start: failed to load registry entries:', err)
        return [] as readonly [string, RegistryNodeEntry][]
      }),
    ])

    // Nothing to inject when graph doesn't exist yet
    if (indexContent === null && nodeCount === 0) {
      return undefined
    }

    // Extract only the user's actual message from event.prompt for keyword scoring.
    //
    // The `before_prompt_build` hook receives the full prompt being assembled, which
    // may include noise that pollutes keyword extraction:
    //   1. Prior `<omg-context>` blocks → feedback loop (same nodes re-selected)
    //   2. Channel metadata (Discord topic, group name) → irrelevant keywords
    //   3. Conversation info JSON blocks → sender IDs, channel IDs as keywords
    //   4. `<<<EXTERNAL_UNTRUSTED_CONTENT>>>` wrappers → platform-specific noise
    //
    // We strip all of these to isolate the user's actual message text.
    const cleanedPrompt = event.prompt
      ? extractUserMessage(event.prompt)
      : ''
    const recentMessages = cleanedPrompt
      ? [{ role: 'user' as const, content: cleanedPrompt }]
      : []

    const slice = await selectContextV2({
      indexContent: indexContent ?? '',
      nowContent,
      registryEntries,
      recentMessages,
      config,
      hydrateNode: readGraphNode,
      memoryTools,
    })

    const prependContext = renderContextBlock(slice)
    return { prependContext }
  } catch (err) {
    console.error('[omg] before_agent_start failed — context injection skipped:', err)
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Prompt cleaning — isolate user message from platform noise
// ---------------------------------------------------------------------------

/**
 * Extracts the user's actual message from the raw `event.prompt` string.
 *
 * OpenClaw's `before_prompt_build` passes the full prompt being assembled, which
 * may include platform metadata (Discord channel info, conversation JSON, etc.)
 * and prior injected `<omg-context>` blocks. We strip all of these so that
 * keyword extraction only operates on the user's own words.
 */
export function extractUserMessage(raw: string): string {
  let text = raw

  // 1. Strip prior <omg-context> blocks (prevents feedback loop)
  text = text.replace(/<omg-context>[\s\S]*?<\/omg-context>/g, '')

  // 2. Strip ```json ... ``` metadata blocks (conversation info, sender info)
  text = text.replace(/```json[\s\S]*?```/g, '')

  // 3. Strip <<<EXTERNAL_UNTRUSTED_CONTENT>>> wrappers (channel metadata)
  text = text.replace(/<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/g, '')

  // 4. Strip metadata label lines that precede the stripped blocks
  text = text.replace(/^(?:Conversation info|Sender|Untrusted context)\s*\([^)]*\)\s*:?\s*$/gm, '')

  // 5. Strip ## Current Now Node and its frontmatter (system prompt injection)
  text = text.replace(/## Current Now Node[\s\S]*?---\n[\s\S]*?---/g, '')

  return text.trim()
}
