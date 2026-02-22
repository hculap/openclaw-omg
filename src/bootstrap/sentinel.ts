/**
 * sentinel.ts — Bootstrap completion sentinel file management.
 *
 * The sentinel file (`{omgRoot}/.bootstrap-done`) records that bootstrap
 * has been completed for a workspace, preventing re-ingestion on subsequent
 * gateway starts.
 */

import path from 'node:path'
import { atomicWrite, readFileOrNull } from '../utils/fs.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Content stored in the sentinel file. */
export interface SentinelData {
  /** ISO 8601 timestamp when bootstrap completed. */
  readonly completedAt: string
  /** Total number of chunks attempted. */
  readonly chunksProcessed: number
  /** Number of chunks that succeeded. */
  readonly chunksSucceeded: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the absolute path to the sentinel file. */
function sentinelPath(omgRoot: string): string {
  return path.join(omgRoot, '.bootstrap-done')
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads the sentinel file and returns its parsed content, or null if the
 * file does not exist or cannot be parsed.
 *
 * Never throws — parse failures are treated as "no sentinel".
 */
export async function readSentinel(omgRoot: string): Promise<SentinelData | null> {
  const raw = await readFileOrNull(sentinelPath(omgRoot))
  if (raw === null) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>)['completedAt'] === 'string' &&
      typeof (parsed as Record<string, unknown>)['chunksProcessed'] === 'number' &&
      typeof (parsed as Record<string, unknown>)['chunksSucceeded'] === 'number'
    ) {
      return parsed as SentinelData
    }
    return null
  } catch {
    return null
  }
}

/**
 * Writes the sentinel file atomically.
 *
 * If the write fails, logs the error and returns false so the caller can
 * accept re-run on the next gateway start (minor duplication is acceptable).
 *
 * Returns true on success, false on failure.
 */
export async function writeSentinel(
  omgRoot: string,
  data: SentinelData
): Promise<boolean> {
  try {
    const content = JSON.stringify(data, null, 2)
    await atomicWrite(sentinelPath(omgRoot), content)
    return true
  } catch (err) {
    console.error(
      '[omg] bootstrap: failed to write sentinel — bootstrap will re-run on next gateway start:',
      err
    )
    return false
  }
}
