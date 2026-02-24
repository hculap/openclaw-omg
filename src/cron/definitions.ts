/**
 * Cron job definitions for background OMG maintenance tasks.
 *
 * Two scheduled jobs:
 *   - `omg-reflection` — nightly semantic dedup followed by reflection pass.
 *   - `omg-maintenance`       — weekly link repair and text-exact deduplication audit.
 */

import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import { runReflection } from '../reflector/reflector.js'
import { runDedup } from '../dedup/dedup.js'
import { runBootstrapTick } from '../bootstrap/bootstrap.js'
import { readGraphNode } from '../graph/node-reader.js'
import { getRegistryEntries, getNodeFilePaths } from '../graph/registry.js'
import { resolveOmgRoot } from '../utils/paths.js'

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

/** Age threshold in milliseconds (7 days) for the reflection step. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

/** Fixed schedule for the maintenance cron (Sunday 4 AM). */
const MAINTENANCE_SCHEDULE = '0 4 * * 0'

/**
 * Runs the combined graph maintenance pass: semantic dedup then reflection.
 * Dedup failure is non-fatal — reflection still runs.
 * Never throws — errors are logged.
 */
export async function graphMaintenanceCronHandler(ctx: CronContext): Promise<void> {
  const omgRoot = resolveOmgRoot(ctx.workspaceDir, ctx.config)

  // Step 1: Semantic dedup
  try {
    const dedupResult = await runDedup({ omgRoot, config: ctx.config, llmClient: ctx.llmClient })
    console.warn(
      `[omg] cron omg-reflection: dedup — ${dedupResult.mergesExecuted} merge(s), ` +
        `${dedupResult.nodesArchived} archived, ${dedupResult.tokensUsed} tokens`
    )
  } catch (err) {
    console.error('[omg] cron omg-reflection: dedup failed (continuing to reflection):', err)
  }

  // Step 2: Reflection pass over aged non-archived nodes
  const cutoffMs = Date.now() - SEVEN_DAYS_MS

  let eligibleEntries: readonly [string, import('../graph/registry.js').RegistryNodeEntry][]
  try {
    const allEntries = await getRegistryEntries(omgRoot)
    eligibleEntries = allEntries.filter(([, e]) => {
      if (e.archived) return false
      if (e.type === 'reflection') return false
      const updatedMs = new Date(e.updated).getTime()
      return updatedMs < cutoffMs
    })
  } catch (err) {
    console.error('[omg] cron omg-reflection: failed to read registry for reflection:', err)
    return
  }

  if (eligibleEntries.length === 0) {
    console.warn('[omg] cron omg-reflection: no nodes eligible for reflection (none older than 7 days)')
    return
  }

  const nodeIds = eligibleEntries.map(([id]) => id)
  let observationNodes: Awaited<ReturnType<typeof readGraphNode>>[]
  try {
    const filePaths = await getNodeFilePaths(omgRoot, nodeIds)
    observationNodes = await Promise.all(
      [...filePaths.values()].map((fp) => readGraphNode(fp))
    )
  } catch (err) {
    console.error('[omg] cron omg-reflection: failed to hydrate nodes for reflection:', err)
    return
  }
  const validNodes = observationNodes.filter((n): n is NonNullable<typeof n> => n !== null)

  if (validNodes.length === 0) {
    console.warn('[omg] cron omg-reflection: no valid nodes for reflection after hydration')
    return
  }

  try {
    const result = await runReflection({
      observationNodes: validNodes,
      config: ctx.config,
      llmClient: ctx.llmClient,
      omgRoot,
      sessionKey: 'cron:omg-reflection',
    })
    console.warn(
      `[omg] cron omg-reflection: reflection — ${result.edits.length} node(s) written, ` +
        `${result.deletions.length} archived, ${result.tokensUsed} tokens`
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

  let allEntries: readonly [string, import('../graph/registry.js').RegistryNodeEntry][]
  try {
    allEntries = await getRegistryEntries(omgRoot)
  } catch (err) {
    console.error('[omg] cron omg-maintenance: failed to read registry:', err)
    return
  }

  const nodeIdSet = new Set(allEntries.map(([id]) => id))
  let brokenLinkCount = 0
  for (const [id, entry] of allEntries) {
    const links = entry.links ?? []
    for (const link of links) {
      if (!nodeIdSet.has(link)) {
        console.warn(
          `[omg] cron omg-maintenance: broken wikilink in "${id}" → "${link}" (target not found)`,
        )
        brokenLinkCount++
      }
    }
  }

  const descriptionMap = new Map<string, string[]>()
  for (const [id, entry] of allEntries) {
    if (entry.archived) continue
    const key = entry.description.toLowerCase().trim()
    const existing = descriptionMap.get(key) ?? []
    descriptionMap.set(key, [...existing, id])
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

/**
 * Runs a single bounded bootstrap tick via the cron scheduler.
 * If the tick completes all remaining batches, triggers a post-bootstrap
 * graph maintenance pass (dedup + reflection).
 * Never throws — errors are logged.
 */
async function bootstrapCronHandler(ctx: CronContext): Promise<void> {
  try {
    const result = await runBootstrapTick({
      workspaceDir: ctx.workspaceDir,
      config: ctx.config,
      llmClient: ctx.llmClient,
    })
    if (result.completed) {
      await graphMaintenanceCronHandler(ctx)
        .catch((err) => console.error('[omg] cron omg-bootstrap: post-bootstrap maintenance failed:', err))
    }
  } catch (err) {
    console.error('[omg] cron omg-bootstrap: tick failed:', err)
  }
}

/**
 * Creates all cron job definitions with their handlers bound to `ctx`.
 * Returns three definitions: `omg-bootstrap`, `omg-reflection`, and `omg-maintenance`.
 */
export function createCronDefinitions(ctx: CronContext): readonly CronDefinition[] {
  const graphMaintenanceSchedule =
    ctx.config.graphMaintenance.cronSchedule ?? ctx.config.reflection.cronSchedule

  return [
    {
      id: 'omg-bootstrap',
      schedule: ctx.config.bootstrap.cronSchedule,
      handler: () => bootstrapCronHandler(ctx),
    },
    {
      id: 'omg-reflection',
      schedule: graphMaintenanceSchedule,
      handler: () => graphMaintenanceCronHandler(ctx),
    },
    {
      id: 'omg-maintenance',
      schedule: MAINTENANCE_SCHEDULE,
      handler: () => maintenanceCronHandler(ctx),
    },
  ]
}
