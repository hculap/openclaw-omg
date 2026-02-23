import { describe, it, expect, vi, beforeEach } from 'vitest'
import { vol } from 'memfs'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

import {
  acquireLock,
  releaseLock,
  refreshLock,
  isLockStale,
  checkPidStatus,
} from '../../../src/bootstrap/lock.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OMG_ROOT = '/workspace/memory/omg'
const LOCK_PATH = `${OMG_ROOT}/.bootstrap-lock`

function makeLockContent(overrides: { pid?: number; startedAt?: string; updatedAt?: string } = {}) {
  const now = new Date().toISOString()
  return {
    pid: process.pid,
    startedAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function staleTimestamp(): string {
  return new Date(Date.now() - 10 * 60 * 1000).toISOString()
}

function writeLock(content: object) {
  vol.fromJSON({ [LOCK_PATH]: JSON.stringify(content, null, 2) })
}

beforeEach(() => {
  vol.reset()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Test 1: Empty dir → acquires → returns true, creates lock file with correct fields
// ---------------------------------------------------------------------------

describe('acquireLock', () => {
  it('acquires when no lock exists — returns true and creates lock file', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/.keep`]: '' })

    const result = await acquireLock(OMG_ROOT)
    expect(result).toBe(true)
    expect(vol.existsSync(LOCK_PATH)).toBe(true)

    const raw = vol.readFileSync(LOCK_PATH, 'utf-8') as string
    const parsed = JSON.parse(raw)
    expect(parsed.pid).toBe(process.pid)
    expect(typeof parsed.startedAt).toBe('string')
    expect(typeof parsed.updatedAt).toBe('string')
  })

  // Test 2: Fresh lock, PID alive → returns false
  it('returns false when a fresh lock with an alive PID exists', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never)
    writeLock(makeLockContent({ pid: 99999 }))

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await acquireLock(OMG_ROOT)
    expect(result).toBe(false)
    killSpy.mockRestore()
    consoleSpy.mockRestore()
  })

  // Test 3: Fresh lock, PID dead (ESRCH) → steals → returns true
  it('steals lock and returns true when PID is dead (ESRCH)', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('ESRCH')
      err.code = 'ESRCH'
      throw err
    })
    writeLock(makeLockContent({ pid: 99999 }))

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await acquireLock(OMG_ROOT)
    expect(result).toBe(true)
    // Lock file should now belong to current process
    const raw = vol.readFileSync(LOCK_PATH, 'utf-8') as string
    expect(JSON.parse(raw).pid).toBe(process.pid)
    killSpy.mockRestore()
    consoleSpy.mockRestore()
  })

  // Test 4: Fresh lock, PID unknown (EPERM) → returns false (fresh timestamp, fall back to TTL)
  it('returns false when PID unknown (EPERM) and lock is fresh', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('EPERM')
      err.code = 'EPERM'
      throw err
    })
    writeLock(makeLockContent({ pid: 99999 }))

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await acquireLock(OMG_ROOT)
    expect(result).toBe(false)
    killSpy.mockRestore()
    consoleSpy.mockRestore()
  })

  // Test 5: Stale lock (old updatedAt), PID unknown → steals → returns true
  it('steals stale lock when PID unknown (EPERM) but timestamp is old', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('EPERM')
      err.code = 'EPERM'
      throw err
    })
    writeLock(makeLockContent({ pid: 99999, updatedAt: staleTimestamp() }))

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await acquireLock(OMG_ROOT)
    expect(result).toBe(true)
    const raw = vol.readFileSync(LOCK_PATH, 'utf-8') as string
    expect(JSON.parse(raw).pid).toBe(process.pid)
    killSpy.mockRestore()
    consoleSpy.mockRestore()
  })

  // Test 6: Alive PID + stale timestamp → returns false (alive wins)
  it('returns false when PID is alive even if timestamp is stale', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never)
    writeLock(makeLockContent({ pid: 99999, updatedAt: staleTimestamp() }))

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await acquireLock(OMG_ROOT)
    expect(result).toBe(false)
    killSpy.mockRestore()
    consoleSpy.mockRestore()
  })

  // Test 7: Corrupt lock file (EEXIST but unreadable) → steals → returns true
  it('steals corrupt lock file and returns true', async () => {
    vol.fromJSON({ [LOCK_PATH]: '{not valid json' })

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await acquireLock(OMG_ROOT)
    expect(result).toBe(true)
    const raw = vol.readFileSync(LOCK_PATH, 'utf-8') as string
    expect(JSON.parse(raw).pid).toBe(process.pid)
    consoleSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// releaseLock
// ---------------------------------------------------------------------------

describe('releaseLock', () => {
  // Test 8: releaseLock deletes own lock
  it('deletes the lock when owned by this process', async () => {
    writeLock(makeLockContent())
    await releaseLock(OMG_ROOT)
    expect(vol.existsSync(LOCK_PATH)).toBe(false)
  })

  // Test 9: releaseLock does not delete another process's lock
  it('does not delete lock owned by a different PID', async () => {
    writeLock(makeLockContent({ pid: 99999 }))
    await releaseLock(OMG_ROOT)
    expect(vol.existsSync(LOCK_PATH)).toBe(true)
  })

  // Test 10: releaseLock on missing file → no throw
  it('does not throw when lock file does not exist', async () => {
    vol.fromJSON({})
    await expect(releaseLock(OMG_ROOT)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// refreshLock
// ---------------------------------------------------------------------------

describe('refreshLock', () => {
  // Test 11: refreshLock updates updatedAt, preserves pid and startedAt
  it('updates updatedAt while preserving pid and startedAt', async () => {
    vol.fromJSON({ [`${OMG_ROOT}/.keep`]: '' })
    const startedAt = new Date(Date.now() - 60_000).toISOString()
    const original = makeLockContent({ startedAt, updatedAt: startedAt })
    writeLock(original)

    const before = Date.now()
    await refreshLock(OMG_ROOT)
    const after = Date.now()

    const raw = vol.readFileSync(LOCK_PATH, 'utf-8') as string
    const updated = JSON.parse(raw)
    expect(updated.pid).toBe(process.pid)
    expect(updated.startedAt).toBe(startedAt)
    const updatedTime = new Date(updated.updatedAt).getTime()
    expect(updatedTime).toBeGreaterThanOrEqual(before)
    expect(updatedTime).toBeLessThanOrEqual(after)
  })

  // Test 12: refreshLock on another process's lock → no-op
  it('does not modify lock owned by a different PID', async () => {
    const originalContent = makeLockContent({ pid: 99999, updatedAt: staleTimestamp() })
    writeLock(originalContent)
    const originalRaw = vol.readFileSync(LOCK_PATH, 'utf-8') as string

    await refreshLock(OMG_ROOT)

    const raw = vol.readFileSync(LOCK_PATH, 'utf-8') as string
    expect(raw).toBe(originalRaw)
  })
})

// ---------------------------------------------------------------------------
// isLockStale (pure unit tests)
// ---------------------------------------------------------------------------

describe('isLockStale', () => {
  // Test 13: all combinations
  it('returns false for a fresh lock', () => {
    const lock = makeLockContent()
    expect(isLockStale(lock)).toBe(false)
  })

  it('returns true for a lock with updatedAt older than 5 minutes', () => {
    const lock = makeLockContent({ updatedAt: staleTimestamp() })
    expect(isLockStale(lock)).toBe(true)
  })

  it('returns false when updatedAt is exactly at the TTL boundary', () => {
    // just under 5 min ago
    const ts = new Date(Date.now() - 4 * 60 * 1000 - 59_000).toISOString()
    const lock = makeLockContent({ updatedAt: ts })
    expect(isLockStale(lock)).toBe(false)
  })

  it('returns true when updatedAt is just over the TTL boundary', () => {
    const ts = new Date(Date.now() - 5 * 60 * 1000 - 1_000).toISOString()
    const lock = makeLockContent({ updatedAt: ts })
    expect(isLockStale(lock)).toBe(true)
  })

  it('is not affected by startedAt — only updatedAt matters', () => {
    const lock = makeLockContent({
      startedAt: staleTimestamp(), // old startedAt
      updatedAt: new Date().toISOString(), // fresh heartbeat
    })
    expect(isLockStale(lock)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// checkPidStatus (unit tests using process.kill spy)
// ---------------------------------------------------------------------------

describe('checkPidStatus', () => {
  it('returns "alive" when kill(pid, 0) succeeds', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true as never)
    expect(checkPidStatus(12345)).toBe('alive')
    killSpy.mockRestore()
  })

  it('returns "dead" when ESRCH is thrown', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('ESRCH')
      err.code = 'ESRCH'
      throw err
    })
    expect(checkPidStatus(12345)).toBe('dead')
    killSpy.mockRestore()
  })

  it('returns "unknown" when EPERM is thrown', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err: NodeJS.ErrnoException = new Error('EPERM')
      err.code = 'EPERM'
      throw err
    })
    expect(checkPidStatus(12345)).toBe('unknown')
    killSpy.mockRestore()
  })
})
