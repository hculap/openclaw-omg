/**
 * Append-only JSONL audit log for dedup merges: {omgRoot}/.dedup-audit.jsonl
 */
import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { readFileOrNull } from '../utils/fs.js'
import { type DedupAuditEntry, dedupAuditEntrySchema } from './types.js'

function auditPath(omgRoot: string): string {
  return join(omgRoot, '.dedup-audit.jsonl')
}

/**
 * Appends a single audit entry as a JSON line.
 */
export async function appendAuditEntry(omgRoot: string, entry: DedupAuditEntry): Promise<void> {
  await appendFile(auditPath(omgRoot), JSON.stringify(entry) + '\n', 'utf-8')
}

/**
 * Reads and parses the audit log, skipping malformed lines.
 * Returns an empty array if the file does not exist.
 */
export async function readAuditLog(omgRoot: string): Promise<DedupAuditEntry[]> {
  const raw = await readFileOrNull(auditPath(omgRoot))
  if (raw === null || raw.trim() === '') return []

  const entries: DedupAuditEntry[] = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim()
    if (trimmed === '') continue

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      console.warn(
        `[omg] dedup: audit log line ${i + 1} is malformed JSON — skipping. Error:`,
        err instanceof Error ? err.message : String(err)
      )
      continue
    }

    const result = dedupAuditEntrySchema.safeParse(parsed)
    if (!result.success) {
      console.warn(
        `[omg] dedup: audit log line ${i + 1} failed schema validation — skipping. Error:`,
        result.error.message
      )
      continue
    }

    entries.push(result.data)
  }
  return entries
}
