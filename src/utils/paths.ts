import type { OmgConfig } from '../config.js'
import type { NodeType } from '../types.js'

/**
 * Minimal POSIX-style path joiner for use without @types/node.
 * Joins segments with '/' and normalises repeated or trailing slashes,
 * preserving a leading slash on the first segment.
 */
function joinPath(...segments: string[]): string {
  const joined = segments.join('/')
  // Normalise repeated slashes (but preserve a leading double-slash if intentional)
  const normalised = joined.replace(/\/{2,}/g, '/')
  // Remove trailing slash unless the result is just '/'
  return normalised.endsWith('/') && normalised.length > 1
    ? normalised.slice(0, -1)
    : normalised
}

/**
 * Resolves the absolute root directory for OMG graph files.
 *
 * @param workspaceDir - Absolute path to the workspace root.
 * @param config - The parsed OMG configuration.
 * @returns The absolute path to the OMG storage root, e.g. `/workspace/memory/omg`.
 */
export function resolveOmgRoot(workspaceDir: string, config: OmgConfig): string {
  return joinPath(workspaceDir, config.storagePath)
}

/**
 * Resolves the absolute path for a specific knowledge node file.
 *
 * @param omgRoot - Absolute path to the OMG storage root.
 * @param type - The node type determining the subdirectory.
 * @param filename - The filename of the node (including extension, e.g. `node.md`).
 * @returns The absolute path to the node file, e.g. `/root/nodes/identity/node.md`.
 */
export function resolveNodePath(omgRoot: string, type: NodeType, filename: string): string {
  return joinPath(omgRoot, 'nodes', type, filename)
}

/**
 * Resolves the absolute path for a Map of Content (MOC) file.
 *
 * @param omgRoot - Absolute path to the OMG storage root.
 * @param domain - The domain name for this MOC (e.g. `identity`, `preferences`).
 * @returns The absolute path to the MOC file, e.g. `/root/mocs/moc-identity.md`.
 */
export function resolveMocPath(omgRoot: string, domain: string): string {
  return joinPath(omgRoot, 'mocs', `moc-${domain}.md`)
}

/**
 * Resolves the absolute path for a session state file.
 *
 * @param workspaceDir - Absolute path to the workspace root.
 * @param sessionKey - The unique key identifying this session.
 * @returns The absolute path to the state file, e.g. `/workspace/.omg-state/session-abc.json`.
 */
export function resolveStatePath(workspaceDir: string, sessionKey: string): string {
  return joinPath(workspaceDir, '.omg-state', `${sessionKey}.json`)
}
