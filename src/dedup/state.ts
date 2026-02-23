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
  } catch {
    return getDefaultDedupState()
  }

  const result = dedupStateSchema.safeParse(parsed)
  if (!result.success) return getDefaultDedupState()

  return result.data as DedupState
}

/**
 * Atomically persists dedup state to disk.
 */
export async function saveDedupState(omgRoot: string, state: DedupState): Promise<void> {
  await mkdir(omgRoot, { recursive: true })
  await atomicWrite(statePath(omgRoot), JSON.stringify(state, null, 2))
}
