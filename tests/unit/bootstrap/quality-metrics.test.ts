import { describe, it, expect, vi } from 'vitest'
import {
  computeBootstrapQuality,
  logQualityReport,
} from '../../../src/bootstrap/quality-metrics.js'
import type { RegistryNodeEntry } from '../../../src/graph/registry.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(type: string, archived = false): RegistryNodeEntry {
  return {
    type: type as RegistryNodeEntry['type'],
    kind: 'observation',
    description: `test ${type} node`,
    priority: 'medium',
    created: '2024-01-01T00:00:00Z',
    updated: '2024-01-01T00:00:00Z',
    filePath: `/workspace/memory/omg/nodes/${type}/test.md`,
    archived,
  }
}

function makeEntries(types: string[]): (readonly [string, RegistryNodeEntry])[] {
  return types.map((type, i) => [`omg/${type}/node-${i}`, makeEntry(type)] as const)
}

// ---------------------------------------------------------------------------
// computeBootstrapQuality
// ---------------------------------------------------------------------------

describe('computeBootstrapQuality', () => {
  it('returns no warnings when identity and preference nodes are present', () => {
    const entries = makeEntries([
      'identity', 'identity', 'identity',
      'preference', 'preference',
      'fact', 'fact', 'fact', 'fact', 'fact',
    ])
    const report = computeBootstrapQuality(entries)
    expect(report.totalNodes).toBe(10)
    expect(report.typeCounts['identity']).toBe(3)
    expect(report.typeCounts['preference']).toBe(2)
    expect(report.warnings).toHaveLength(0)
  })

  it('warns when 0 identity nodes', () => {
    const entries = makeEntries(['preference', 'fact', 'fact', 'fact'])
    const report = computeBootstrapQuality(entries)
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('0 identity nodes'),
      ]),
    )
  })

  it('warns when 0 preference nodes', () => {
    const entries = makeEntries(['identity', 'fact', 'fact', 'fact'])
    const report = computeBootstrapQuality(entries)
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('0 preference nodes'),
      ]),
    )
  })

  it('warns when identity + preference < 5% of total', () => {
    // 1 identity + 0 preference out of 100 = 1%
    const types = ['identity', ...Array(99).fill('fact')]
    const entries = makeEntries(types)
    const report = computeBootstrapQuality(entries)
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('only 1.0%'),
      ]),
    )
  })

  it('excludes archived nodes from counts', () => {
    const entries: (readonly [string, RegistryNodeEntry])[] = [
      ['omg/identity/a', makeEntry('identity', true)] as const,
      ['omg/fact/b', makeEntry('fact')] as const,
    ]
    const report = computeBootstrapQuality(entries)
    expect(report.totalNodes).toBe(1)
    expect(report.typeCounts['identity']).toBeUndefined()
    expect(report.typeCounts['fact']).toBe(1)
  })

  it('returns no warnings for empty graph', () => {
    const report = computeBootstrapQuality([])
    expect(report.totalNodes).toBe(0)
    expect(report.warnings).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// logQualityReport
// ---------------------------------------------------------------------------

describe('logQualityReport', () => {
  it('logs type distribution', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const report = computeBootstrapQuality(
      makeEntries(['identity', 'preference', 'fact']),
    )
    logQualityReport(report)

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('3 nodes'),
    )

    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('logs warnings at warn level', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const report = computeBootstrapQuality(
      makeEntries(['fact', 'fact', 'fact']),
    )
    logQualityReport(report)

    expect(warnSpy).toHaveBeenCalled()

    logSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
