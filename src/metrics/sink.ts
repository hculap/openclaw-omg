/**
 * Metric emission sinks: structured console output and optional JSONL file.
 *
 * `emitMetric` always writes to console.warn with a `[omg:metrics]` prefix.
 * `appendMetricsFile` appends to `{omgRoot}/.metrics.jsonl` when enabled.
 */

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import type { MetricEvent } from './types.js'

/**
 * Emits a metric event to stderr via console.warn.
 * Always runs regardless of config — callers control whether to call this.
 */
export function emitMetric(event: MetricEvent): void {
  console.warn(`[omg:metrics] ${JSON.stringify(event)}`)
}

/**
 * Appends a metric event as a JSONL line to `{omgRoot}/.metrics.jsonl`.
 * Creates the file and parent directories if they don't exist.
 *
 * Never throws — errors are logged and swallowed.
 */
export async function appendMetricsFile(omgRoot: string, event: MetricEvent): Promise<void> {
  const filePath = join(omgRoot, '.metrics.jsonl')
  try {
    await fs.mkdir(dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, JSON.stringify(event) + '\n', 'utf-8')
  } catch (err) {
    console.error(
      `[omg] metrics: failed to append to ${filePath}:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
