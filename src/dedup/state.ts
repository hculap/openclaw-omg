/**
 * Persists dedup state to {omgRoot}/.dedup-state.json.
 */
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { atomicWrite, readFileOrNull } from '../utils/fs.js'
import { type DedupState, dedupStateSchema, getDefaultDedupState } from './types.js'

function statePath(omgRoot: string): string {
  return join(omgRoot, '.dedup-state.json')
}

/**
 * Loads dedup state from disk. Returns defaults on missing file,
 * invalid JSON, or schema validation failure.
 */
export async function loadDedupState(omgRoot: string): Promise<DedupState> {
  const raw = await readFileOrNull(statePath(omgRoot))
  if (raw === null) return getDefaultDedupState()

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn(
      '[omg] dedup: state file contains invalid JSON — resetting to defaults. Error:',
      err instanceof Error ? err.message : String(err)
    )
    return getDefaultDedupState()
  }

  const result = dedupStateSchema.safeParse(parsed)
  if (!result.success) {
    console.warn(
      '[omg] dedup: state file failed schema validation — resetting to defaults. This will trigger a full graph rescan.',
      result.error.message
    )
    return getDefaultDedupState()
  }

  return result.data as DedupState
}

/**
 * Atomically persists dedup state to disk.
 */
export async function saveDedupState(omgRoot: string, state: DedupState): Promise<void> {
  await mkdir(omgRoot, { recursive: true })
  await atomicWrite(statePath(omgRoot), JSON.stringify(state, null, 2))
}
