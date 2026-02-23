/**
 * lock.ts — Atomic OS-level bootstrap lease lock.
 *
 * Provides a `.bootstrap-lock` file created via O_EXCL | O_CREAT (`flag: 'wx'`),
 * which is atomic on POSIX filesystems. This is the first layer of concurrency
 * protection, sitting below the state machine:
 *
 *   Layer 1 — Lock  (.bootstrap-lock)      — "is a process running RIGHT NOW?"
 *   Layer 2 — State (.bootstrap-state.json) — "what progress was made?"
 *
 * The lock records the owning PID, a unique acquisition token (UUID), and a
 * heartbeat timestamp (`updatedAt`) that the owner refreshes on each batch.
 * Staleness is evaluated against `updatedAt` (not `startedAt`) so a long-running
 * process isn't falsely evicted.
 *
 * Token-based ownership: `acquireLock` writes a UUID and stores it in
 * `activeClaims`. `releaseLock` and `refreshLock` verify both PID and token
 * before modifying the file, closing the read-check-write TOCTOU window.
 */

import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'
import { atomicWrite } from '../utils/fs.js'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_FILENAME = '.bootstrap-lock'
/** TTL matches the state machine's STALE_THRESHOLD_MS. */
const LOCK_TTL_MS = 5 * 60 * 1000 // 5 min

// ---------------------------------------------------------------------------
// Claim registry (module-level, per process lifetime)
// ---------------------------------------------------------------------------

/** Maps omgRoot → UUID token written to disk when this process acquired the lock. */
const activeClaims = new Map<string, string>()

/**
 * Clears all active claims.
 * @internal — only for use in tests.
 */
export function _clearActiveClaims(): void {
  activeClaims.clear()
}

// ---------------------------------------------------------------------------
// Schema & types
// ---------------------------------------------------------------------------

const lockContentSchema = z
  .object({
    pid: z.number().int().positive(),
    token: z.string().uuid(),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .refine((data) => data.startedAt <= data.updatedAt, {
    message: 'updatedAt must be >= startedAt',
  })

type LockContent = z.infer<typeof lockContentSchema>

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Returns true when the lock's `updatedAt` is older than {@link LOCK_TTL_MS}.
 */
export function isLockStale(lock: LockContent): boolean {
  const age = Date.now() - new Date(lock.updatedAt).getTime()
  return age > LOCK_TTL_MS
}

/**
 * Checks whether the process `pid` is still alive.
 *
 * Uses `process.kill(pid, 0)` which sends no signal but validates the PID.
 *
 * | Result    | Condition                           |
 * |-----------|-------------------------------------|
 * | `alive`   | kill(0) succeeded (POSIX: no ESRCH) |
 * | `dead`    | ESRCH — no such process             |
 * | `unknown` | EPERM or other OS error             |
 */
export function checkPidStatus(pid: number): 'alive' | 'dead' | 'unknown' {
  try {
    process.kill(pid, 0)
    return 'alive'
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'dead'
    return 'unknown'
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function lockPath(omgRoot: string): string {
  return path.join(omgRoot, LOCK_FILENAME)
}

/**
 * Reads and parses the lock file.
 * Returns null if the file is missing or corrupt.
 * Logs unexpected I/O errors (e.g. EACCES, EMFILE) to aid debugging.
 */
async function readLock(omgRoot: string): Promise<LockContent | null> {
  let raw: string
  try {
    raw = await fs.readFile(lockPath(omgRoot), 'utf-8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.error('[omg] lock: failed to read lock file:', err)
    }
    return null
  }
  try {
    return lockContentSchema.parse(JSON.parse(raw))
  } catch {
    // Corrupt content — caller handles via the corrupt-lock recovery path
    return null
  }
}

/**
 * Evaluates staleness for a lock already confirmed to exist.
 *
 * | PID status | Timestamp | Lock is... |
 * |------------|-----------|------------|
 * | alive      | any       | Valid      |
 * | dead       | any       | Stale      |
 * | unknown    | fresh     | Valid      |
 * | unknown    | stale     | Stale      |
 */
function shouldStealLock(lock: LockContent): boolean {
  const status = checkPidStatus(lock.pid)
  if (status === 'alive') return false
  if (status === 'dead') return true
  // unknown — fall back to timestamp
  return isLockStale(lock)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempts to atomically acquire the bootstrap lock for `omgRoot`.
 *
 * Returns `true` when this process now owns the lock.
 * Returns `false` when another live process holds it.
 *
 * Acquire flow:
 *   1. `writeFile(lockPath, content, { flag: 'wx' })` → success → true
 *   2. EEXIST → readLock() → null (corrupt) → unlink + retry once
 *   3. EEXIST → readLock() → valid & not stale → false
 *   4. EEXIST → readLock() → stale → unlink + retry once
 *   5. Unexpected error → log + return true (don't block bootstrap permanently)
 */
export async function acquireLock(omgRoot: string): Promise<boolean> {
  const filePath = lockPath(omgRoot)
  const now = new Date().toISOString()
  const token = randomUUID()
  const content: LockContent = {
    pid: process.pid,
    token,
    startedAt: now,
    updatedAt: now,
  }
  const serialised = JSON.stringify(content, null, 2)

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(filePath, serialised, { flag: 'wx', encoding: 'utf-8' })
      activeClaims.set(omgRoot, token)
      return true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code

      if (code !== 'EEXIST') {
        // Unexpected error — log and allow bootstrap to proceed so it isn't
        // permanently blocked by a permissions or IO issue.
        console.error('[omg] lock: unexpected error acquiring lock — proceeding anyway:', err)
        return true
      }

      // EEXIST — inspect the existing lock
      const existing = await readLock(omgRoot)

      if (existing === null) {
        // Corrupt lock file — delete it and retry
        console.error('[omg] lock: corrupt lock file detected — removing and retrying')
        await fs.unlink(filePath).catch(() => {})
        continue
      }

      if (!shouldStealLock(existing)) {
        console.error(`[omg] lock: lock held by PID ${existing.pid} (started ${existing.startedAt}) — skipping bootstrap`)
        return false
      }

      // Stale lock — steal it
      console.error(`[omg] lock: stealing stale lock from PID ${existing.pid} (last heartbeat ${existing.updatedAt})`)
      await fs.unlink(filePath).catch(() => {})
      // retry
    }
  }

  // Both attempts exhausted — something kept recreating the file.
  // Fail-open to avoid permanently blocking bootstrap.
  console.error('[omg] lock: could not acquire lock after 2 attempts — proceeding anyway')
  return true
}

/**
 * Releases the lock if and only if it is owned by this process.
 * Verifies both PID and the acquisition token to close the read-check-unlink
 * TOCTOU window.
 * Best-effort — never throws.
 */
export async function releaseLock(omgRoot: string): Promise<void> {
  try {
    const ownToken = activeClaims.get(omgRoot)
    if (ownToken === undefined) return
    const existing = await readLock(omgRoot)
    if (existing === null || existing.pid !== process.pid || existing.token !== ownToken) return
    await fs.unlink(lockPath(omgRoot))
    activeClaims.delete(omgRoot)
  } catch {
    // Best-effort — ignore all errors on release
  }
}

/**
 * Refreshes `updatedAt` in the lock file (heartbeat).
 * Only updates if the lock is still owned by this process.
 * Verifies both PID and the acquisition token to close the read-check-write
 * TOCTOU window.
 * Best-effort — never throws.
 */
export async function refreshLock(omgRoot: string): Promise<void> {
  try {
    const ownToken = activeClaims.get(omgRoot)
    if (ownToken === undefined) return
    const existing = await readLock(omgRoot)
    if (existing === null || existing.pid !== process.pid || existing.token !== ownToken) return
    const updated: LockContent = {
      ...existing,
      updatedAt: new Date().toISOString(),
    }
    await atomicWrite(lockPath(omgRoot), JSON.stringify(updated, null, 2))
  } catch {
    // Best-effort — ignore all errors on refresh
  }
}
