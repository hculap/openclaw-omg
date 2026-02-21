/**
 * Cron job definitions for background OMG maintenance tasks.
 *
 * Two scheduled jobs:
 *   - `omg-reflection`  — nightly reflection pass over aged observation nodes.
 *   - `omg-maintenance` — weekly link repair and deduplication audit.
 */

import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import { runReflection } from '../reflector/reflector.js'
import { listAllNodes } from '../graph/node-reader.js'
import { resolveOmgRoot } from '../utils/paths.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single cron job definition. */
export interface CronDefinition {
  readonly id: string
  readonly schedule: string
  readonly handler: () => Promise<void>
}

/** Context required for cron job creation. */
export interface CronContext {
  readonly workspaceDir: string
  readonly config: OmgConfig
  readonly llmClient: LlmClient
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Age threshold in milliseconds (7 days) for the reflection cron. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/** Fixed schedule for the maintenance cron (Sunday 4 AM). */
const MAINTENANCE_SCHEDULE = '0 4 * * 0'

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Runs a reflection pass over observation nodes older than 7 days.
 * Never throws — errors are logged.
 */
async function reflectionCronHandler(ctx: CronContext): Promise<void> {
  const omgRoot = resolveOmgRoot(ctx.workspaceDir, ctx.config)
  const cutoffMs = Date.now() - SEVEN_DAYS_MS

  let allNodes: Awaited<ReturnType<typeof listAllNodes>>
  try {
    allNodes = await listAllNodes(omgRoot)
  } catch (err) {
    console.error('[omg] cron omg-reflection: failed to list nodes:', err)
    return
  }

  const observationNodes = allNodes.filter((n) => {
    if (n.frontmatter.archived) return false
    if (n.frontmatter.type === 'reflection') return false
    const updatedMs = new Date(n.frontmatter.updated).getTime()
    return updatedMs < cutoffMs
  })

  if (observationNodes.length === 0) {
    console.warn('[omg] cron omg-reflection: no eligible nodes found (none older than 7 days or all archived)')
    return
  }

  try {
    const result = await runReflection({
      observationNodes,
      config: ctx.config,
      llmClient: ctx.llmClient,
      omgRoot,
      sessionKey: 'cron:omg-reflection',
    })
    console.warn(
      `[omg] cron omg-reflection: completed — ${result.edits.length} reflection node(s) written, ` +
        `${result.deletions.length} node(s) archived, ${result.tokensUsed} tokens used`,
    )
  } catch (err) {
    console.error('[omg] cron omg-reflection: reflection pass failed:', err)
  }
}

/**
 * Runs weekly maintenance: link repair and deduplication audit.
 * Never throws — errors are logged.
 */
async function maintenanceCronHandler(ctx: CronContext): Promise<void> {
  const omgRoot = resolveOmgRoot(ctx.workspaceDir, ctx.config)

  let allNodes: Awaited<ReturnType<typeof listAllNodes>>
  try {
    allNodes = await listAllNodes(omgRoot)
  } catch (err) {
    console.error('[omg] cron omg-maintenance: failed to list nodes:', err)
    return
  }

  // --- Link repair ---
  const nodeIds = new Set(allNodes.map((n) => n.frontmatter.id))
  let brokenLinkCount = 0
  for (const node of allNodes) {
    const links = node.frontmatter.links ?? []
    for (const link of links) {
      if (!nodeIds.has(link)) {
        console.warn(
          `[omg] cron omg-maintenance: broken wikilink in "${node.frontmatter.id}" → "${link}" (target not found)`,
        )
        brokenLinkCount++
      }
    }
  }

  // --- Deduplication audit (confidence-based, no auto-delete) ---
  const descriptionMap = new Map<string, string[]>()
  for (const node of allNodes) {
    if (node.frontmatter.archived) continue
    const key = node.frontmatter.description.toLowerCase().trim()
    const existing = descriptionMap.get(key) ?? []
    descriptionMap.set(key, [...existing, node.frontmatter.id])
  }

  let duplicateGroupCount = 0
  for (const [description, ids] of descriptionMap) {
    if (ids.length > 1) {
      duplicateGroupCount++
      console.warn(
        `[omg] cron omg-maintenance: duplicate description detected — "${description}" ` +
          `matches ${ids.length} nodes: [${ids.join(', ')}]. Manual review recommended.`,
      )
    }
  }

  console.warn(
    `[omg] cron omg-maintenance: completed — ${brokenLinkCount} broken link(s) found, ` +
      `${duplicateGroupCount} duplicate description group(s) flagged`,
  )
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates all cron job definitions with their handlers bound to `ctx`.
 */
export function createCronDefinitions(ctx: CronContext): readonly CronDefinition[] {
  return [
    {
      id: 'omg-reflection',
      schedule: ctx.config.reflection.cronSchedule,
      handler: () => reflectionCronHandler(ctx),
    },
    {
      id: 'omg-maintenance',
      schedule: MAINTENANCE_SCHEDULE,
      handler: () => maintenanceCronHandler(ctx),
    },
  ]
}
