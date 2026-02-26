import { describe, it, expect } from 'vitest'
import { z } from 'zod'
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
    expect(result.observation.messageTokenThreshold).toBe(8_000)
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

  it('unknown top-level and nested keys → stripped and reported via onUnknownKeys', () => {
    let capturedKeys: readonly string[] = []
    const result = parseConfig(
      {
        unknownTopLevel: 'should be stripped',
        observer: { model: null, unknownField: 'stripped too' },
      },
      { onUnknownKeys: (keys) => { capturedKeys = keys } }
    )
    expect((result as Record<string, unknown>)['unknownTopLevel']).toBeUndefined()
    expect(result.observer.model).toBeNull()
    expect(capturedKeys).toContain('unknownTopLevel')
    expect(capturedKeys).toContain('observer.unknownField')
  })

  it('clean input with no unknown keys → onUnknownKeys is not called', () => {
    let called = false
    parseConfig(
      { observer: { model: 'openai/gpt-4o-mini' } },
      { onUnknownKeys: () => { called = true } }
    )
    expect(called).toBe(false)
  })

  it('unknown key inside injection sub-object → captured by onUnknownKeys', () => {
    let capturedKeys: readonly string[] = []
    parseConfig(
      { injection: { maxMocs: 3, unknownInjectionKey: true } },
      { onUnknownKeys: (keys) => { capturedKeys = keys } }
    )
    expect(capturedKeys).toContain('injection.unknownInjectionKey')
  })

  it('throwing onUnknownKeys callback → error swallowed, valid config still returned', () => {
    expect(() =>
      parseConfig(
        { unknownTopLevel: 'value' },
        { onUnknownKeys: () => { throw new Error('callback error') } }
      )
    ).not.toThrow()
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

  it('uppercase reflector model → throws ConfigValidationError on reflector.model', () => {
    expectFieldError(() => parseConfig({ reflector: { model: 'UPPERCASE/Model' } }), 'reflector.model')
  })

  it('model with multiple slashes → throws ConfigValidationError (only one slash allowed)', () => {
    expectFieldError(() => parseConfig({ observer: { model: 'openai/gpt/4o-mini' } }), 'observer.model')
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

  it('valid: hour range within single decade (8-17) → accepted', () => {
    expect(() => parseConfig({ reflection: { cronSchedule: '0 8-17 * * *' } })).not.toThrow()
  })

  it('valid: hour range spanning decades (8-20) → accepted', () => {
    expect(() => parseConfig({ reflection: { cronSchedule: '0 8-20 * * *' } })).not.toThrow()
  })

  it('valid: full hour range (0-23) → accepted', () => {
    expect(() => parseConfig({ reflection: { cronSchedule: '0 0-23 * * *' } })).not.toThrow()
  })

  it('valid: DOM range spanning decades (5-25) → accepted', () => {
    expect(() => parseConfig({ reflection: { cronSchedule: '0 0 5-25 * *' } })).not.toThrow()
  })

  it('valid: month range spanning to two-digit months (6-12) → accepted', () => {
    expect(() => parseConfig({ reflection: { cronSchedule: '0 0 * 6-12 *' } })).not.toThrow()
  })

  it('valid: full month range (1-12) → accepted', () => {
    expect(() => parseConfig({ reflection: { cronSchedule: '0 0 * 1-12 *' } })).not.toThrow()
  })

  it('comma-separated list → throws ConfigValidationError (not supported)', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '0 9,17 * * *' } }),
      'reflection.cronSchedule'
    )
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '* * * * 1,5' } }),
      'reflection.cronSchedule'
    )
  })

  it('valid: max-boundary values (59 23 31 12 7) → accepted', () => {
    expect(() => parseConfig({ reflection: { cronSchedule: '59 23 31 12 7' } })).not.toThrow()
  })

  it('value-based step (1/5) → throws ConfigValidationError (only */N supported)', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '1/5 * * * *' } }),
      'reflection.cronSchedule'
    )
  })

  it('DOM=0 (invalid, domain is 1-31) → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '0 3 0 * *' } }),
      'reflection.cronSchedule'
    )
  })

  it('Month=0 (invalid, domain is 1-12) → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { cronSchedule: '0 3 * 0 *' } }),
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

  it('messageTokenThreshold below 1000 → clamped to 8000', () => {
    expect(
      parseConfig({ observation: { messageTokenThreshold: 1 } }).observation.messageTokenThreshold
    ).toBe(8000)
    expect(
      parseConfig({ observation: { messageTokenThreshold: 999 } }).observation.messageTokenThreshold
    ).toBe(8000)
  })

  it('messageTokenThreshold at 1000 → accepted as-is', () => {
    expect(
      parseConfig({ observation: { messageTokenThreshold: 1000 } }).observation.messageTokenThreshold
    ).toBe(1000)
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

  it('zero observationTokenThreshold → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { observationTokenThreshold: 0 } }),
      'reflection.observationTokenThreshold'
    )
  })

  it('float observationTokenThreshold → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ reflection: { observationTokenThreshold: 1.5 } }),
      'reflection.observationTokenThreshold'
    )
  })

  it('observationTokenThreshold minimum boundary 1 → accepted', () => {
    expect(
      parseConfig({ reflection: { observationTokenThreshold: 1 } }).reflection.observationTokenThreshold
    ).toBe(1)
  })

  it('float maxNodes → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { maxNodes: 1.5 } }),
      'injection.maxNodes'
    )
  })

  it('zero maxContextTokens → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { maxContextTokens: 0 } }),
      'injection.maxContextTokens'
    )
  })

  it('negative maxContextTokens → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { maxContextTokens: -1 } }),
      'injection.maxContextTokens'
    )
  })

  it('float maxContextTokens → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { maxContextTokens: 1.5 } }),
      'injection.maxContextTokens'
    )
  })

  it('maxContextTokens minimum boundary 1 → accepted', () => {
    expect(
      parseConfig({ injection: { maxContextTokens: 1 } }).injection.maxContextTokens
    ).toBe(1)
  })

  it('negative maxMocs → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { maxMocs: -1 } }),
      'injection.maxMocs'
    )
  })

  it('zero maxMocs → throws ConfigValidationError (minimum is 1)', () => {
    expectFieldError(
      () => parseConfig({ injection: { maxMocs: 0 } }),
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
    expectFieldError(() => parseConfig({ storagePath: '..' }), 'storagePath')
  })

  it('absolute storagePath (unix) → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ storagePath: '/absolute/path' }), 'storagePath')
    expectFieldError(() => parseConfig({ storagePath: '/etc/shadow' }), 'storagePath')
  })

  it('absolute storagePath (windows drive, uppercase) → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ storagePath: 'C:/windows/path' }), 'storagePath')
  })

  it('absolute storagePath (windows drive, lowercase) → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ storagePath: 'c:/windows/path' }), 'storagePath')
  })

  it('storagePath with ".." as a segment substring → accepted (not a traversal segment)', () => {
    expect(() => parseConfig({ storagePath: 'memory/valid..name' })).not.toThrow()
  })

  it('storagePath with single-dot segment (.) → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ storagePath: 'memory/./subdir' }), 'storagePath')
    expectFieldError(() => parseConfig({ storagePath: '.' }), 'storagePath')
  })

  it('backslash path → throws ConfigValidationError (no backslashes allowed)', () => {
    expectFieldError(() => parseConfig({ storagePath: 'memory\\omg' }), 'storagePath')
  })

  it('Windows UNC path → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ storagePath: '\\\\server\\share\\omg' }), 'storagePath')
  })

  it('storagePath with trailing slash → throws ConfigValidationError', () => {
    expectFieldError(() => parseConfig({ storagePath: 'memory/omg/' }), 'storagePath')
  })

  it('storagePath with .hidden segment → accepted (dot-prefix is not a traversal segment)', () => {
    expect(() => parseConfig({ storagePath: 'memory/.hidden/sub' })).not.toThrow()
    expect(parseConfig({ storagePath: 'memory/.hidden' }).storagePath).toBe('memory/.hidden')
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

  it('pinnedNodes entry with uppercase namespace → throws ConfigValidationError', () => {
    expect(() =>
      parseConfig({ injection: { pinnedNodes: ['Omg/identity-core'] } })
    ).toThrow(ConfigValidationError)
  })

  it('pinnedNodes entry with underscore in namespace → throws ConfigValidationError', () => {
    expect(() =>
      parseConfig({ injection: { pinnedNodes: ['omg_ns/identity'] } })
    ).toThrow(ConfigValidationError)
  })

  it('pinnedNodes entry with leading hyphen in namespace → throws ConfigValidationError', () => {
    expect(() =>
      parseConfig({ injection: { pinnedNodes: ['-omg/identity-core'] } })
    ).toThrow(ConfigValidationError)
  })

  it('pinnedNodes entry with leading hyphen in slug → throws ConfigValidationError', () => {
    expect(() =>
      parseConfig({ injection: { pinnedNodes: ['omg/-bad-slug'] } })
    ).toThrow(ConfigValidationError)
  })

  it('pinnedNodes entry with underscore and dot in slug → accepted', () => {
    const result = parseConfig({ injection: { pinnedNodes: ['omg/my_node.v2'] } })
    expect(result.injection.pinnedNodes).toEqual(['omg/my_node.v2'])
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
// ConfigValidationError structure
// ---------------------------------------------------------------------------

describe('ConfigValidationError', () => {
  it('message starts with standard prefix', () => {
    let err: ConfigValidationError | null = null
    try { parseConfig({ observer: { model: 'bad' } }) }
    catch (e) { if (e instanceof ConfigValidationError) err = e }
    expect(err?.message).toMatch(/^OMG plugin configuration is invalid:/)
  })

  it('.issues contains structured ZodIssue objects with field path', () => {
    let err: ConfigValidationError | null = null
    try { parseConfig({ observer: { model: 'bad' } }) }
    catch (e) { if (e instanceof ConfigValidationError) err = e }
    expect(err?.issues).toHaveLength(1)
    expect(err?.issues[0]?.path).toContain('model')
  })

  it('Error.cause is the original ZodError', () => {
    let err: ConfigValidationError | null = null
    try { parseConfig({ observer: { model: 'bad' } }) }
    catch (e) { if (e instanceof ConfigValidationError) err = e }
    expect(err?.cause).toBeInstanceOf(Error)
    expect((err?.cause as { issues?: unknown })?.issues).toBeDefined()
  })

  it('multiple invalid fields → exactly 2 indented lines in message body', () => {
    let err: ConfigValidationError | null = null
    try {
      parseConfig({
        observer: { model: 'bad' },
        observation: { messageTokenThreshold: -1 },
      })
    } catch (e) { if (e instanceof ConfigValidationError) err = e }
    const indentedLines = err?.message.split('\n').filter((l) => l.startsWith('  '))
    expect(indentedLines?.length).toBe(2)
  })

  it('(root) path label used when error is at the top level', () => {
    let err: ConfigValidationError | null = null
    try { parseConfig(null) }
    catch (e) { if (e instanceof ConfigValidationError) err = e }
    expect(err?.message).toContain('(root)')
  })

  it('instanceof check works correctly (prototype chain)', () => {
    let err: unknown
    try { parseConfig({ observer: { model: 'bad' } }) }
    catch (e) { err = e }
    expect(err).toBeInstanceOf(ConfigValidationError)
    expect(err).toBeInstanceOf(Error)
  })

  it('.name is "ConfigValidationError"', () => {
    let err: ConfigValidationError | null = null
    try { parseConfig({ observer: { model: 'bad' } }) }
    catch (e) { if (e instanceof ConfigValidationError) err = e }
    expect(err?.name).toBe('ConfigValidationError')
  })

  it('zero-issues ZodError → throws an internal Error (not a ConfigValidationError)', () => {
    let thrown: unknown
    try { new ConfigValidationError(new z.ZodError([])) }
    catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(ConfigValidationError)
    expect((thrown as Error).message).toMatch(/[Ii]nternal bug/)
  })

  it('array field path renders with bracket notation (e.g. injection.pinnedNodes[0])', () => {
    let err: ConfigValidationError | null = null
    try { parseConfig({ injection: { pinnedNodes: ['bad-no-slash'] } }) }
    catch (e) { if (e instanceof ConfigValidationError) err = e }
    expect(err?.message).toContain('injection.pinnedNodes[0]')
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

// ---------------------------------------------------------------------------
// scope field (Phase 1c)
// ---------------------------------------------------------------------------

describe('parseConfig — scope field', () => {
  it('scope is undefined by default', () => {
    const result = parseConfig({})
    expect(result.scope).toBeUndefined()
  })

  it('accepts a non-empty scope string', () => {
    const result = parseConfig({ scope: '/workspace/proj' })
    expect(result.scope).toBe('/workspace/proj')
  })

  it('rejects an empty scope string', () => {
    expect(() => parseConfig({ scope: '' })).toThrow(ConfigValidationError)
  })
})

// ---------------------------------------------------------------------------
// dedup config
// ---------------------------------------------------------------------------

describe('parseConfig — dedup', () => {
  it('dedup defaults applied when not specified', () => {
    const result = parseConfig({})
    expect(result.dedup.similarityThreshold).toBe(0.45)
    expect(result.dedup.maxClustersPerRun).toBe(30)
    expect(result.dedup.maxClusterSize).toBe(8)
    expect(result.dedup.maxPairsPerBucket).toBe(20)
    expect(result.dedup.staleDaysThreshold).toBe(90)
    expect(result.dedup.stableTypes).toEqual(['identity', 'preference', 'decision', 'project'])
  })

  it('custom dedup values → applied', () => {
    const result = parseConfig({
      dedup: {
        similarityThreshold: 0.6,
        maxClustersPerRun: 10,
        maxClusterSize: 5,
        maxPairsPerBucket: 15,
        staleDaysThreshold: 30,
        stableTypes: ['identity'],
      },
    })
    expect(result.dedup.similarityThreshold).toBe(0.6)
    expect(result.dedup.maxClustersPerRun).toBe(10)
    expect(result.dedup.maxClusterSize).toBe(5)
    expect(result.dedup.maxPairsPerBucket).toBe(15)
    expect(result.dedup.staleDaysThreshold).toBe(30)
    expect(result.dedup.stableTypes).toEqual(['identity'])
  })

  it('similarityThreshold < 0 → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ dedup: { similarityThreshold: -0.1 } }),
      'dedup.similarityThreshold'
    )
  })

  it('similarityThreshold > 1 → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ dedup: { similarityThreshold: 1.1 } }),
      'dedup.similarityThreshold'
    )
  })

  it('maxClusterSize < 2 → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ dedup: { maxClusterSize: 1 } }),
      'dedup.maxClusterSize'
    )
  })

  it('maxClusterSize > 20 → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ dedup: { maxClusterSize: 21 } }),
      'dedup.maxClusterSize'
    )
  })
})

// ---------------------------------------------------------------------------
// injection.semantic config
// ---------------------------------------------------------------------------

describe('parseConfig — injection.semantic', () => {
  it('semantic defaults applied when not specified', () => {
    const result = parseConfig({})
    expect(result.injection.semantic.enabled).toBe(true)
    expect(result.injection.semantic.weight).toBe(0.4)
    expect(result.injection.semantic.maxResults).toBe(20)
    expect(result.injection.semantic.minScore).toBe(0.3)
  })

  it('semantic.enabled false → accepted', () => {
    const result = parseConfig({ injection: { semantic: { enabled: false } } })
    expect(result.injection.semantic.enabled).toBe(false)
  })

  it('custom semantic weight → applied', () => {
    const result = parseConfig({ injection: { semantic: { weight: 1.5 } } })
    expect(result.injection.semantic.weight).toBe(1.5)
  })

  it('semantic.weight > 2 → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { semantic: { weight: 2.1 } } }),
      'injection.semantic.weight'
    )
  })

  it('semantic.weight < 0 → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { semantic: { weight: -0.1 } } }),
      'injection.semantic.weight'
    )
  })

  it('semantic.maxResults = 1 → accepted (boundary)', () => {
    const result = parseConfig({ injection: { semantic: { maxResults: 1 } } })
    expect(result.injection.semantic.maxResults).toBe(1)
  })

  it('semantic.maxResults = 100 → accepted (boundary)', () => {
    const result = parseConfig({ injection: { semantic: { maxResults: 100 } } })
    expect(result.injection.semantic.maxResults).toBe(100)
  })

  it('semantic.maxResults = 0 → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { semantic: { maxResults: 0 } } }),
      'injection.semantic.maxResults'
    )
  })

  it('semantic.maxResults = 101 → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { semantic: { maxResults: 101 } } }),
      'injection.semantic.maxResults'
    )
  })

  it('semantic.maxResults float → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { semantic: { maxResults: 10.5 } } }),
      'injection.semantic.maxResults'
    )
  })

  it('semantic.minScore = 0 → accepted (boundary)', () => {
    const result = parseConfig({ injection: { semantic: { minScore: 0 } } })
    expect(result.injection.semantic.minScore).toBe(0)
  })

  it('semantic.minScore = 1 → accepted (boundary)', () => {
    const result = parseConfig({ injection: { semantic: { minScore: 1 } } })
    expect(result.injection.semantic.minScore).toBe(1)
  })

  it('semantic.minScore < 0 → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { semantic: { minScore: -0.1 } } }),
      'injection.semantic.minScore'
    )
  })

  it('semantic.minScore > 1 → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ injection: { semantic: { minScore: 1.1 } } }),
      'injection.semantic.minScore'
    )
  })

  it('unknown key in injection.semantic → detected by onUnknownKeys', () => {
    let capturedKeys: readonly string[] = []
    parseConfig(
      { injection: { semantic: { typo: true } } },
      { onUnknownKeys: (keys) => { capturedKeys = keys } }
    )
    expect(capturedKeys).toContain('injection.semantic.typo')
  })
})

// ---------------------------------------------------------------------------
// graphMaintenance config
// ---------------------------------------------------------------------------

describe('parseConfig — graphMaintenance', () => {
  it('graphMaintenance defaults applied when not specified', () => {
    const result = parseConfig({})
    expect(result.graphMaintenance.cronSchedule).toBe('0 3 * * *')
  })

  it('custom graphMaintenance.cronSchedule → applied', () => {
    const result = parseConfig({ graphMaintenance: { cronSchedule: '0 2 * * *' } })
    expect(result.graphMaintenance.cronSchedule).toBe('0 2 * * *')
  })

  it('invalid graphMaintenance.cronSchedule → throws ConfigValidationError', () => {
    expectFieldError(
      () => parseConfig({ graphMaintenance: { cronSchedule: 'not-a-cron' } }),
      'graphMaintenance.cronSchedule'
    )
  })

  it('falls back to reflection.cronSchedule when graphMaintenance.cronSchedule not set', () => {
    // Both unset → both get default '0 3 * * *'
    const result = parseConfig({})
    expect(result.graphMaintenance.cronSchedule).toBe(result.reflection.cronSchedule)
  })
})

// ---------------------------------------------------------------------------
// bootstrap.batchBudgetPerRun & bootstrap.cronSchedule
// ---------------------------------------------------------------------------

describe('parseConfig — bootstrap.batchBudgetPerRun', () => {
  it('defaults to 20', () => {
    const result = parseConfig({})
    expect(result.bootstrap.batchBudgetPerRun).toBe(20)
  })

  it('accepts a positive integer', () => {
    const result = parseConfig({ bootstrap: { batchBudgetPerRun: 5 } })
    expect(result.bootstrap.batchBudgetPerRun).toBe(5)
  })

  it('rejects zero', () => {
    expectFieldError(
      () => parseConfig({ bootstrap: { batchBudgetPerRun: 0 } }),
      'bootstrap.batchBudgetPerRun'
    )
  })

  it('rejects negative values', () => {
    expectFieldError(
      () => parseConfig({ bootstrap: { batchBudgetPerRun: -1 } }),
      'bootstrap.batchBudgetPerRun'
    )
  })

  it('rejects non-integer values', () => {
    expectFieldError(
      () => parseConfig({ bootstrap: { batchBudgetPerRun: 2.5 } }),
      'bootstrap.batchBudgetPerRun'
    )
  })
})

describe('parseConfig — bootstrap.cronSchedule', () => {
  it('defaults to */5 * * * *', () => {
    const result = parseConfig({})
    expect(result.bootstrap.cronSchedule).toBe('*/5 * * * *')
  })

  it('accepts a valid 5-field cron expression', () => {
    const result = parseConfig({ bootstrap: { cronSchedule: '0 * * * *' } })
    expect(result.bootstrap.cronSchedule).toBe('0 * * * *')
  })

  it('rejects an invalid cron expression', () => {
    expectFieldError(
      () => parseConfig({ bootstrap: { cronSchedule: 'not-a-cron' } }),
      'bootstrap.cronSchedule'
    )
  })
})
