/**
 * quality-metrics.ts — Post-bootstrap type distribution analysis.
 *
 * Computes and logs warnings when the bootstrap output lacks expected
 * node types (identity, preference) that indicate successful personal
 * data extraction.
 */
import type { RegistryNodeEntry } from '../graph/registry.js'
import type { NodeType } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BootstrapQualityReport {
  readonly totalNodes: number
  readonly typeCounts: Readonly<Record<string, number>>
  readonly warnings: readonly string[]
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const IDENTITY_PREFERENCE_MIN_PERCENT = 5

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Computes bootstrap quality metrics from the registry entries.
 *
 * Warns when:
 *   - 0 identity nodes
 *   - 0 preference nodes
 *   - identity + preference < 5% of total nodes
 */
export function computeBootstrapQuality(
  entries: readonly (readonly [string, RegistryNodeEntry])[],
): BootstrapQualityReport {
  const typeCounts: Record<string, number> = {}
  for (const [, entry] of entries) {
    if (entry.archived) continue
    const t = entry.type as string
    typeCounts[t] = (typeCounts[t] ?? 0) + 1
  }

  const totalNodes = Object.values(typeCounts).reduce((sum, n) => sum + n, 0)
  const identityCount = typeCounts['identity'] ?? 0
  const preferenceCount = typeCounts['preference'] ?? 0

  const warnings: string[] = []

  if (totalNodes > 0 && identityCount === 0) {
    warnings.push(
      'Bootstrap produced 0 identity nodes — personal data may not have been extracted. ' +
      'Check source databases for identity-related content.',
    )
  }

  if (totalNodes > 0 && preferenceCount === 0) {
    warnings.push(
      'Bootstrap produced 0 preference nodes — user preferences may not have been extracted.',
    )
  }

  if (totalNodes > 0 && identityCount + preferenceCount > 0) {
    const percent = ((identityCount + preferenceCount) / totalNodes) * 100
    if (percent < IDENTITY_PREFERENCE_MIN_PERCENT) {
      warnings.push(
        `Identity + preference nodes are only ${percent.toFixed(1)}% of total (${identityCount + preferenceCount}/${totalNodes}). ` +
        `Expected at least ${IDENTITY_PREFERENCE_MIN_PERCENT}%. Review .bootstrap-failures.jsonl for parse issues.`,
      )
    }
  }

  return { totalNodes, typeCounts, warnings }
}

/**
 * Logs the quality report to the console.
 * Warnings are emitted at `console.warn` level.
 */
export function logQualityReport(report: BootstrapQualityReport): void {
  const typeStr = Object.entries(report.typeCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => `${type}=${count}`)
    .join(', ')

  console.log(
    `[omg] bootstrap quality: ${report.totalNodes} nodes — ${typeStr || '(none)'}`,
  )

  for (const warning of report.warnings) {
    console.warn(`[omg] bootstrap quality: ${warning}`)
  }
}
