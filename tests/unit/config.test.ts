import { describe, it, expect } from 'vitest'
import { parseConfig, omgConfigSchema, ConfigValidationError } from '../../src/config.js'
import type { OmgConfig } from '../../src/config.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Asserts the function throws a ConfigValidationError mentioning `fieldPath`. */
function expectFieldError(fn: () => unknown, fieldPath: string): void {
  expect(fn).toThrow(ConfigValidationError)
  expect(fn).toThrow(fieldPath)
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

describe('parseConfig — defaults', () => {
  it('empty object → all defaults applied', () => {
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

  it('partial input → unspecified fields get defaults', () => {
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

  it('unknown keys → stripped silently', () => {
    const result = parseConfig({
      unknownTopLevel: 'should be stripped',
      observer: { model: null, unknownField: 'stripped too' },
    })

    expect((result as Record<string, unknown>)['unknownTopLevel']).toBeUndefined()
    expect(result.observer.model).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Top-level input types
// ---------------------------------------------------------------------------

describe('parseConfig — top-level input validation', () => {
  it('null input → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig(null), '(root)')
  })

  it('undefined input → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig(undefined), '(root)')
  })

  it('string input → throws ConfigValidationError', () => {
    expect(() => parseConfig('observer: {}')).toThrow(ConfigValidationError)
  })

  it('array input → throws ConfigValidationError', () => {
    expect(() => parseConfig([])).toThrow(ConfigValidationError)
  })

  it('number input → throws ConfigValidationError', () => {
    expect(() => parseConfig(42)).toThrow(ConfigValidationError)
  })
})

// ---------------------------------------------------------------------------
// Model field
// ---------------------------------------------------------------------------

describe('parseConfig — model field', () => {
  it('model null → valid (inherit from OpenClaw)', () => {
    const result = parseConfig({ observer: { model: null }, reflector: { model: null } })
    expect(result.observer.model).toBeNull()
    expect(result.reflector.model).toBeNull()
  })

  it('lowercase model string → accepted', () => {
    const result = parseConfig({ observer: { model: 'anthropic/claude-3-5-haiku' } })
    expect(result.observer.model).toBe('anthropic/claude-3-5-haiku')
  })

  it('model with dots and colons → accepted', () => {
    const result = parseConfig({ observer: { model: 'openai/gpt-4.1-mini' } })
    expect(result.observer.model).toBe('openai/gpt-4.1-mini')
  })

  it('model without slash → throws ConfigValidationError on observer.model', () => {
    expectFieldError(() => parseConfig({ observer: { model: 'invalid-no-slash' } }), 'observer.model')
  })

  it('empty model string → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ observer: { model: '' } }), 'observer.model')
  })

  it('model with no provider (leading slash) → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ observer: { model: '/no-provider' } }), 'observer.model')
  })

  it('model with no name (trailing slash) → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ observer: { model: 'no-model/' } }), 'observer.model')
  })

  it('uppercase model string → throws ConfigValidationError (model IDs must be lowercase)', () => {
    expectFieldError(() => parseConfig({ observer: { model: 'UPPERCASE/Model' } }), 'observer.model')
  })
})

// ---------------------------------------------------------------------------
// Cron schedule
// ---------------------------------------------------------------------------

describe('parseConfig — cronSchedule', () => {
  it('valid: daily at 3am → accepted', () => {
    expect(() => parseConfig({ reflection: { cronSchedule: '0 3 * * *' } })).not.toThrow()
  })

  it('valid: every 15 minutes → accepted', () => {
    expect(() => parseConfig({ reflection: { cronSchedule: '*/15 * * * *' } })).not.toThrow()
  })

  it('valid: all-numeric fields → accepted', () => {
    expect(() => parseConfig({ reflection: { cronSchedule: '0 0 1 1 0' } })).not.toThrow()
  })

  it('non-cron string → throws ConfigValidationError on reflection.cronSchedule', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: 'not-a-cron' } }),
      'reflection.cronSchedule'
    )
  })

  it('6 fields → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '0 3 * * * *' } }),
      'reflection.cronSchedule'
    )
  })

  it('out-of-range minute (99) → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '99 3 * * *' } }),
      'reflection.cronSchedule'
    )
  })

  it('out-of-range hour (25) → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '0 25 * * *' } }),
      'reflection.cronSchedule'
    )
  })

  it('all out-of-range values (99 99 99 99 99) → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '99 99 99 99 99' } }),
      'reflection.cronSchedule'
    )
  })

  it('named day abbreviation (MON) → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '0 3 * * MON' } }),
      'reflection.cronSchedule'
    )
  })

  it('zero step (*/0) → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '*/0 * * * *' } }),
      'reflection.cronSchedule'
    )
  })
})

// ---------------------------------------------------------------------------
// Numeric thresholds
// ---------------------------------------------------------------------------

describe('parseConfig — numeric thresholds', () => {
  it('negative messageTokenThreshold → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ observation: { messageTokenThreshold: -1 } }),
      'observation.messageTokenThreshold'
    )
  })

  it('zero messageTokenThreshold → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ observation: { messageTokenThreshold: 0 } }),
      'observation.messageTokenThreshold'
    )
  })

  it('messageTokenThreshold minimum boundary 1 → accepted', () => {
    expect(
      parseConfig({ observation: { messageTokenThreshold: 1 } }).observation.messageTokenThreshold
    ).toBe(1)
  })

  it('float messageTokenThreshold → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ observation: { messageTokenThreshold: 1.5 } }),
      'observation.messageTokenThreshold'
    )
  })

  it('negative observationTokenThreshold → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { observationTokenThreshold: -100 } }),
      'reflection.observationTokenThreshold'
    )
  })

  it('negative maxContextTokens → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { maxContextTokens: 0 } }),
      'injection.maxContextTokens'
    )
  })

  it('negative maxMocs → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { maxMocs: -1 } }),
      'injection.maxMocs'
    )
  })

  it('maxMocs minimum boundary 1 → accepted', () => {
    expect(parseConfig({ injection: { maxMocs: 1 } }).injection.maxMocs).toBe(1)
  })

  it('float maxMocs → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { maxMocs: 2.5 } }),
      'injection.maxMocs'
    )
  })

  it('zero maxNodes → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { maxNodes: 0 } }),
      'injection.maxNodes'
    )
  })

  it('maxNodes minimum boundary 1 → accepted', () => {
    expect(parseConfig({ injection: { maxNodes: 1 } }).injection.maxNodes).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// triggerMode
// ---------------------------------------------------------------------------

describe('parseConfig — triggerMode', () => {
  it('triggerMode threshold → accepted', () => {
    expect(
      parseConfig({ observation: { triggerMode: 'threshold' } }).observation.triggerMode
    ).toBe('threshold')
  })

  it('triggerMode manual → accepted', () => {
    expect(
      parseConfig({ observation: { triggerMode: 'manual' } }).observation.triggerMode
    ).toBe('manual')
  })

  it('triggerMode invalid value → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ observation: { triggerMode: 'auto' } }),
      'observation.triggerMode'
    )
  })
})

// ---------------------------------------------------------------------------
// identity.mode
// ---------------------------------------------------------------------------

describe('parseConfig — identity', () => {
  it('identity mode session-key → accepted', () => {
    expect(parseConfig({ identity: { mode: 'session-key' } }).identity.mode).toBe('session-key')
  })

  it('identity mode invalid → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ identity: { mode: 'invalid-mode' } }),
      'identity.mode'
    )
  })
})

// ---------------------------------------------------------------------------
// storagePath
// ---------------------------------------------------------------------------

describe('parseConfig — storagePath', () => {
  it('custom storage path → accepted', () => {
    expect(parseConfig({ storagePath: 'custom/path/to/memory' }).storagePath).toBe('custom/path/to/memory')
  })

  it('empty storagePath → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ storagePath: '' }), 'storagePath')
  })

  it('storagePath with traversal (..) → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ storagePath: '../escape' }), 'storagePath')
    expectFieldError(() => parseConfig({ storagePath: 'memory/../escape' }), 'storagePath')
  })
})

// ---------------------------------------------------------------------------
// pinnedNodes
// ---------------------------------------------------------------------------

describe('parseConfig — pinnedNodes', () => {
  it('valid node ID list → accepted', () => {
    const result = parseConfig({
      injection: { pinnedNodes: ['omg/identity-core', 'omg/preferences'] },
    })
    expect(result.injection.pinnedNodes).toEqual(['omg/identity-core', 'omg/preferences'])
  })

  it('empty pinnedNodes array → accepted', () => {
    expect(parseConfig({ injection: { pinnedNodes: [] } }).injection.pinnedNodes).toEqual([])
  })

  it('pinnedNodes with bare string (no slash) → throws ConfigValidationError', () => {
    expect(() =>
      parseConfig({ injection: { pinnedNodes: ['not-a-valid-id'] } })
    ).toThrow(ConfigValidationError)
  })

  it('pinnedNodes with empty string entry → throws ConfigValidationError', () => {
    expect(() =>
      parseConfig({ injection: { pinnedNodes: [''] } })
    ).toThrow(ConfigValidationError)
  })
})

// ---------------------------------------------------------------------------
// omgConfigSchema export
// ---------------------------------------------------------------------------

describe('omgConfigSchema', () => {
  it('safeParse returns success:false for invalid input without throwing', () => {
    const result = omgConfigSchema.safeParse({ observer: { model: 'bad-no-slash' } })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0)
      expect(result.error.issues[0]?.path).toContain('model')
    }
  })

  it('safeParse returns success:true for valid input', () => {
    const result = omgConfigSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// OmgConfig type shape (compile-time checks via runtime assertions)
// ---------------------------------------------------------------------------

describe('OmgConfig type', () => {
  it('satisfies expected readonly shape', () => {
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
