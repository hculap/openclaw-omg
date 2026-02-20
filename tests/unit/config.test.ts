import { describe, it, expect } from 'vitest'
import { parseConfig, omgConfigSchema } from '../../src/config.js'
import type { OmgConfig } from '../../src/config.js'

describe('parseConfig', () => {
  it('empty input → all defaults applied', () => {
    const result = parseConfig({})

    expect(result.observer.model).toBeNull()
    expect(result.reflector.model).toBeNull()
    expect(result.observation.messageTokenThreshold).toBe(30_000)
    expect(result.observation.triggerMode).toBe('threshold')
    expect(result.reflection.observationTokenThreshold).toBe(40_000)
    expect(result.reflection.cronSchedule).toBe('0 3 * * *')
    expect(result.injection.maxContextTokens).toBe(4_000)
    expect(result.injection.maxMocs).toBe(3)
    expect(result.injection.maxNodes).toBe(5)
    expect(result.injection.pinnedNodes).toEqual([])
    expect(result.identity.mode).toBe('session-key')
    expect(result.storagePath).toBe('memory/omg')
  })

  it('partial input → merged with defaults', () => {
    const result = parseConfig({
      observer: { model: 'openai/gpt-4o-mini' },
      injection: { maxContextTokens: 8_000 },
    })

    expect(result.observer.model).toBe('openai/gpt-4o-mini')
    expect(result.reflector.model).toBeNull()
    expect(result.injection.maxContextTokens).toBe(8_000)
    expect(result.injection.maxMocs).toBe(3)
    expect(result.storagePath).toBe('memory/omg')
  })

  it('model null → valid (inherit from OpenClaw)', () => {
    const result = parseConfig({
      observer: { model: null },
      reflector: { model: null },
    })

    expect(result.observer.model).toBeNull()
    expect(result.reflector.model).toBeNull()
  })

  it('valid model string format → accepted', () => {
    const result = parseConfig({ observer: { model: 'anthropic/claude-3-5-haiku' } })
    expect(result.observer.model).toBe('anthropic/claude-3-5-haiku')
  })

  it('invalid model string format → throws', () => {
    expect(() => parseConfig({ observer: { model: 'invalid-no-slash' } })).toThrow()
    expect(() => parseConfig({ observer: { model: 'UPPERCASE/Model' } })).not.toThrow()
    expect(() => parseConfig({ observer: { model: '' } })).toThrow()
    expect(() => parseConfig({ observer: { model: '/no-provider' } })).toThrow()
    expect(() => parseConfig({ observer: { model: 'no-model/' } })).toThrow()
  })

  it('invalid cron schedule → throws', () => {
    expect(() =>
      parseConfig({ reflection: { cronSchedule: 'not-a-cron' } })
    ).toThrow()
    expect(() =>
      parseConfig({ reflection: { cronSchedule: '0 3 * * * *' } })
    ).toThrow()
  })

  it('valid cron schedules → accepted', () => {
    expect(() =>
      parseConfig({ reflection: { cronSchedule: '0 3 * * *' } })
    ).not.toThrow()
    expect(() =>
      parseConfig({ reflection: { cronSchedule: '*/15 * * * *' } })
    ).not.toThrow()
    expect(() =>
      parseConfig({ reflection: { cronSchedule: '0 0 1 1 0' } })
    ).not.toThrow()
  })

  it('negative thresholds → throws', () => {
    expect(() =>
      parseConfig({ observation: { messageTokenThreshold: -1 } })
    ).toThrow()
    expect(() =>
      parseConfig({ reflection: { observationTokenThreshold: -100 } })
    ).toThrow()
    expect(() =>
      parseConfig({ injection: { maxContextTokens: 0 } })
    ).toThrow()
    expect(() =>
      parseConfig({ injection: { maxMocs: -1 } })
    ).toThrow()
    expect(() =>
      parseConfig({ injection: { maxNodes: 0 } })
    ).toThrow()
  })

  it('unknown keys → stripped (not throw)', () => {
    const result = parseConfig({
      unknownTopLevel: 'should be stripped',
      observer: { model: null, unknownField: 'stripped too' },
    })

    expect((result as Record<string, unknown>)['unknownTopLevel']).toBeUndefined()
    expect(result.observer.model).toBeNull()
  })

  it('storagePath custom value → accepted', () => {
    const result = parseConfig({ storagePath: 'custom/path/to/memory' })
    expect(result.storagePath).toBe('custom/path/to/memory')
  })

  it('identity mode session-key → accepted', () => {
    const result = parseConfig({ identity: { mode: 'session-key' } })
    expect(result.identity.mode).toBe('session-key')
  })

  it('identity mode invalid → throws', () => {
    expect(() =>
      parseConfig({ identity: { mode: 'invalid-mode' } })
    ).toThrow()
  })

  it('pinnedNodes list → accepted', () => {
    const result = parseConfig({ injection: { pinnedNodes: ['omg/identity-core', 'omg/preferences'] } })
    expect(result.injection.pinnedNodes).toEqual(['omg/identity-core', 'omg/preferences'])
  })

  it('omgConfigSchema is a Zod schema with parse method', () => {
    expect(typeof omgConfigSchema.parse).toBe('function')
    expect(typeof omgConfigSchema.safeParse).toBe('function')
  })
})

describe('OmgConfig type', () => {
  it('type satisfies expected shape', () => {
    // This is a compile-time check — if the type is wrong, tsc will fail
    const config: OmgConfig = parseConfig({})

    const _observer: string | null = config.observer.model
    const _reflector: string | null = config.reflector.model
    const _threshold: number = config.observation.messageTokenThreshold
    const _cron: string = config.reflection.cronSchedule
    const _maxTokens: number = config.injection.maxContextTokens
    const _pinned: readonly string[] = config.injection.pinnedNodes
    const _storagePath: string = config.storagePath

    expect(_observer).toBeNull()
    expect(_reflector).toBeNull()
    expect(_threshold).toBeGreaterThan(0)
    expect(_cron).toBeTruthy()
    expect(_maxTokens).toBeGreaterThan(0)
    expect(_pinned).toEqual([])
    expect(_storagePath).toBeTruthy()
  })
})
