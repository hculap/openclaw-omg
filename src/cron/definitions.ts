/**
 * Cron job definitions for background OMG maintenance tasks.
 *
 * Two scheduled jobs:
 *   - `omg-reflection` — nightly semantic dedup followed by reflection pass.
 *   - `omg-maintenance`       — weekly link repair and text-exact deduplication audit.
 */

import fs from 'node:fs'
import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import { runReflection } from '../reflector/reflector.js'
import { buildReflectionClusters } from '../reflector/cluster-orchestrator.js'
import { runDedup } from '../dedup/dedup.js'
import { runSemanticDedup } from '../dedup/semantic-dedup.js'
import { runBootstrapTick } from '../bootstrap/bootstrap.js'
import { readBootstrapState, writeBootstrapState, markMaintenanceDone } from '../bootstrap/state.js'
import { readGraphNode } from '../graph/node-reader.js'
import { getRegistryEntries, getNodeFilePaths, removeRegistryEntry } from '../graph/registry.js'
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
  /** When set, job IDs are namespaced as `<base>::<jobIdNamespace>` to prevent collisions across workspaces. */
  readonly jobIdNamespace?: string
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000

/** Fixed schedule for the maintenance cron (Sunday 4 AM). */
const MAINTENANCE_SCHEDULE = '0 4 * * 0'

/**
 * Runs the combined graph maintenance pass: semantic dedup then reflection.
 * Dedup failure is non-fatal — reflection still runs.
 * Never throws — errors are logged.
 *
 * @param ageCutoffMs  Optional override for the node age cut-off (epoch ms).
 *   Nodes updated after this timestamp are excluded from reflection.
 *   undefined → default 7-day cap. 0 → all nodes eligible (used post-bootstrap).
 */
export async function graphMaintenanceCronHandler(
  ctx: CronContext,
  ageCutoffMs?: number,
): Promise<void> {
  const omgRoot = resolveOmgRoot(ctx.workspaceDir, ctx.config)

  if (!fs.existsSync(omgRoot)) {
    console.warn(`[omg] cron: omgRoot does not exist — skipping (${omgRoot})`)
    return
  }

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

  // Step 1.5: Semantic dedup (post-literal, gated by config)
  if (ctx.config.semanticDedup.enabled) {
    try {
      const sdResult = await runSemanticDedup({ omgRoot, config: ctx.config, llmClient: ctx.llmClient })
      console.warn(
        `[omg] cron omg-reflection: semantic-dedup — ${sdResult.mergesExecuted} merge(s), ` +
          `${sdResult.nodesArchived} archived, ${sdResult.tokensUsed} tokens`
      )
    } catch (err) {
      console.error('[omg] cron omg-reflection: semantic-dedup failed (continuing to reflection):', err)
    }
  }

  // Step 2: Reflection pass over aged non-archived nodes
  // ageCutoffMs=0 means "no age cap" (all nodes eligible); undefined uses the configured default.
  const defaultCutoffDays = ctx.config.reflection.ageCutoffDays
  const cutoffMs = ageCutoffMs === 0
    ? Date.now()
    : ageCutoffMs !== undefined
      ? ageCutoffMs
      : Date.now() - (defaultCutoffDays * MILLISECONDS_PER_DAY)

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
    console.warn(`[omg] cron omg-reflection: no nodes eligible for reflection (cutoff: ${new Date(cutoffMs).toISOString()})`)
    return
  }

  // Step 3: Clustered or monolithic reflection
  const clusteringEnabled = ctx.config.reflection.clustering.enabled

  if (clusteringEnabled) {
    // --- Clustered reflection ---
    try {
      const clusters = await buildReflectionClusters(
        eligibleEntries,
        ctx.config,
        (filePath: string) => readGraphNode(filePath),
      )

      if (clusters.length === 0) {
        console.warn('[omg] cron omg-reflection: no clusters produced from eligible entries')
        return
      }

      console.warn(`[omg] cron omg-reflection: ${clusters.length} cluster(s) across ${new Set(clusters.map((c) => c.domain)).size} domain(s)`)

      let totalEdits = 0
      let totalDeletions = 0
      let totalTokens = 0
      let clusterFailures = 0

      for (const cluster of clusters) {
        try {
          const result = await runReflection({
            observationNodes: cluster.nodes,
            config: ctx.config,
            llmClient: ctx.llmClient,
            omgRoot,
            sessionKey: `cron:omg-reflection:${cluster.domain}`,
            cluster: {
              domain: cluster.domain,
              timeRange: cluster.timeRange,
              compactPackets: cluster.compactPackets,
            },
          })
          totalEdits += result.edits.length
          totalDeletions += result.deletions.length
          totalTokens += result.tokensUsed
        } catch (err) {
          clusterFailures++
          console.error(
            `[omg] cron omg-reflection: cluster ${cluster.domain} (${cluster.timeRange.start}..${cluster.timeRange.end}) failed:`,
            err,
          )
        }
      }

      console.warn(
        `[omg] cron omg-reflection: clustered reflection — ${totalEdits} node(s) written, ` +
          `${totalDeletions} archived, ${totalTokens} tokens across ${clusters.length} cluster(s)` +
          (clusterFailures > 0 ? ` (${clusterFailures} cluster(s) FAILED)` : '')
      )
    } catch (err) {
      console.error('[omg] cron omg-reflection: clustered reflection failed:', err)
    }
  } else {
    // --- Monolithic reflection (backward compat) ---
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
}

/**
 * Runs weekly maintenance: link repair and deduplication audit.
 * Never throws — errors are logged.
 */
export async function maintenanceCronHandler(ctx: CronContext): Promise<void> {
  const omgRoot = resolveOmgRoot(ctx.workspaceDir, ctx.config)

  if (!fs.existsSync(omgRoot)) {
    console.warn(`[omg] cron: omgRoot does not exist — skipping (${omgRoot})`)
    return
  }

  let allEntries: readonly [string, import('../graph/registry.js').RegistryNodeEntry][]
  try {
    allEntries = await getRegistryEntries(omgRoot)
  } catch (err) {
    console.error('[omg] cron omg-maintenance: failed to read registry:', err)
    return
  }

  const cleanupResult = await cleanupArchivedNodes(
    omgRoot,
    allEntries,
    ctx.config.graphMaintenance.archivedNodeRetentionDays,
  )

  const nodeIdSet = new Set(allEntries.filter(([, e]) => !e.archived).map(([id]) => id))
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
      `${duplicateGroupCount} duplicate description group(s) flagged, ` +
      `${cleanupResult.deletedEntries} archived node(s) cleaned`,
  )
}

async function cleanupArchivedNodes(
  omgRoot: string,
  entries: readonly [string, import('../graph/registry.js').RegistryNodeEntry][],
  retentionDays: number,
): Promise<{ readonly deletedEntries: number }> {
  const cutoffMs = Date.now() - retentionDays * MILLISECONDS_PER_DAY
  const systemTypesToSkip: ReadonlySet<string> = new Set(['index', 'now'])
  let deletedEntries = 0

  for (const [nodeId, entry] of entries) {
    if (!entry.archived || systemTypesToSkip.has(entry.type)) continue

    const updatedMs = new Date(entry.updated).getTime()
    if (Number.isNaN(updatedMs) || updatedMs > cutoffMs) continue

    let shouldRemoveFromRegistry = false

    try {
      await fs.promises.unlink(entry.filePath)
      shouldRemoveFromRegistry = true
    } catch (err) {
      const enoent = (err as NodeJS.ErrnoException).code === 'ENOENT'
      if (!enoent) {
        console.error(
          `[omg] cron omg-maintenance: failed to delete archived node file ${entry.filePath}:`,
          err instanceof Error ? err.message : String(err)
        )
        continue
      }
      shouldRemoveFromRegistry = true
    }

    if (shouldRemoveFromRegistry) {
      try {
        await removeRegistryEntry(omgRoot, nodeId)
        deletedEntries++
      } catch (err) {
        console.error('[omg] cron omg-maintenance: failed to remove archived registry entry:', nodeId, err)
      }
    }
  }

  return { deletedEntries }
}

/**
 * Runs a single bounded bootstrap tick via the cron scheduler.
 * If the tick completes all remaining batches, triggers a post-bootstrap
 * graph maintenance pass (dedup + reflection).
 * Never throws — errors are logged.
 */
async function bootstrapCronHandler(ctx: CronContext): Promise<void> {
  const omgRoot = resolveOmgRoot(ctx.workspaceDir, ctx.config)
  if (!fs.existsSync(omgRoot)) {
    console.warn(`[omg] cron: omgRoot does not exist — skipping (${omgRoot})`)
    return
  }

  // Skip tick entirely if bootstrap is fully completed — avoids lock churn every 5 min
  try {
    const state = await readBootstrapState(omgRoot)
    if (state?.status === 'completed' && state.maintenanceDone) return
  } catch (err) {
    console.warn('[omg] cron: bootstrap state unreadable — proceeding to tick:', err)
  }

  try {
    const result = await runBootstrapTick({
      workspaceDir: ctx.workspaceDir,
      config: ctx.config,
      llmClient: ctx.llmClient,
    })
    if (result.completed) {
      await graphMaintenanceCronHandler(ctx, 0)  // no age cap — nodes just bootstrapped
        .catch((err) => console.error('[omg] cron omg-bootstrap: post-bootstrap maintenance failed:', err))
      const state = await readBootstrapState(omgRoot)
      if (state) await writeBootstrapState(omgRoot, markMaintenanceDone(state))
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

  const id = (base: string): string =>
    ctx.jobIdNamespace !== undefined ? `${base}::${ctx.jobIdNamespace}` : base

  return [
    {
      id: id('omg-bootstrap'),
      schedule: ctx.config.bootstrap.cronSchedule,
      handler: () => bootstrapCronHandler(ctx),
    },
    {
      id: id('omg-reflection'),
      schedule: graphMaintenanceSchedule,
      handler: () => graphMaintenanceCronHandler(ctx),
    },
    {
      id: id('omg-maintenance'),
      schedule: MAINTENANCE_SCHEDULE,
      handler: () => maintenanceCronHandler(ctx),
    },
  ]
}
