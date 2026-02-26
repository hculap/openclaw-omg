import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { vol } from 'memfs'
import type { MetricEvent } from '../../../src/metrics/types.js'

vi.mock('node:fs', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs, ...m.fs }
})
vi.mock('node:fs/promises', async () => {
  const m = await vi.importActual<typeof import('memfs')>('memfs')
  return { default: m.fs.promises, ...m.fs.promises }
})

const { emitMetric, appendMetricsFile } = await import('../../../src/metrics/sink.js')

const OMG_ROOT = '/workspace/memory/omg'

function makeEvent(stage = 'extract'): MetricEvent {
  return {
    stage,
    timestamp: '2026-01-01T00:00:00Z',
    data: {
      stage: 'extract',
      candidatesCount: 5,
      parserRejectCount: 1,
      parserRejectReasons: ['missing canonicalKey'],
      writtenNodesCount: 4,
    },
  }
}

describe('emitMetric', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('writes structured JSON to console.warn with [omg:metrics] prefix', () => {
    const event = makeEvent()
    emitMetric(event)

    expect(warnSpy).toHaveBeenCalledOnce()
    const output = warnSpy.mock.calls[0]![0] as string
    expect(output).toContain('[omg:metrics]')
    expect(output).toContain('"stage":"extract"')
    expect(output).toContain('"candidatesCount":5')
  })
})

describe('appendMetricsFile', () => {
  beforeEach(() => {
    vol.reset()
    vol.fromJSON({ [`${OMG_ROOT}/.keep`]: '' })
  })

  it('creates .metrics.jsonl and appends a line', async () => {
    const event = makeEvent()
    await appendMetricsFile(OMG_ROOT, event)

    const content = vol.readFileSync(`${OMG_ROOT}/.metrics.jsonl`, 'utf-8') as string
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!)
    expect(parsed.stage).toBe('extract')
    expect(parsed.data.candidatesCount).toBe(5)
  })

  it('appends multiple events', async () => {
    await appendMetricsFile(OMG_ROOT, makeEvent('extract'))
    await appendMetricsFile(OMG_ROOT, makeEvent('reflection'))

    const content = vol.readFileSync(`${OMG_ROOT}/.metrics.jsonl`, 'utf-8') as string
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('does not throw on filesystem error', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Write to a path that doesn't exist and can't be created
    await expect(appendMetricsFile('/nonexistent/readonly/path', makeEvent())).resolves.toBeUndefined()
    errorSpy.mockRestore()
  })
})
