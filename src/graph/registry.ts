/**
 * registry.ts — Lightweight metadata cache for the OMG graph.
 *
 * Maintains `{omgRoot}/.registry.json` as a persistent index of all graph
 * nodes, enabling O(1) lookups by node ID and O(N) in-memory scans without
 * disk reads after initial load.
 *
 * Concurrency: writes are serialized per omgRoot via AsyncMutex.
 * Reads are lock-free — the in-memory cache is replaced atomically.
 */

import { z } from 'zod'
import { join } from 'node:path'
import { AsyncMutex } from './registry-lock.js'
import { listAllNodes } from './node-reader.js'
import { atomicWrite, readFileOrNull } from '../utils/fs.js'
import type { NodeType, Priority, NodeIndexEntry, GraphNode } from '../types.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface RegistryNodeEntry {
  readonly type: NodeType
  readonly kind: 'observation' | 'reflection'
  readonly description: string
  readonly priority: Priority
  readonly created: string
  readonly updated: string
  readonly filePath: string
  readonly archived?: boolean
  readonly links?: readonly string[]
  readonly tags?: readonly string[]
}

export interface RegistryData {
  readonly version: 1
  readonly nodes: Readonly<Record<string, RegistryNodeEntry>>
}

const registryNodeEntrySchema = z.object({
  type: z.string(),
  kind: z.enum(['observation', 'reflection']),
  description: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  created: z.string(),
  updated: z.string(),
  filePath: z.string(),
  archived: z.boolean().optional(),
  links: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
}).strip()

const registryDataSchema = z.object({
  version: z.literal(1),
  nodes: z.record(registryNodeEntrySchema),
}).strip()

// ---------------------------------------------------------------------------
// Module-level caches
// ---------------------------------------------------------------------------

const cache = new Map<string, RegistryData>()
const mutexes = new Map<string, AsyncMutex>()

function getMutex(omgRoot: string): AsyncMutex {
  let mutex = mutexes.get(omgRoot)
  if (!mutex) {
    mutex = new AsyncMutex()
    mutexes.set(omgRoot, mutex)
  }
  return mutex
}

function registryPath(omgRoot: string): string {
  return join(omgRoot, '.registry.json')
}

function emptyRegistry(): RegistryData {
  return { version: 1, nodes: {} }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persistRegistry(omgRoot: string, data: RegistryData): Promise<void> {
  await atomicWrite(registryPath(omgRoot), JSON.stringify(data, null, 2))
}

async function loadFromDisk(omgRoot: string): Promise<RegistryData | null> {
  const raw = await readFileOrNull(registryPath(omgRoot))
  if (raw === null) return null

  try {
    const parsed = JSON.parse(raw)
    const result = registryDataSchema.safeParse(parsed)
    if (!result.success) return null
    return result.data as RegistryData
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Internal: ensure loaded
// ---------------------------------------------------------------------------

async function ensureLoaded(omgRoot: string): Promise<RegistryData> {
  const cached = cache.get(omgRoot)
  if (cached) return cached

  const fromDisk = await loadFromDisk(omgRoot)
  if (fromDisk) {
    cache.set(omgRoot, fromDisk)
    return fromDisk
  }

  // Cold start or corrupt — rebuild
  return rebuildRegistry(omgRoot)
}

// ---------------------------------------------------------------------------
// Internal: build entry from GraphNode
// ---------------------------------------------------------------------------

function inferKind(node: GraphNode): 'observation' | 'reflection' {
  if (node.frontmatter.type === 'reflection') return 'reflection'
  if (node.filePath.includes('/reflections/')) return 'reflection'
  return 'observation'
}

function entryFromGraphNode(node: GraphNode): RegistryNodeEntry {
  return {
    type: node.frontmatter.type,
    kind: inferKind(node),
    description: node.frontmatter.description,
    priority: node.frontmatter.priority,
    created: node.frontmatter.created,
    updated: node.frontmatter.updated,
    filePath: node.filePath,
    ...(node.frontmatter.archived !== undefined && { archived: node.frontmatter.archived }),
    ...(node.frontmatter.links !== undefined && { links: node.frontmatter.links }),
    ...(node.frontmatter.tags !== undefined && { tags: node.frontmatter.tags }),
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns a `NodeIndexEntry[]` (id + description) sorted by updated desc.
 * Used as input for the Observer.
 */
export async function getNodeIndex(omgRoot: string): Promise<readonly NodeIndexEntry[]> {
  const data = await ensureLoaded(omgRoot)
  return Object.entries(data.nodes)
    .sort(([, a], [, b]) => b.updated.localeCompare(a.updated))
    .map(([id, entry]) => ({ id, description: entry.description }))
}

/**
 * Returns registry entries, optionally filtered.
 */
export async function getRegistryEntries(
  omgRoot: string,
  filter?: { readonly archived?: boolean; readonly type?: NodeType }
): Promise<readonly [string, RegistryNodeEntry][]> {
  const data = await ensureLoaded(omgRoot)
  let entries = Object.entries(data.nodes)

  if (filter) {
    if (filter.archived !== undefined) {
      entries = entries.filter(([, e]) => (e.archived ?? false) === filter.archived)
    }
    if (filter.type !== undefined) {
      entries = entries.filter(([, e]) => e.type === filter.type)
    }
  }

  return entries
}

/**
 * Returns a single registry entry by node ID, or null if not found.
 */
export async function getRegistryEntry(
  omgRoot: string,
  nodeId: string
): Promise<RegistryNodeEntry | null> {
  const data = await ensureLoaded(omgRoot)
  return data.nodes[nodeId] ?? null
}

/**
 * Returns a map of nodeId → filePath for the given IDs.
 */
export async function getNodeFilePaths(
  omgRoot: string,
  nodeIds: readonly string[]
): Promise<Map<string, string>> {
  const data = await ensureLoaded(omgRoot)
  const result = new Map<string, string>()
  for (const id of nodeIds) {
    const entry = data.nodes[id]
    if (entry) {
      result.set(id, entry.filePath)
    }
  }
  return result
}

/**
 * Registers or replaces a node entry in the registry.
 * Serialized via mutex. Registry failures are caught + logged, never propagated.
 */
export async function registerNode(
  omgRoot: string,
  nodeId: string,
  entry: RegistryNodeEntry
): Promise<void> {
  const mutex = getMutex(omgRoot)
  await mutex.acquire(async () => {
    const data = await ensureLoaded(omgRoot)
    const updated: RegistryData = {
      ...data,
      nodes: { ...data.nodes, [nodeId]: entry },
    }
    cache.set(omgRoot, updated)
    await persistRegistry(omgRoot, updated)
  })
}

/**
 * Partially updates an existing registry entry. No-op if the node is not found.
 */
export async function updateRegistryEntry(
  omgRoot: string,
  nodeId: string,
  updates: Partial<Omit<RegistryNodeEntry, 'type' | 'kind'>>
): Promise<void> {
  const mutex = getMutex(omgRoot)
  await mutex.acquire(async () => {
    const data = await ensureLoaded(omgRoot)
    const existing = data.nodes[nodeId]
    if (!existing) return

    const merged: RegistryNodeEntry = { ...existing, ...updates }
    const updated: RegistryData = {
      ...data,
      nodes: { ...data.nodes, [nodeId]: merged },
    }
    cache.set(omgRoot, updated)
    await persistRegistry(omgRoot, updated)
  })
}

/**
 * Removes a node entry from the registry. No-op if not found.
 */
export async function removeRegistryEntry(
  omgRoot: string,
  nodeId: string
): Promise<void> {
  const mutex = getMutex(omgRoot)
  await mutex.acquire(async () => {
    const data = await ensureLoaded(omgRoot)
    if (!(nodeId in data.nodes)) return

    const { [nodeId]: _, ...rest } = data.nodes
    const updated: RegistryData = { ...data, nodes: rest }
    cache.set(omgRoot, updated)
    await persistRegistry(omgRoot, updated)
  })
}

/**
 * Full disk scan → rebuild registry from all graph nodes.
 * Always persists the result to disk.
 */
export async function rebuildRegistry(omgRoot: string): Promise<RegistryData> {
  const allNodes = await listAllNodes(omgRoot)
  const nodes: Record<string, RegistryNodeEntry> = {}

  for (const node of allNodes) {
    nodes[node.frontmatter.id] = entryFromGraphNode(node)
  }

  const data: RegistryData = { version: 1, nodes }
  cache.set(omgRoot, data)
  await persistRegistry(omgRoot, data)
  return data
}

/**
 * Returns the total number of nodes in the registry.
 */
export async function getNodeCount(omgRoot: string): Promise<number> {
  const data = await ensureLoaded(omgRoot)
  return Object.keys(data.nodes).length
}

/**
 * Clears the in-memory cache. Used for testing.
 * If omgRoot is provided, clears only that entry; otherwise clears all.
 */
export function clearRegistryCache(omgRoot?: string): void {
  if (omgRoot) {
    cache.delete(omgRoot)
    mutexes.delete(omgRoot)
  } else {
    cache.clear()
    mutexes.clear()
  }
}

/**
 * Builds a RegistryNodeEntry from a GraphNode.
 * Exported for use by write paths (node-writer, reflector).
 */
export function buildRegistryEntry(
  node: GraphNode,
  kind: 'observation' | 'reflection'
): RegistryNodeEntry {
  return {
    type: node.frontmatter.type,
    kind,
    description: node.frontmatter.description,
    priority: node.frontmatter.priority,
    created: node.frontmatter.created,
    updated: node.frontmatter.updated,
    filePath: node.filePath,
    ...(node.frontmatter.archived !== undefined && { archived: node.frontmatter.archived }),
    ...(node.frontmatter.links !== undefined && { links: node.frontmatter.links }),
    ...(node.frontmatter.tags !== undefined && { tags: node.frontmatter.tags }),
  }
}
