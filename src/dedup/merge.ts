/**
 * Merge execution for the semantic dedup subsystem.
 * Applies patches to keeper nodes and archives losers with mergedInto field.
 */
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import type { NodeFrontmatter } from '../types.js'
import type { MergePlan, DedupAuditEntry } from './types.js'
import { parseFrontmatter, serializeFrontmatter } from '../utils/frontmatter.js'
import { atomicWrite, isEnoent } from '../utils/fs.js'
import { updateRegistryEntry } from '../graph/registry.js'

// ---------------------------------------------------------------------------
// applyPatch
// ---------------------------------------------------------------------------

/**
 * Immutably merges a patch into a node's frontmatter and body.
 * - Tags and links are unioned (no duplicates).
 * - Description is overlaid when patch provides one.
 * - AliasKeys are added to aliases (no duplicates).
 * - BodyAppend is appended to body with a separator.
 * - updated is set to now.
 */
export function applyPatch(
  frontmatter: NodeFrontmatter,
  body: string,
  patch: MergePlan['patch'],
  aliasKeys: readonly string[]
): { frontmatter: NodeFrontmatter; body: string } {
  const now = new Date().toISOString()

  // Union tags
  const existingTags = frontmatter.tags ?? []
  const patchTags = patch.tags ?? []
  const mergedTags = [...new Set([...existingTags, ...patchTags])]

  // Union links
  const existingLinks = frontmatter.links ?? []
  const patchLinks = patch.links ?? []
  const mergedLinks = [...new Set([...existingLinks, ...patchLinks])]

  // Union aliases
  const existingAliases = frontmatter.aliases ?? []
  const mergedAliases = [...new Set([...existingAliases, ...aliasKeys])]

  const newFrontmatter: NodeFrontmatter = {
    ...frontmatter,
    description: patch.description ?? frontmatter.description,
    updated: now,
    ...(mergedTags.length > 0 ? { tags: mergedTags } : {}),
    ...(mergedLinks.length > 0 ? { links: mergedLinks } : {}),
    ...(mergedAliases.length > 0 ? { aliases: mergedAliases } : {}),
  }

  const newBody = patch.bodyAppend
    ? `${body.trimEnd()}\n\n${patch.bodyAppend}`
    : body

  return { frontmatter: newFrontmatter, body: newBody }
}

// ---------------------------------------------------------------------------
// archiveAsMerged
// ---------------------------------------------------------------------------

/**
 * Marks a node as archived and records which node it was merged into.
 * Reads the node file, sets `archived: true` and `mergedInto: keepNodeId`,
 * then writes back atomically. Silently skips missing files.
 */
export async function archiveAsMerged(
  filePath: string,
  nodeId: string,
  keepNodeId: string,
  omgRoot: string
): Promise<void> {
  let raw: string
  try {
    raw = await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return
    throw err
  }

  let frontmatterRecord: Record<string, unknown>
  let body: string
  try {
    const parsed = parseFrontmatter(raw)
    frontmatterRecord = { ...parsed.frontmatter, archived: true, mergedInto: keepNodeId }
    body = parsed.body
  } catch (err) {
    console.warn(
      `[omg] dedup: skipping archive of "${filePath}" — frontmatter parse failed:`,
      err instanceof Error ? err.message : String(err)
    )
    return
  }

  await fs.mkdir(dirname(filePath), { recursive: true })
  const content = serializeFrontmatter(frontmatterRecord, body)
  await atomicWrite(filePath, content)

  try {
    await updateRegistryEntry(omgRoot, nodeId, { archived: true })
  } catch (err) {
    console.error(`[omg] dedup: registry update failed for archive of "${nodeId}":`, err)
  }
}

// ---------------------------------------------------------------------------
// executeMerge
// ---------------------------------------------------------------------------

/**
 * Executes a single merge plan: patches the keeper node and archives losers.
 * Returns an audit entry for the merge.
 */
export async function executeMerge(
  plan: MergePlan,
  filePaths: Map<string, string>,
  omgRoot: string
): Promise<DedupAuditEntry> {
  // Read keeper node
  const keeperPath = filePaths.get(plan.keepNodeId)
  if (keeperPath) {
    try {
      const raw = await fs.readFile(keeperPath, 'utf-8')
      const { frontmatter: rawFm, body } = parseFrontmatter(raw)

      // Build typed frontmatter
      const fm: NodeFrontmatter = rawFm as unknown as NodeFrontmatter
      const { frontmatter: patchedFm, body: patchedBody } = applyPatch(fm, body, plan.patch, plan.aliasKeys)

      // Serialize and write back
      const record: Record<string, unknown> = {
        id: patchedFm.id,
        description: patchedFm.description,
        type: patchedFm.type,
        priority: patchedFm.priority,
        created: patchedFm.created,
        updated: patchedFm.updated,
        ...(patchedFm.uid !== undefined && { uid: patchedFm.uid }),
        ...(patchedFm.canonicalKey !== undefined && { canonicalKey: patchedFm.canonicalKey }),
        ...(patchedFm.aliases !== undefined && { aliases: patchedFm.aliases }),
        ...(patchedFm.links !== undefined && { links: patchedFm.links }),
        ...(patchedFm.tags !== undefined && { tags: patchedFm.tags }),
        ...(patchedFm.archived !== undefined && { archived: patchedFm.archived }),
      }
      await atomicWrite(keeperPath, serializeFrontmatter(record, patchedBody))

      // Update registry
      try {
        await updateRegistryEntry(omgRoot, plan.keepNodeId, {
          description: patchedFm.description,
          updated: patchedFm.updated,
          tags: patchedFm.tags ? [...patchedFm.tags] : undefined,
          links: patchedFm.links ? [...patchedFm.links] : undefined,
        })
      } catch (err) {
        console.error(`[omg] dedup: registry update failed for keeper "${plan.keepNodeId}":`, err)
      }
    } catch (err) {
      console.error(`[omg] dedup: failed to patch keeper "${plan.keepNodeId}":`, err)
    }
  }

  // Archive losers
  for (const loserNodeId of plan.mergeNodeIds) {
    const loserPath = filePaths.get(loserNodeId)
    if (!loserPath) continue
    try {
      await archiveAsMerged(loserPath, loserNodeId, plan.keepNodeId, omgRoot)
    } catch (err) {
      console.error(`[omg] dedup: failed to archive loser "${loserNodeId}":`, err)
    }
  }

  return {
    timestamp: new Date().toISOString(),
    keepNodeId: plan.keepNodeId,
    mergedNodeIds: plan.mergeNodeIds,
    aliasKeys: plan.aliasKeys,
    conflicts: plan.conflicts,
    patch: plan.patch,
  }
}
