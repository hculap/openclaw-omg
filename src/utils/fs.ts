import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Returns true if err is a Node.js filesystem error with code ENOENT.
 */
export function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

/**
 * Reads a file as UTF-8 text, returning null if the file does not exist.
 * Rethrows any error that is not ENOENT.
 */
export async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
}

/**
 * Writes content to a temporary file in the same directory as filePath,
 * then atomically renames it to filePath. Prevents partial writes from
 * being observed by readers.
 *
 * The caller is responsible for ensuring the target directory exists.
 *
 * @throws If the write or rename fails.
 */
export async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath)
  const tmpName = `.tmp-${randomBytes(6).toString('hex')}`
  const tmpPath = join(dir, tmpName)

  try {
    await fs.writeFile(tmpPath, content, 'utf-8')
    await fs.rename(tmpPath, filePath)
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => {
      // Ignore cleanup errors — the primary error is already being propagated.
    })
    throw new Error(
      `Atomic write failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}
