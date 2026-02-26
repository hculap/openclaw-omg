import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import type { OmgSessionState } from '../types.js'
import { atomicWrite, isEnoent } from '../utils/fs.js'
import { resolveStatePath } from '../utils/paths.js'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns a fresh session state with all fields at their zero/empty defaults. */
export function getDefaultSessionState(): OmgSessionState {
  return {
    lastObservedAtMs: 0,
    pendingMessageTokens: 0,
    totalObservationTokens: 0,
    lastReflectionTotalTokens: 0,
    observationBoundaryMessageIndex: 0,
    nodeCount: 0,
    lastObservationNodeIds: [],
  }
}

/**
 * Loads session state from `.omg-state/{sessionKey}.json`.
 * Returns the default state when the file does not exist or contains invalid JSON.
 */
export async function loadSessionState(
  workspaceDir: string,
  sessionKey: string
): Promise<OmgSessionState> {
  const statePath = resolveStatePath(workspaceDir, sessionKey)
  let raw: string
  try {
    raw = await readFile(statePath, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return getDefaultSessionState()
    throw err
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    return hydrateState(parsed)
  } catch (err) {
    console.error(
      `[omg] loadSessionState: state file at ${statePath} contains invalid JSON — resetting to defaults. ` +
      'This may cause duplicate observation of prior messages.',
      err
    )
    return getDefaultSessionState()
  }
}

/**
 * Atomically persists session state to `.omg-state/{sessionKey}.json`.
 * Creates the directory if it does not exist.
 */
export async function saveSessionState(
  workspaceDir: string,
  sessionKey: string,
  state: OmgSessionState
): Promise<void> {
  const statePath = resolveStatePath(workspaceDir, sessionKey)
  await mkdir(path.dirname(statePath), { recursive: true })
  await atomicWrite(statePath, JSON.stringify(state, null, 2))
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerces a parsed JSON value into a valid OmgSessionState.
 * Falls back gracefully for any missing or invalid fields.
 */
function hydrateState(parsed: unknown): OmgSessionState {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return getDefaultSessionState()
  }
  const obj = parsed as Record<string, unknown>
  return {
    lastObservedAtMs: toNonNegativeNumber(obj['lastObservedAtMs']),
    pendingMessageTokens: toNonNegativeNumber(obj['pendingMessageTokens']),
    totalObservationTokens: toNonNegativeNumber(obj['totalObservationTokens']),
    lastReflectionTotalTokens: toNonNegativeNumber(obj['lastReflectionTotalTokens']),
    observationBoundaryMessageIndex: toNonNegativeNumber(obj['observationBoundaryMessageIndex']),
    nodeCount: toNonNegativeNumber(obj['nodeCount']),
    lastObservationNodeIds: toStringArray(obj['lastObservationNodeIds']),
    ...(Array.isArray(obj['recentSourceFingerprints'])
      ? { recentSourceFingerprints: toFingerprintArray(obj['recentSourceFingerprints']) }
      : {}),
  }
}

function toNonNegativeNumber(v: unknown): number {
  if (typeof v === 'number' && isFinite(v) && v >= 0) return v
  return 0
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  return []
}

function toFingerprintArray(v: unknown): import('../observer/source-fingerprint.js').SourceFingerprint[] {
  if (!Array.isArray(v)) return []
  return v.filter((item): item is import('../observer/source-fingerprint.js').SourceFingerprint => {
    if (item === null || typeof item !== 'object') return false
    const obj = item as Record<string, unknown>
    return (
      Array.isArray(obj['shingleHashes']) &&
      typeof obj['messageCount'] === 'number' &&
      typeof obj['totalChars'] === 'number' &&
      typeof obj['timestamp'] === 'string'
    )
  })
}
