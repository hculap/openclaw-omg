/**
 * Append-only JSONL audit log for dedup merges: {omgRoot}/.dedup-audit.jsonl
 */
import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { readFileOrNull } from '../utils/fs.js'
import type { DedupAuditEntry } from './types.js'

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
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as DedupAuditEntry
      entries.push(parsed)
    } catch {
      // Skip malformed lines
    }
  }
  return entries
}
