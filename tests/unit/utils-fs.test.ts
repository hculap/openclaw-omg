import { vi, describe, it, expect, beforeEach } from 'vitest'
import { vol, fs as memfs } from 'memfs'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

import { isEnoent, atomicWrite } from '../../src/utils/fs.js'

// ---------------------------------------------------------------------------
// isEnoent
// ---------------------------------------------------------------------------

describe('isEnoent', () => {
  it('returns true for an error with code ENOENT', () => {
    const err = Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
    expect(isEnoent(err)).toBe(true)
  })

  it('returns false for an error with a different code (EACCES)', () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    expect(isEnoent(err)).toBe(false)
  })

  it('returns false for an Error with no code property', () => {
    expect(isEnoent(new Error('plain error'))).toBe(false)
  })

  it('returns false for null', () => {
    expect(isEnoent(null)).toBe(false)
  })

  it('returns false for a bare string', () => {
    expect(isEnoent('ENOENT')).toBe(false)
  })

  it('returns false for a plain object without a code property', () => {
    expect(isEnoent({ message: 'ENOENT' })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// atomicWrite
// ---------------------------------------------------------------------------

describe('atomicWrite', () => {
  beforeEach(() => {
    vol.reset()
    vol.fromJSON({ '/target': null }) // ensure directory exists
    vol.fromJSON({ '/target/placeholder': '' })
  })

  it('writes the correct content to the target path', async () => {
    await atomicWrite('/target/file.md', 'hello world')
    expect(memfs.readFileSync('/target/file.md', 'utf-8')).toBe('hello world')
  })

  it('leaves no temp files after a successful write', async () => {
    await atomicWrite('/target/file.md', 'content')
    const entries = memfs.readdirSync('/target') as string[]
    const tmpFiles = entries.filter((e) => e.startsWith('.tmp-'))
    expect(tmpFiles).toHaveLength(0)
  })

  it('throws "Atomic write failed" and leaves no temp files when rename fails', async () => {
    const renameError = Object.assign(new Error('EXDEV: cross-device link'), { code: 'EXDEV' })
    const renameSpy = vi.spyOn(memfs.promises, 'rename').mockRejectedValueOnce(renameError)

    await expect(atomicWrite('/target/file.md', 'content')).rejects.toThrow('Atomic write failed')

    const entries = memfs.readdirSync('/target') as string[]
    const tmpFiles = entries.filter((e) => e.startsWith('.tmp-'))
    expect(tmpFiles).toHaveLength(0)

    renameSpy.mockRestore()
  })

  it('throws "Atomic write failed" when writeFile fails', async () => {
    const writeError = Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' })
    const writeSpy = vi.spyOn(memfs.promises, 'writeFile').mockRejectedValueOnce(writeError)

    await expect(atomicWrite('/target/file.md', 'content')).rejects.toThrow('Atomic write failed')

    writeSpy.mockRestore()
  })

  it('overwrites an existing file', async () => {
    vol.fromJSON({ '/target/file.md': 'old content' })
    await atomicWrite('/target/file.md', 'new content')
    expect(memfs.readFileSync('/target/file.md', 'utf-8')).toBe('new content')
  })
})
