/**
 * bootstrap.ts — Cold-start elimination for the OMG plugin.
 *
 * Ingests existing OpenClaw memory sources (workspace markdown, session logs,
 * memory-core SQLite) into OMG graph nodes using the Observer LLM pipeline.
 * Runs once at first `gateway_start` when the graph is empty, then writes a
 * sentinel file to prevent re-ingestion.
 */

import path from 'node:path'
import { readFileOrNull } from '../utils/fs.js'
import { listAllNodes } from '../graph/node-reader.js'
import { runObservation } from '../observer/observer.js'
import { writeObservationNode, writeNowNode } from '../graph/node-writer.js'
import { regenerateMoc, applyMocUpdate } from '../graph/moc-manager.js'
import { resolveOmgRoot, resolveMocPath } from '../utils/paths.js'
import { readWorkspaceMemory, readOpenclawLogs, readSqliteChunks } from './sources.js'
import { chunkText, chunkToMessages } from './chunker.js'
import { readSentinel, writeSentinel } from './sentinel.js'
import type { OmgConfig } from '../config.js'
import type { LlmClient } from '../llm/client.js'
import type { SourceChunk } from './chunker.js'
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
   * When true, runs even if the sentinel file exists.
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
  /** Whether bootstrap actually ran (false if sentinel already existed). */
  readonly ran: boolean
  /** Total chunks processed (0 if `ran` is false). */
  readonly chunksProcessed: number
  /** Chunks that produced at least one written node. */
  readonly chunksSucceeded: number
  /** Total nodes written across all chunks. */
  readonly nodesWritten: number
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
// processChunk — mirrors tryRunObservation phases 1–3, no session state
// ---------------------------------------------------------------------------

interface ChunkResult {
  readonly nodesWritten: number
}

/**
 * Processes a single bootstrap chunk:
 *   1. Snapshot existing node index
 *   2. Read current now.md
 *   3. Run LLM observation
 *   4. Write nodes (Promise.allSettled)
 *   5. Update MOCs
 *   6. Update now node
 *
 * Returns the number of nodes successfully written.
 * Never throws — all errors are caught and logged.
 */
async function processChunk(
  chunk: SourceChunk,
  omgRoot: string,
  scope: string,
  config: OmgConfig,
  llmClient: LlmClient
): Promise<ChunkResult> {
  // Phase 1: gather inputs and run LLM observation
  let observerOutput: ObserverOutput
  try {
    const nowContent = await readFileOrNull(path.join(omgRoot, 'now.md'))

    observerOutput = await runObservation({
      unobservedMessages: chunkToMessages(chunk),
      nowNode: nowContent,
      config,
      llmClient,
      sessionContext: { source: 'bootstrap', label: chunk.source },
    })
  } catch (err) {
    console.error(`[omg] bootstrap: observation failed for "${chunk.source}":`, err)
    return { nodesWritten: 0 }
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
      `[omg] bootstrap: ${failedWrites.length}/${writeResults.length} write(s) failed for "${chunk.source}":`,
      failedWrites.map((f) => f.reason)
    )
  }

  // Phase 3: update MOCs
  // Nodes belong to a domain if they link to [[omg/moc-{domain}]], NOT by tags.
  // Tags are semantic keywords; the MOC link is the reliable domain membership signal.
  if (observerOutput.mocUpdates.length > 0) {
    try {
      const allNodes = await listAllNodes(omgRoot)
      for (const domain of observerOutput.mocUpdates) {
        const mocId = `omg/moc-${domain}`
        const domainNodes = allNodes.filter((n) => n.frontmatter.links?.includes(mocId))
        if (domainNodes.length > 0) {
          await regenerateMoc(domain, domainNodes, omgRoot)
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
      console.error(`[omg] bootstrap: MOC update failed for "${chunk.source}":`, err)
    }
  }

  // Phase 4: update now node
  if (observerOutput.nowUpdate !== null && writtenNodes.length > 0) {
    try {
      const writtenIds = writtenNodes.map((n) => n.frontmatter.id)
      await writeNowNode(observerOutput.nowUpdate, writtenIds, writeContext)
    } catch (err) {
      console.error(`[omg] bootstrap: now-node update failed for "${chunk.source}":`, err)
    }
  }

  const nodesWritten = writtenNodes.length
  console.log(
    `[omg] bootstrap: processed "${chunk.source}" → ${nodesWritten} node${nodesWritten !== 1 ? 's' : ''}`
  )

  return { nodesWritten }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/** Default concurrency limit for parallel chunk processing. */
const DEFAULT_CONCURRENCY = 3

/**
 * Runs the bootstrap ingestion pipeline.
 *
 * Reads from up to three sources, chunks the content, and processes each
 * chunk through the Observer LLM pipeline with bounded concurrency.
 * Writes a sentinel file on completion to prevent re-ingestion.
 *
 * Fire-and-forget safe: never throws (all errors are caught and logged).
 */
export async function runBootstrap(params: BootstrapParams): Promise<BootstrapResult> {
  const { workspaceDir, config, llmClient, force = false, source } = params
  const omgRoot = resolveOmgRoot(workspaceDir, config)
  const scope = config.scope ?? workspaceDir

  // Check sentinel (skip if force)
  if (!force) {
    const sentinel = await readSentinel(omgRoot)
    if (sentinel !== null) {
      return { ran: false, chunksProcessed: 0, chunksSucceeded: 0, nodesWritten: 0 }
    }
  }

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
  console.log(
    `[omg] bootstrap: starting — ${[memoryEntries, logEntries, sqliteEntries].filter((e) => e.length > 0).length} sources, ${totalChunks} chunks`
  )

  // Write sentinel immediately so a gateway restart does not re-trigger
  // bootstrap from scratch while processing is already underway.
  await writeSentinel(omgRoot, {
    completedAt: new Date().toISOString(),
    chunksProcessed: totalChunks,
    chunksSucceeded: 0,
  })

  if (totalChunks === 0) {
    console.log('[omg] bootstrap: no content found — sentinel written, skipping future runs')
    return { ran: true, chunksProcessed: 0, chunksSucceeded: 0, nodesWritten: 0 }
  }

  // Process chunks with bounded concurrency
  const tasks = allChunks.map((chunk) => () => processChunk(chunk, omgRoot, scope, config, llmClient))
  const results = await runWithConcurrency(tasks, DEFAULT_CONCURRENCY)

  // Tally results
  let chunksSucceeded = 0
  let nodesWritten = 0
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.nodesWritten > 0) {
      chunksSucceeded++
      nodesWritten += result.value.nodesWritten
    }
  }

  console.log(
    `[omg] bootstrap: complete — ${chunksSucceeded}/${totalChunks} chunks succeeded, ${nodesWritten} nodes written`
  )

  // Write sentinel
  await writeSentinel(omgRoot, {
    completedAt: new Date().toISOString(),
    chunksProcessed: totalChunks,
    chunksSucceeded,
  })

  return { ran: true, chunksProcessed: totalChunks, chunksSucceeded, nodesWritten }
}
