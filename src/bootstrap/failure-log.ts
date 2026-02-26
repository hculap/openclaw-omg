/**
 * Append-only JSONL failure log for bootstrap batches: {omgRoot}/.bootstrap-failures.jsonl
 *
 * Follows the same pattern as `dedup/audit.ts` — one JSON object per line,
 * with schema validation on read and graceful skipping of malformed entries.
 */
import { join } from 'node:path'
import { appendFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { readFileOrNull } from '../utils/fs.js'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const FAILURE_ERROR_TYPES = [
  'llm-error',
  'parse-empty',
  'zero-operations',
  'write-all-failed',
] as const

export type FailureErrorType = typeof FAILURE_ERROR_TYPES[number]

const failureDiagnosticsSchema = z.object({
  totalCandidates: z.number().int().min(0),
  accepted: z.number().int().min(0),
  rejectedReasons: z.array(z.string()),
})

const bootstrapFailureEntrySchema = z.object({
  batchIndex: z.number().int().min(0),
  labels: z.array(z.string()),
  errorType: z.enum(FAILURE_ERROR_TYPES),
  error: z.string(),
  timestamp: z.string(),
  diagnostics: failureDiagnosticsSchema.nullable(),
  chunkCount: z.number().int().min(0),
})

export type BootstrapFailureEntry = z.infer<typeof bootstrapFailureEntrySchema>

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const FAILURE_LOG_FILENAME = '.bootstrap-failures.jsonl'

function failurePath(omgRoot: string): string {
  return join(omgRoot, FAILURE_LOG_FILENAME)
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Appends a single failure entry as a JSON line.
 */
export async function appendFailureEntry(
  omgRoot: string,
  entry: BootstrapFailureEntry,
): Promise<void> {
  await appendFile(failurePath(omgRoot), JSON.stringify(entry) + '\n', 'utf-8')
}

/**
 * Reads and parses the failure log, skipping malformed lines.
 * Returns an empty array if the file does not exist.
 */
export async function readFailureLog(
  omgRoot: string,
): Promise<BootstrapFailureEntry[]> {
  const raw = await readFileOrNull(failurePath(omgRoot))
  if (raw === null || raw.trim() === '') return []

  const entries: BootstrapFailureEntry[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (trimmed === '') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      console.warn(
        `[omg] bootstrap: failure log line ${i + 1} is malformed JSON — skipping. Error:`,
        err instanceof Error ? err.message : String(err),
      )
      continue
    }

    const result = bootstrapFailureEntrySchema.safeParse(parsed)
    if (!result.success) {
      console.warn(
        `[omg] bootstrap: failure log line ${i + 1} failed schema validation — skipping. Error:`,
        result.error.message,
      )
      continue
    }

    entries.push(result.data)
  }
  return entries
}

/**
 * Truncates the failure log file.
 * Used at the start of `--force` bootstrap runs.
 */
export async function clearFailureLog(omgRoot: string): Promise<void> {
  await writeFile(failurePath(omgRoot), '', 'utf-8')
}

/**
 * Atomically overwrites the failure log with the given entries.
 * Used by selective retry to preserve entries for batches NOT being retried.
 */
export async function writeFailureEntries(
  omgRoot: string,
  entries: readonly BootstrapFailureEntry[],
): Promise<void> {
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '')
  await writeFile(failurePath(omgRoot), content, 'utf-8')
}
