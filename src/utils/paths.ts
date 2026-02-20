import path from 'node:path'
import type { OmgConfig } from '../config.js'
import type { NodeType } from '../types.js'

/**
 * Resolves the absolute root directory for OMG graph files.
 *
 * @param workspaceDir - Absolute path to the workspace root.
 * @param config - The parsed OMG configuration.
 * @returns The absolute path to the OMG storage root, e.g. `/workspace/memory/omg`.
 */
export function resolveOmgRoot(workspaceDir: string, config: OmgConfig): string {
  return path.join(workspaceDir, config.storagePath)
}

/**
 * Resolves the absolute path for a specific knowledge node file.
 *
 * @param omgRoot - Absolute path to the OMG storage root.
 * @param type - The node type determining the subdirectory.
 * @param filename - The filename of the node (including extension, e.g. `node.md`).
 *   Must not contain path separators (`/`, `\`) or traversal sequences (`..`).
 * @returns The absolute path to the node file, e.g. `/root/nodes/identity/node.md`.
 * @throws If filename contains path separators or traversal sequences.
 */
export function resolveNodePath(omgRoot: string, type: NodeType, filename: string): string {
  if (/[/\\]/.test(filename) || filename.includes('..')) {
    throw new Error(
      `Invalid filename — must not contain path separators or '..': ${filename}`
    )
  }
  return path.join(omgRoot, 'nodes', type, filename)
}

/**
 * Resolves the absolute path for a Map of Content (MOC) file.
 *
 * @param omgRoot - Absolute path to the OMG storage root.
 * @param domain - The domain name for this MOC (e.g. `identity`, `preferences`).
 * @returns The absolute path to the MOC file, e.g. `/root/mocs/moc-identity.md`.
 */
export function resolveMocPath(omgRoot: string, domain: string): string {
  if (/[/\\]/.test(domain) || domain.includes('..')) {
    throw new Error(
      `Invalid domain — must not contain path separators or '..': ${domain}`
    )
  }
  return path.join(omgRoot, 'mocs', `moc-${domain}.md`)
}

/**
 * Resolves the absolute path for a session state file.
 *
 * @param workspaceDir - Absolute path to the workspace root.
 * @param sessionKey - The unique key identifying this session. Must not contain
 *   path separators (`/`, `\`) or traversal sequences (`..`).
 * @returns The absolute path to the state file, e.g. `/workspace/.omg-state/session-abc.json`.
 * @throws If sessionKey contains path separators or traversal sequences.
 */
export function resolveStatePath(workspaceDir: string, sessionKey: string): string {
  if (/[/\\]/.test(sessionKey) || sessionKey.includes('..')) {
    throw new Error(
      `Invalid sessionKey — must not contain path separators or '..': ${sessionKey}`
    )
  }
  return path.join(workspaceDir, '.omg-state', `${sessionKey}.json`)
}
