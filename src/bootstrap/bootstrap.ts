/**
 * bootstrap.ts — Cold-start elimination for the OMG plugin.
 *
 * Ingests existing OpenClaw memory sources (workspace markdown, session logs,
 * memory-core SQLite) into OMG graph nodes using the Observer LLM pipeline.
 * Runs once at first `gateway_start` when the graph is empty, then writes a
 * state file (`.bootstrap-state.json`) to prevent re-ingestion. If the process
 * crashes mid-run, the state machine enables cursor-based resume on the next
 * gateway start.
 *
 * Source chunks are packed into batches (controlled by `config.bootstrap.batchCharBudget`)
 * to reduce the number of LLM calls while preserving the same XML parser pipeline.
 */

import path from 'node:path'
import { readFileOrNull } from '../utils/fs.js'
import { readGraphNode } from '../graph/node-reader.js'
import { getNodeIndex, getRegistryEntries, getNodeFilePaths } from '../graph/registry.js'
import { runObservation } from '../observer/observer.js'
import { writeObservationNode, writeNowNode } from '../graph/node-writer.js'
import { regenerateMoc, applyMocUpdate } from '../graph/moc-manager.js'
import { resolveOmgRoot, resolveMocPath } from '../utils/paths.js'
import { readWorkspaceMemory, readOpenclawLogs, readSqliteChunks } from './sources.js'
import { chunkText } from './chunker.js'
import { batchChunks, batchToMessages, computeBatchMaxTokens } from './batcher.js'
import {
  readBootstrapState,
  writeBootstrapState,
  createInitialState,
  advanceBatch,
  finalizeState,
  shouldBootstrap,
  computeCursor,
  createDebouncedFlush,
  type BootstrapState,
} from './state.js'
import { acquireLock, releaseLock, refreshLock } from './lock.js'
import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import type { SourceChunk } from './chunker.js'
import type { SourceBatch } from './batcher.js'
import type { GraphNode, ObserverOutput } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Source selection for CLI invocation. */
/** @deprecated Use `config.bootstrap.sources` instead. Kept for CLI backward-compat. */
export type BootstrapSource = 'memory' | 'logs' | 'sqlite' | 'all'

/** Parameters for {@link runBootstrap}. */
export interface BootstrapParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceDir: string
  /** Resolved OMG plugin configuration. */
  readonly config: OmgConfig
  /** LLM client for generating observations. */
  readonly llmClient: LlmClient
  /**
   * When true, runs from scratch regardless of existing state.
   * Useful for CLI `--force` invocation.
   */
  readonly force?: boolean
  /**
   * Which sources to include.
   * @deprecated Pass source overrides via `config.bootstrap.sources` instead.
   * When set, overrides config.bootstrap.sources for that specific source.
   */
  readonly source?: BootstrapSource
}

/** Result summary returned by {@link runBootstrap}. */
export interface BootstrapResult {
  /** Whether bootstrap actually ran (false if state was already completed). */
  readonly ran: boolean
  /** Total chunks processed (0 if `ran` is false). */
  readonly chunksProcessed: number
  /** Chunks in batches that completed without error. */
  readonly chunksSucceeded: number
  /** Total nodes written across all chunks. */
  readonly nodesWritten: number
  /** Number of batches (LLM calls). Undefined for pre-batch runs. */
  readonly batchCount?: number
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/**
 * Runs `tasks` with at most `limit` concurrent executions.
 * Uses `Promise.allSettled` internally so all tasks run regardless of failures.
 */
async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number
): Promise<readonly PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = []
  let idx = 0

  async function runNext(): Promise<void> {
    while (idx < tasks.length) {
      const taskIdx = idx++
      const task = tasks[taskIdx]
      if (task === undefined) continue
      try {
        const value = await task()
        results[taskIdx] = { status: 'fulfilled', value }
      } catch (reason) {
        results[taskIdx] = { status: 'rejected', reason }
      }
    }
  }

  // Start `limit` workers
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => runNext())
  await Promise.all(workers)

  return results
}

// ---------------------------------------------------------------------------
// processBatch — replaces per-chunk processChunk
// ---------------------------------------------------------------------------

interface BatchResult {
  readonly nodesWritten: number
  readonly chunkCount: number
  /** Whether the LLM observation completed without error. */
  readonly observationSucceeded: boolean
}

/**
 * Processes a batch of bootstrap chunks in a single LLM call:
 *   1. Read node index + now.md once per batch
 *   2. Build messages via batchToMessages
 *   3. Run LLM observation with scaled maxOutputTokens
 *   4. Write nodes (Promise.allSettled)
 *   5. Deduplicate and apply MOC updates
 *   6. Write now-node once per batch
 *
 * Never throws — all errors are caught and logged.
 */
async function processBatch(
  batch: SourceBatch,
  omgRoot: string,
  scope: string,
  config: OmgConfig,
  llmClient: LlmClient
): Promise<BatchResult> {
  const batchLabel = batch.chunks.length === 1
    ? batch.chunks[0]!.source
    : `batch ${batch.batchIndex} (${batch.chunks.length} chunks)`

  // Phase 1: gather inputs and run LLM observation
  let observerOutput: ObserverOutput
  try {
    const nowContent = await readFileOrNull(path.join(omgRoot, 'now.md'))
    const messages = batchToMessages(batch)
    const maxOutputTokens = computeBatchMaxTokens(batch.chunks.length)

    observerOutput = await runObservation({
      unobservedMessages: messages,
      nowNode: nowContent,
      config,
      llmClient,
      sessionContext: { source: 'bootstrap', label: batchLabel },
      maxOutputTokens,
    })
  } catch (err) {
    console.error(`[omg] bootstrap: observation failed for "${batchLabel}":`, err)
    return { nodesWritten: 0, chunkCount: batch.chunks.length, observationSucceeded: false }
  }

  // Phase 2: write nodes
  const writeContext = { omgRoot, sessionKey: 'bootstrap', scope }
  const writeResults = await Promise.allSettled(
    observerOutput.operations.map((op) => writeObservationNode(op, writeContext))
  )

  const writtenNodes: GraphNode[] = writeResults
    .filter((r): r is PromiseFulfilledResult<GraphNode> => r.status === 'fulfilled')
    .map((r) => r.value)

  const failedWrites = writeResults.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
  if (failedWrites.length > 0) {
    console.error(
      `[omg] bootstrap: ${failedWrites.length}/${writeResults.length} write(s) failed for "${batchLabel}":`,
      failedWrites.map((f) => f.reason)
    )
  }

  // Phase 3: update MOCs — deduplicate domains across all operations in the batch
  if (observerOutput.mocUpdates.length > 0) {
    const uniqueDomains = [...new Set(observerOutput.mocUpdates)]
    try {
      const allEntries = await getRegistryEntries(omgRoot)
      for (const domain of uniqueDomains) {
        const mocId = `omg/moc-${domain}`
        const domainEntries = allEntries.filter(([, e]) => e.links?.includes(mocId))
        if (domainEntries.length > 0) {
          const nodeIds = domainEntries.map(([id]) => id)
          const filePaths = await getNodeFilePaths(omgRoot, nodeIds)
          const domainNodes = (await Promise.all(
            [...filePaths.values()].map((fp) => readGraphNode(fp))
          )).filter((n): n is NonNullable<typeof n> => n !== null)
          if (domainNodes.length > 0) {
            await regenerateMoc(domain, domainNodes, omgRoot)
          }
        } else {
          const mocPath = resolveMocPath(omgRoot, domain)
          const domainWrittenIds = writtenNodes
            .filter((n) => n.frontmatter.links?.includes(mocId))
            .map((n) => n.frontmatter.id)
          for (const id of domainWrittenIds) {
            await applyMocUpdate(mocPath, { action: 'add', nodeId: id })
          }
        }
      }
    } catch (err) {
      console.error(`[omg] bootstrap: MOC update failed for "${batchLabel}":`, err)
    }
  }

  // Phase 4: update now node — once per batch
  if (observerOutput.nowUpdate !== null && writtenNodes.length > 0) {
    try {
      const writtenIds = writtenNodes.map((n) => n.frontmatter.id)
      await writeNowNode(observerOutput.nowUpdate, writtenIds, writeContext)
    } catch (err) {
      console.error(`[omg] bootstrap: now-node update failed for "${batchLabel}":`, err)
    }
  }

  const nodesWritten = writtenNodes.length
  console.log(
    `[omg] bootstrap: processed "${batchLabel}" → ${nodesWritten} node${nodesWritten !== 1 ? 's' : ''}`
  )

  return { nodesWritten, chunkCount: batch.chunks.length, observationSucceeded: true }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/** Default concurrency limit for parallel batch processing. */
const DEFAULT_CONCURRENCY = 3

/**
 * Runs the bootstrap ingestion pipeline.
 *
 * Reads from up to three sources, chunks the content, packs chunks into
 * batches, and processes each batch through the Observer LLM pipeline with
 * bounded concurrency. Tracks progress in a state file so that a crash
 * mid-run can be resumed on the next gateway start.
 *
 * Fire-and-forget safe: never throws (all errors are caught and logged).
 */
export async function runBootstrap(params: BootstrapParams): Promise<BootstrapResult> {
  const { workspaceDir, config, llmClient, force = false, source } = params
  const omgRoot = resolveOmgRoot(workspaceDir, config)
  const scope = config.scope ?? workspaceDir

  const lockAcquired = await acquireLock(omgRoot)
  if (!lockAcquired) {
    return { ran: false, chunksProcessed: 0, chunksSucceeded: 0, nodesWritten: 0 }
  }

  try {
    return await _runBootstrapLocked({ workspaceDir, omgRoot, scope, config, llmClient, force, source })
  } finally {
    await releaseLock(omgRoot)
  }
}

async function _runBootstrapLocked(params: BootstrapParams & {
  readonly omgRoot: string
  readonly scope: string
}): Promise<BootstrapResult> {
  const { workspaceDir, omgRoot, scope, config, llmClient, force = false, source } = params

  // Check state (skip if force)
  const existingState = await readBootstrapState(omgRoot)
  const decision = shouldBootstrap(existingState, force)
  if (!decision.needed) {
    return { ran: false, chunksProcessed: 0, chunksSucceeded: 0, nodesWritten: 0 }
  }
  const previousDone = force ? undefined : decision.resumeFromDone

  // Resolve which sources to use.
  // config.bootstrap.sources is the canonical config; the deprecated `source`
  // param can override individual flags for CLI invocations.
  const srcs = config.bootstrap.sources
  const useMemory = source === 'memory' || source === 'all' || (source === undefined && srcs.workspaceMemory)
  const useLogs   = source === 'logs'   || source === 'all' || (source === undefined && srcs.openclawLogs)
  const useSqlite = source === 'sqlite' || source === 'all' || (source === undefined && srcs.openclawSessions)

  // Gather source entries
  const [memoryEntries, logEntries, sqliteEntries] = await Promise.all([
    useMemory
      ? readWorkspaceMemory(workspaceDir, config.storagePath).catch((err) => {
          console.error('[omg] bootstrap: workspace memory read failed:', err)
          return []
        })
      : Promise.resolve([]),
    useLogs
      ? readOpenclawLogs().catch((err) => {
          console.error('[omg] bootstrap: openclaw logs read failed:', err)
          return []
        })
      : Promise.resolve([]),
    useSqlite
      ? readSqliteChunks(workspaceDir).catch((err) => {
          console.error('[omg] bootstrap: sqlite chunks read failed:', err)
          return []
        })
      : Promise.resolve([]),
  ])

  // Build chunks from all entries
  const allChunks: SourceChunk[] = []
  for (const entry of [...memoryEntries, ...logEntries, ...sqliteEntries]) {
    const chunks = chunkText(entry.text, entry.label)
    allChunks.push(...chunks)
  }

  const totalChunks = allChunks.length

  // Pack chunks into batches
  const batches = batchChunks(allChunks, config.bootstrap.batchCharBudget)

  console.log(
    `[omg] bootstrap: starting — ${[memoryEntries, logEntries, sqliteEntries].filter((e) => e.length > 0).length} sources, ${totalChunks} chunks, ${batches.length} batches`
  )

  // Initialise state — carry forward progress when resuming
  let state: BootstrapState =
    previousDone && existingState
      ? {
          ...createInitialState(batches.length),
          ok: existingState.ok,
          fail: existingState.fail,
          done: [...previousDone],
          cursor: computeCursor(previousDone, batches.length),
        }
      : createInitialState(batches.length)
  await writeBootstrapState(omgRoot, state)

  if (totalChunks === 0) {
    state = finalizeState(state)
    await writeBootstrapState(omgRoot, state)
    console.log('[omg] bootstrap: no content found — state written, skipping future runs')
    return { ran: true, chunksProcessed: 0, chunksSucceeded: 0, nodesWritten: 0, batchCount: 0 }
  }

  // Build per-batch tasks, skipping already-completed batches
  const doneSet = new Set(previousDone ?? [])
  const debouncedFlush = createDebouncedFlush(omgRoot)

  const tasks = batches
    .filter((batch) => !doneSet.has(batch.batchIndex))
    .map((batch) => async () => {
      const result = await processBatch(batch, omgRoot, scope, config, llmClient)
      state = advanceBatch(state, batch.batchIndex, result)
      debouncedFlush.flush(state)
      void refreshLock(omgRoot)
      return result
    })

  const results = await runWithConcurrency(tasks, DEFAULT_CONCURRENCY)
  await debouncedFlush.flushNow(state)

  // Tally nodes written
  let nodesWritten = 0
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.observationSucceeded) {
      nodesWritten += result.value.nodesWritten
    }
  }

  state = finalizeState(state)
  await writeBootstrapState(omgRoot, state)

  console.log(
    `[omg] bootstrap: complete — ${state.ok}/${totalChunks} chunks succeeded (${batches.length} batches), ${nodesWritten} nodes written`
  )

  return {
    ran: true,
    chunksProcessed: totalChunks,
    chunksSucceeded: state.ok,
    nodesWritten,
    batchCount: batches.length,
  }
}
