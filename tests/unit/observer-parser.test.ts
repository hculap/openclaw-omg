import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  parseObserverOutput,
  parseExtractOutput,
  parseExtractOutputWithDiagnostics,
} from '../../src/observer/parser.js'
import {
  coerceNodeType,
  inferNodeTypeFromKey,
  INFERABLE_NODE_TYPES,
} from '../../src/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeXml(inner: string): string {
  return `<observations>${inner}</observations>`
}

function makeOperation(attrs: string, children: string): string {
  return `<operation ${attrs}>${children}</operation>`
}

// New upsert format operations
const VALID_UPSERT_PREFERENCE = makeOperation(
  'type="preference" priority="high"',
  `<canonical-key>preferences.editor_theme</canonical-key>
   <title>Editor Theme Preference</title>
   <description>User prefers dark mode in all editors</description>
   <content>The user explicitly stated they prefer dark mode in all development editors.</content>
   <moc-hints>preferences</moc-hints>
   <tags>editor, appearance</tags>`,
)

const VALID_UPSERT_PROJECT = makeOperation(
  'type="project" priority="medium"',
  `<canonical-key>projects.my_app</canonical-key>
   <title>My App Project</title>
   <description>Main web application project</description>
   <content>Updated details about the project.</content>`,
)

const VALID_UPSERT_WITH_LINKS = makeOperation(
  'type="fact" priority="low"',
  `<canonical-key>user.location.city</canonical-key>
   <title>User Location</title>
   <description>User is based in New York</description>
   <content>The user is based in New York City.</content>
   <links>preferences.editor_theme</links>`,
)

// ---------------------------------------------------------------------------
// Valid XML: basic cases
// ---------------------------------------------------------------------------

describe('parseObserverOutput — valid upsert operations', () => {
  it('parses a single upsert operation correctly', () => {
    const xml = makeXml(`<operations>${VALID_UPSERT_PREFERENCE}</operations>`)
    const output = parseObserverOutput(xml)

    expect(output.operations).toHaveLength(1)
    const op = output.operations[0]!
    expect(op.kind).toBe('upsert')
    if (op.kind === 'upsert') {
      expect(op.canonicalKey).toBe('preferences.editor_theme')
      expect(op.type).toBe('preference')
      expect(op.title).toBe('Editor Theme Preference')
      expect(op.description).toBe('User prefers dark mode in all editors')
      expect(op.body).toBe('The user explicitly stated they prefer dark mode in all development editors.')
      expect(op.priority).toBe('high')
    }
  })

  it('parses moc-hints into an array', () => {
    const xml = makeXml(`<operations>${VALID_UPSERT_PREFERENCE}</operations>`)
    const output = parseObserverOutput(xml)
    const op = output.operations[0]!
    if (op.kind === 'upsert') {
      expect(op.mocHints).toContain('preferences')
    }
  })

  it('parses multiple moc-hints separated by comma', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="fact" priority="medium"',
      `<canonical-key>some.fact</canonical-key>
       <title>Some Fact</title>
       <description>Some fact</description>
       <content>body</content>
       <moc-hints>preferences, tools</moc-hints>`,
    )}</operations>`)
    const output = parseObserverOutput(xml)
    const op = output.operations[0]!
    if (op.kind === 'upsert') {
      expect(op.mocHints).toContain('preferences')
      expect(op.mocHints).toContain('tools')
    }
  })

  it('parses <tags> into a trimmed array', () => {
    const xml = makeXml(`<operations>${VALID_UPSERT_PREFERENCE}</operations>`)
    const output = parseObserverOutput(xml)
    const op = output.operations[0]!
    if (op.kind === 'upsert') {
      expect(op.tags).toContain('editor')
      expect(op.tags).toContain('appearance')
    }
  })

  it('parses <links> into an array of canonicalKeys', () => {
    const xml = makeXml(`<operations>${VALID_UPSERT_WITH_LINKS}</operations>`)
    const output = parseObserverOutput(xml)
    const op = output.operations[0]!
    if (op.kind === 'upsert') {
      expect(op.linkKeys).toContain('preferences.editor_theme')
    }
  })

  it('parses multiple operations in order', () => {
    const xml = makeXml(`<operations>${VALID_UPSERT_PREFERENCE}${VALID_UPSERT_PROJECT}</operations>`)
    const output = parseObserverOutput(xml)

    expect(output.operations).toHaveLength(2)
    expect(output.operations[0]!.kind).toBe('upsert')
    expect(output.operations[1]!.kind).toBe('upsert')
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.canonicalKey).toBe('preferences.editor_theme')
    }
    if (output.operations[1]!.kind === 'upsert') {
      expect(output.operations[1]!.canonicalKey).toBe('projects.my_app')
    }
  })

  it('defaults priority to medium when attribute is missing', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="fact"',
      `<canonical-key>some.fact</canonical-key>
       <title>Some Fact</title>
       <description>Some fact</description>
       <content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations[0]!.kind).toBe('upsert')
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.priority).toBe('medium')
    }
  })

  it('defaults priority to medium when priority attribute is unrecognised', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="fact" priority="urgent"',
      `<canonical-key>some.fact</canonical-key>
       <title>Some Fact</title>
       <description>Some fact</description>
       <content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.priority).toBe('medium')
    }
  })

  it('parses <now-update> correctly', () => {
    const xml = makeXml(`
      <operations></operations>
      <now-update>## Focus\nWorking on tests.</now-update>
    `)
    const output = parseObserverOutput(xml)
    expect(output.nowUpdate).toContain('## Focus')
  })

  it('returns nowUpdate: null when <now-update> is absent', () => {
    const xml = makeXml(`<operations>${VALID_UPSERT_PREFERENCE}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.nowUpdate).toBeNull()
  })

  it('derives mocUpdates from operations mocHints (deduplicated)', () => {
    const op1 = makeOperation(
      'type="preference" priority="high"',
      `<canonical-key>pref.one</canonical-key>
       <title>Pref One</title>
       <description>Pref one</description>
       <content>body</content>
       <moc-hints>preferences</moc-hints>`,
    )
    const op2 = makeOperation(
      'type="preference" priority="medium"',
      `<canonical-key>pref.two</canonical-key>
       <title>Pref Two</title>
       <description>Pref two</description>
       <content>body</content>
       <moc-hints>preferences, tools</moc-hints>`,
    )
    const xml = makeXml(`<operations>${op1}${op2}</operations>`)
    const output = parseObserverOutput(xml)
    // preferences appears in both ops but should only appear once in mocUpdates
    const prefCount = output.mocUpdates.filter((d) => d === 'preferences').length
    expect(prefCount).toBe(1)
    expect(output.mocUpdates).toContain('tools')
  })

  it('returns empty mocUpdates when no operation has moc-hints', () => {
    const xml = makeXml(`<operations>${VALID_UPSERT_PROJECT}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.mocUpdates).toHaveLength(0)
  })

  it('returns empty operations array for empty <operations> block', () => {
    const xml = makeXml(`<operations></operations>`)
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
    expect(output.nowUpdate).toBeNull()
    expect(output.mocUpdates).toHaveLength(0)
  })

  it('works when LLM wraps XML in ``` code fences', () => {
    const raw = `Here is my analysis:\n\`\`\`xml\n${makeXml(`<operations>${VALID_UPSERT_PREFERENCE}</operations>`)}\n\`\`\``
    const output = parseObserverOutput(raw)
    expect(output.operations).toHaveLength(1)
  })

  it('handles XML with HTML entities (&amp;, &quot;) correctly', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="fact" priority="low"',
      `<canonical-key>facts.ampersand</canonical-key>
       <title>AT&amp;T fact</title>
       <description>AT&amp;T fact</description>
       <content>Content with &quot;quotes&quot; and &amp; ampersand.</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.description).toContain('AT&T fact')
    }
  })
})

// ---------------------------------------------------------------------------
// Invalid operations: skipped with warning
// ---------------------------------------------------------------------------

describe('parseObserverOutput — invalid upsert operations skipped', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('skips an operation with an invalid node type and logs a warning', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="invalidType" priority="high"',
      `<canonical-key>some.key</canonical-key>
       <title>Title</title>
       <description>desc</description>
       <content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalidType'))
  })

  it('recovers an operation with missing canonical-key by generating from type + title', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="fact" priority="medium"',
      `<title>Some Fact</title>
       <description>desc</description>
       <content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    // Now recovered: key generated as "fact.some_fact"
    expect(output.operations).toHaveLength(1)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.canonicalKey).toBe('fact.some_fact')
    }
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('generated canonical-key'))
  })

  it('skips an operation with missing description and logs a warning', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="fact" priority="medium"',
      `<canonical-key>some.key</canonical-key>
       <title>Some Title</title>
       <content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing'))
  })

  it('still returns valid operations when mixed with invalid ones', () => {
    const badOp = makeOperation(
      'type="not-a-type" priority="high"',
      `<canonical-key>some.key</canonical-key>
       <title>Title</title>
       <description>bad type</description>
       <content>body</content>`,
    )
    const xml = makeXml(`<operations>${badOp}${VALID_UPSERT_PREFERENCE}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    expect(output.operations[0]!.kind).toBe('upsert')
  })

  it('logs diagnostics with accepted/total count for rejected operations', () => {
    const badOp = makeOperation(
      'type="not-a-type" priority="high"',
      `<canonical-key>some.key</canonical-key>
       <title>Title</title>
       <description>bad</description>
       <content>body</content>`,
    )
    const xml = makeXml(`<operations>${badOp}${badOp}${VALID_UPSERT_PREFERENCE}</operations>`)

    parseObserverOutput(xml)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1/3 candidates accepted, 2 rejected'))
  })

  it('logs warning with unknown priority value when coercing to medium', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="fact" priority="urgent"',
      `<canonical-key>some.key</canonical-key>
       <title>Title</title>
       <description>Some fact</description>
       <content>body</content>`,
    )}</operations>`)

    parseObserverOutput(xml)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"urgent"'))
  })
})

// ---------------------------------------------------------------------------
// Malformed / invalid input
// ---------------------------------------------------------------------------

describe('parseObserverOutput — malformed input', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('does not throw on malformed XML', () => {
    expect(() => parseObserverOutput('<observations><unclosed')).not.toThrow()
  })

  it('does not throw on completely invalid input', () => {
    expect(() => parseObserverOutput('not xml at all 🎉')).not.toThrow()
  })

  it('does not throw on empty string', () => {
    expect(() => parseObserverOutput('')).not.toThrow()
  })

  it('returns empty output for empty string and logs a warning', () => {
    const output = parseObserverOutput('')
    expect(output.operations).toHaveLength(0)
    expect(output.nowUpdate).toBeNull()
    expect(output.mocUpdates).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty response'))
  })

  it('returns empty output when no recognizable root element is found and logs an error', () => {
    const output = parseObserverOutput('<result><nothing/></result>')
    expect(output.operations).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no recognizable root element'))
  })

  it('returns a valid ObserverOutput shape on any failure', () => {
    const output = parseObserverOutput('<<< totally broken >>>')
    expect(Array.isArray(output.operations)).toBe(true)
    expect(output.nowUpdate === null || typeof output.nowUpdate === 'string').toBe(true)
    expect(Array.isArray(output.mocUpdates)).toBe(true)
  })

  it('logs an error (not warn) when XMLParser.parse() throws', () => {
    parseObserverOutput('<observations')
    expect(errorSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// parseExtractOutput — new extract format
// ---------------------------------------------------------------------------

describe('parseExtractOutput — valid candidates', () => {
  it('parses a single candidate with required fields', () => {
    const xml = `<observations>
<operations>
<operation type="preference" priority="high">
  <canonical-key>preferences.editor_theme</canonical-key>
  <title>Editor Theme</title>
  <description>User prefers dark mode</description>
  <content>The user prefers dark mode.</content>
</operation>
</operations>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates).toHaveLength(1)
    const c = result.candidates[0]!
    expect(c.canonicalKey).toBe('preferences.editor_theme')
    expect(c.type).toBe('preference')
    expect(c.title).toBe('Editor Theme')
    expect(c.description).toBe('User prefers dark mode')
    expect(c.body).toBe('The user prefers dark mode.')
    expect(c.priority).toBe('high')
  })

  it('parses moc-hints as array', () => {
    const xml = `<observations>
<operations>
<operation type="preference" priority="medium">
  <canonical-key>preferences.theme</canonical-key>
  <title>Theme</title>
  <description>Prefers dark</description>
  <content>Dark mode.</content>
  <moc-hints>preferences, colors</moc-hints>
</operation>
</operations>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates[0]?.mocHints).toEqual(['preferences', 'colors'])
  })

  it('parses tags as array', () => {
    const xml = `<observations>
<operations>
<operation type="fact" priority="low">
  <canonical-key>facts.typescript</canonical-key>
  <title>TypeScript</title>
  <description>TypeScript is typed</description>
  <content>TypeScript adds types.</content>
  <tags>typescript, programming</tags>
</operation>
</operations>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates[0]?.tags).toEqual(['typescript', 'programming'])
  })

  it('derives mocUpdates from candidates mocHints', () => {
    const xml = `<observations>
<operations>
<operation type="preference" priority="high">
  <canonical-key>preferences.theme</canonical-key>
  <title>Theme</title>
  <description>Prefers dark</description>
  <content>Dark.</content>
  <moc-hints>preferences</moc-hints>
</operation>
</operations>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.mocUpdates).toContain('preferences')
  })

  it('parses multiple candidates', () => {
    const xml = `<observations>
<operations>
<operation type="preference" priority="high">
  <canonical-key>preferences.theme</canonical-key>
  <title>Theme</title>
  <description>Prefers dark mode</description>
  <content>Dark.</content>
</operation>
<operation type="fact" priority="medium">
  <canonical-key>facts.typescript</canonical-key>
  <title>TypeScript</title>
  <description>TypeScript is typed</description>
  <content>Types added.</content>
</operation>
</operations>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates).toHaveLength(2)
  })
})

describe('parseExtractOutput — now-patch', () => {
  it('parses now-patch when present', () => {
    const xml = `<observations>
<operations></operations>
<now-patch>
  <focus>Working on auth module.</focus>
  <open-loops>JWT middleware, login tests</open-loops>
  <suggested-links>preferences.answer_style</suggested-links>
</now-patch>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.nowPatch).not.toBeNull()
    expect(result.nowPatch?.focus).toBe('Working on auth module.')
    expect(result.nowPatch?.openLoops).toEqual(['JWT middleware', 'login tests'])
    expect(result.nowPatch?.suggestedLinks).toEqual(['preferences.answer_style'])
  })

  it('nowPatch is null when now-patch element is absent', () => {
    const xml = '<observations><operations></operations></observations>'
    const result = parseExtractOutput(xml)
    expect(result.nowPatch).toBeNull()
  })

  it('nowPatch is null when focus is missing', () => {
    const xml = `<observations>
<operations></operations>
<now-patch><open-loops>loop1</open-loops></now-patch>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.nowPatch).toBeNull()
  })
})

describe('parseExtractOutput — failure modes', () => {
  it('returns empty output for empty string', () => {
    const result = parseExtractOutput('')
    expect(result.candidates).toHaveLength(0)
    expect(result.nowPatch).toBeNull()
    expect(result.mocUpdates).toHaveLength(0)
  })

  it('returns empty output for garbage text', () => {
    const result = parseExtractOutput('this is not xml')
    expect(result.candidates).toHaveLength(0)
  })

  it('drops candidates with missing canonical-key and no title to generate from', () => {
    const xml = `<observations>
<operations>
<operation type="fact" priority="medium">
  <description>Missing key</description>
  <content>Content.</content>
</operation>
</operations>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates).toHaveLength(0)
  })

  it('drops candidates with unknown type', () => {
    const xml = `<observations>
<operations>
<operation type="unknown-type" priority="medium">
  <canonical-key>bad.type</canonical-key>
  <title>Bad type</title>
  <description>Some description</description>
  <content>Content.</content>
</operation>
</operations>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates).toHaveLength(0)
  })

  it('never throws on any input', () => {
    const inputs = ['', '<<garbage>>', '<observations>', null as unknown as string, undefined as unknown as string]
    for (const input of inputs) {
      expect(() => parseExtractOutput(input)).not.toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// Phase 1: coerceNodeType and inferNodeTypeFromKey (types.ts)
// ---------------------------------------------------------------------------

describe('coerceNodeType', () => {
  it('returns the type for exact lowercase match', () => {
    expect(coerceNodeType('identity')).toBe('identity')
    expect(coerceNodeType('preference')).toBe('preference')
    expect(coerceNodeType('moc')).toBe('moc')
  })

  it('handles uppercase type strings', () => {
    expect(coerceNodeType('Identity')).toBe('identity')
    expect(coerceNodeType('PREFERENCE')).toBe('preference')
    expect(coerceNodeType('Fact')).toBe('fact')
  })

  it('handles mixed case', () => {
    expect(coerceNodeType('ePiSoDe')).toBe('episode')
    expect(coerceNodeType('PROJECT')).toBe('project')
  })

  it('handles leading/trailing whitespace', () => {
    expect(coerceNodeType('  identity  ')).toBe('identity')
    expect(coerceNodeType('\tpreference\n')).toBe('preference')
  })

  it('handles plural forms', () => {
    expect(coerceNodeType('identities')).toBe('identity')
    expect(coerceNodeType('preferences')).toBe('preference')
    expect(coerceNodeType('projects')).toBe('project')
    expect(coerceNodeType('decisions')).toBe('decision')
    expect(coerceNodeType('facts')).toBe('fact')
    expect(coerceNodeType('episodes')).toBe('episode')
    expect(coerceNodeType('reflections')).toBe('reflection')
    expect(coerceNodeType('mocs')).toBe('moc')
  })

  it('returns null for non-string input', () => {
    expect(coerceNodeType(123)).toBeNull()
    expect(coerceNodeType(null)).toBeNull()
    expect(coerceNodeType(undefined)).toBeNull()
  })

  it('returns null for unrecognizable strings', () => {
    expect(coerceNodeType('not-a-type')).toBeNull()
    expect(coerceNodeType('')).toBeNull()
    expect(coerceNodeType('foobar')).toBeNull()
  })
})

describe('inferNodeTypeFromKey', () => {
  it('infers type from key prefix for user-facing types', () => {
    expect(inferNodeTypeFromKey('identity.name')).toBe('identity')
    expect(inferNodeTypeFromKey('preference.theme')).toBe('preference')
    expect(inferNodeTypeFromKey('project.my_app')).toBe('project')
    expect(inferNodeTypeFromKey('decision.use_react')).toBe('decision')
    expect(inferNodeTypeFromKey('fact.typescript_typed')).toBe('fact')
    expect(inferNodeTypeFromKey('episode.debug_session')).toBe('episode')
  })

  it('handles plural prefixes', () => {
    expect(inferNodeTypeFromKey('preferences.theme')).toBe('preference')
    expect(inferNodeTypeFromKey('facts.something')).toBe('fact')
    expect(inferNodeTypeFromKey('episodes.session1')).toBe('episode')
    expect(inferNodeTypeFromKey('identities.user_name')).toBe('identity')
  })

  it('does not infer system types from key prefix', () => {
    expect(inferNodeTypeFromKey('moc.preferences')).toBeNull()
    expect(inferNodeTypeFromKey('index.main')).toBeNull()
    expect(inferNodeTypeFromKey('now.current')).toBeNull()
    expect(inferNodeTypeFromKey('reflection.insight')).toBeNull()
  })

  it('returns null for keys without a dot', () => {
    expect(inferNodeTypeFromKey('nodot')).toBeNull()
    expect(inferNodeTypeFromKey('')).toBeNull()
  })

  it('returns null for unrecognizable prefixes', () => {
    expect(inferNodeTypeFromKey('foobar.something')).toBeNull()
    expect(inferNodeTypeFromKey('custom.key')).toBeNull()
  })

  it('handles case-insensitive prefix matching', () => {
    expect(inferNodeTypeFromKey('Preference.theme')).toBe('preference')
    expect(inferNodeTypeFromKey('FACT.something')).toBe('fact')
  })
})

describe('INFERABLE_NODE_TYPES', () => {
  it('contains exactly the 6 user-facing types', () => {
    expect(INFERABLE_NODE_TYPES).toHaveLength(6)
    expect(INFERABLE_NODE_TYPES).toContain('identity')
    expect(INFERABLE_NODE_TYPES).toContain('preference')
    expect(INFERABLE_NODE_TYPES).toContain('project')
    expect(INFERABLE_NODE_TYPES).toContain('decision')
    expect(INFERABLE_NODE_TYPES).toContain('fact')
    expect(INFERABLE_NODE_TYPES).toContain('episode')
  })

  it('does not contain system types', () => {
    const inferable = INFERABLE_NODE_TYPES as readonly string[]
    expect(inferable).not.toContain('moc')
    expect(inferable).not.toContain('index')
    expect(inferable).not.toContain('now')
    expect(inferable).not.toContain('reflection')
  })
})

// ---------------------------------------------------------------------------
// Phase 1: Tolerance improvements in parser
// ---------------------------------------------------------------------------

describe('parseObserverOutput — type recovery', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('recovers uppercase type "Identity"', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="Identity" priority="high"',
      `<canonical-key>identity.name</canonical-key>
       <title>User Name</title>
       <description>User prefers to be called John</description>
       <content>Call me John.</content>`,
    )}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.type).toBe('identity')
    }
  })

  it('recovers fully uppercase type "PREFERENCE"', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="PREFERENCE" priority="medium"',
      `<canonical-key>preference.dark_mode</canonical-key>
       <title>Dark Mode</title>
       <description>User prefers dark mode</description>
       <content>Dark mode preference.</content>`,
    )}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.type).toBe('preference')
    }
  })

  it('recovers plural type "Preferences"', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="Preferences" priority="low"',
      `<canonical-key>preference.editor</canonical-key>
       <title>Editor Pref</title>
       <description>Prefers vim</description>
       <content>Vim user.</content>`,
    )}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.type).toBe('preference')
    }
  })

  it('infers type from canonical-key prefix when type is unrecognizable', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="pref" priority="medium"',
      `<canonical-key>preference.theme</canonical-key>
       <title>Theme</title>
       <description>Prefers dark mode</description>
       <content>Dark mode.</content>`,
    )}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.type).toBe('preference')
    }
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('recovered type'))
  })

  it('infers type from plural key prefix "preferences."', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="pref" priority="medium"',
      `<canonical-key>preferences.theme</canonical-key>
       <title>Theme</title>
       <description>Prefers dark mode</description>
       <content>Dark mode.</content>`,
    )}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.type).toBe('preference')
    }
  })

  it('generates canonical-key from type + title when key is missing', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="fact" priority="medium"',
      `<title>TypeScript Is Typed</title>
       <description>TypeScript adds static types</description>
       <content>TS is typed.</content>`,
    )}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.canonicalKey).toBe('fact.typescript_is_typed')
    }
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('generated canonical-key'))
  })

  it('still rejects when type is unrecoverable and key prefix is unrecognizable', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="xyz" priority="high"',
      `<canonical-key>foobar.baz</canonical-key>
       <title>Title</title>
       <description>desc</description>
       <content>body</content>`,
    )}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
  })

  it('still rejects when both key and title are missing', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="fact" priority="high"',
      `<description>No key or title</description>
       <content>body</content>`,
    )}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing canonical-key and no title'))
  })

  it('recovers a mixed batch: valid + uppercase + missing key + truly invalid', () => {
    const valid = makeOperation(
      'type="fact" priority="medium"',
      `<canonical-key>fact.ts</canonical-key>
       <title>TS</title>
       <description>TypeScript fact</description>
       <content>body</content>`,
    )
    const uppercase = makeOperation(
      'type="IDENTITY" priority="high"',
      `<canonical-key>identity.name</canonical-key>
       <title>Name</title>
       <description>User name</description>
       <content>body</content>`,
    )
    const missingKey = makeOperation(
      'type="episode" priority="low"',
      `<title>Debug Session</title>
       <description>Debugging the parser</description>
       <content>body</content>`,
    )
    const invalid = makeOperation(
      'type="xyz" priority="medium"',
      `<canonical-key>unknown.thing</canonical-key>
       <title>Thing</title>
       <description>Unknown thing</description>
       <content>body</content>`,
    )
    const xml = makeXml(`<operations>${valid}${uppercase}${missingKey}${invalid}</operations>`)
    const output = parseObserverOutput(xml)
    // valid, uppercase, and missingKey should all be recovered; invalid should be dropped
    expect(output.operations).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// Phase 1: Tolerance improvements in parseExtractOutput
// ---------------------------------------------------------------------------

describe('parseExtractOutput — type recovery', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('recovers uppercase type in extract candidates', () => {
    const xml = `<observations>
<operations>
<operation type="DECISION" priority="high">
  <canonical-key>decision.use_react</canonical-key>
  <title>Use React</title>
  <description>Decided to use React</description>
  <content>React chosen.</content>
</operation>
</operations>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.type).toBe('decision')
  })

  it('infers type from key prefix in extract candidates', () => {
    const xml = `<observations>
<operations>
<operation type="pref" priority="low">
  <canonical-key>fact.something</canonical-key>
  <title>Something</title>
  <description>Some fact</description>
  <content>body</content>
</operation>
</operations>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.type).toBe('fact')
  })

  it('generates key from type + title when key is missing', () => {
    const xml = `<observations>
<operations>
<operation type="preference" priority="medium">
  <title>Dark Mode Setting</title>
  <description>User prefers dark mode</description>
  <content>Dark mode.</content>
</operation>
</operations>
</observations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.canonicalKey).toBe('preference.dark_mode_setting')
  })
})

// ---------------------------------------------------------------------------
// Phase 2: Structured diagnostics
// ---------------------------------------------------------------------------

describe('parseExtractOutputWithDiagnostics', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('returns diagnostics with correct counts on success', () => {
    const xml = `<observations>
<operations>
<operation type="fact" priority="medium">
  <canonical-key>fact.one</canonical-key>
  <title>One</title>
  <description>First fact</description>
  <content>body</content>
</operation>
<operation type="fact" priority="low">
  <canonical-key>fact.two</canonical-key>
  <title>Two</title>
  <description>Second fact</description>
  <content>body</content>
</operation>
</operations>
</observations>`
    const { output, diagnostics } = parseExtractOutputWithDiagnostics(xml)
    expect(output.candidates).toHaveLength(2)
    expect(diagnostics.totalCandidates).toBe(2)
    expect(diagnostics.accepted).toBe(2)
    expect(diagnostics.rejected).toHaveLength(0)
  })

  it('reports rejections with reasons and snippets', () => {
    const xml = `<observations>
<operations>
<operation type="xyz" priority="medium">
  <canonical-key>unknown.thing</canonical-key>
  <title>Thing</title>
  <description>Unknown type</description>
  <content>body</content>
</operation>
<operation type="fact" priority="medium">
  <canonical-key>fact.valid</canonical-key>
  <title>Valid</title>
  <description>Valid fact</description>
  <content>body</content>
</operation>
</operations>
</observations>`
    const { output, diagnostics } = parseExtractOutputWithDiagnostics(xml)
    expect(output.candidates).toHaveLength(1)
    expect(diagnostics.totalCandidates).toBe(2)
    expect(diagnostics.accepted).toBe(1)
    expect(diagnostics.rejected).toHaveLength(1)
    expect(diagnostics.rejected[0]!.reason).toContain('unknown type')
    expect(diagnostics.rejected[0]!.rawSnippet).toContain('xyz')
  })

  it('returns empty diagnostics for empty input', () => {
    const { output, diagnostics } = parseExtractOutputWithDiagnostics('')
    expect(output.candidates).toHaveLength(0)
    expect(diagnostics.totalCandidates).toBe(0)
    expect(diagnostics.accepted).toBe(0)
    expect(diagnostics.rejected).toHaveLength(0)
  })

  it('returns empty diagnostics for non-string input', () => {
    const { output, diagnostics } = parseExtractOutputWithDiagnostics(null as unknown as string)
    expect(output.candidates).toHaveLength(0)
    expect(diagnostics.totalCandidates).toBe(0)
  })

  it('includes recovered candidates in accepted count', () => {
    const xml = `<observations>
<operations>
<operation type="IDENTITY" priority="high">
  <canonical-key>identity.name</canonical-key>
  <title>Name</title>
  <description>User name</description>
  <content>body</content>
</operation>
</operations>
</observations>`
    const { diagnostics } = parseExtractOutputWithDiagnostics(xml)
    expect(diagnostics.totalCandidates).toBe(1)
    expect(diagnostics.accepted).toBe(1)
    expect(diagnostics.rejected).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Phase 3: Root element recovery
// ---------------------------------------------------------------------------

describe('parseObserverOutput — root element recovery', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    errorSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('recovers from <operations> root (no <observations> wrapper)', () => {
    const xml = `<operations>
<operation type="fact" priority="medium">
  <canonical-key>fact.recovered</canonical-key>
  <title>Recovered</title>
  <description>Recovered from alt root</description>
  <content>body</content>
</operation>
</operations>`
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.canonicalKey).toBe('fact.recovered')
    }
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('alternative root <operations>'))
  })

  it('recovers from <output> root wrapping <operations>', () => {
    const xml = `<output>
<operations>
<operation type="preference" priority="high">
  <canonical-key>preference.theme</canonical-key>
  <title>Theme</title>
  <description>Prefers dark</description>
  <content>Dark.</content>
</operation>
</operations>
</output>`
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('alternative root <output>'))
  })

  it('recovers from <response> root wrapping <operations>', () => {
    const xml = `<response>
<operations>
<operation type="fact" priority="low">
  <canonical-key>fact.resp</canonical-key>
  <title>Response Fact</title>
  <description>From response root</description>
  <content>body</content>
</operation>
</operations>
</response>`
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('alternative root <response>'))
  })

  it('prefers <observations> over alternative roots when both present', () => {
    const xml = `<observations>
<operations>
<operation type="fact" priority="high">
  <canonical-key>fact.primary</canonical-key>
  <title>Primary</title>
  <description>From primary root</description>
  <content>body</content>
</operation>
</operations>
</observations>
<response>
<operations>
<operation type="fact" priority="low">
  <canonical-key>fact.secondary</canonical-key>
  <title>Secondary</title>
  <description>From secondary root</description>
  <content>body</content>
</operation>
</operations>
</response>`
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    if (output.operations[0]!.kind === 'upsert') {
      expect(output.operations[0]!.canonicalKey).toBe('fact.primary')
    }
  })

  it('returns empty output when no root element matches', () => {
    const output = parseObserverOutput('<custom-root><data/></custom-root>')
    expect(output.operations).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no recognizable root'))
  })
})

describe('parseExtractOutput — root element recovery', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('recovers from bare <operations> root in extract', () => {
    const xml = `<operations>
<operation type="identity" priority="high">
  <canonical-key>identity.name</canonical-key>
  <title>Name</title>
  <description>User name preference</description>
  <content>body</content>
</operation>
</operations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]!.type).toBe('identity')
  })

  it('parseExtractOutputWithDiagnostics also recovers from alt roots', () => {
    const xml = `<operations>
<operation type="fact" priority="medium">
  <canonical-key>fact.alt</canonical-key>
  <title>Alt</title>
  <description>From alt root</description>
  <content>body</content>
</operation>
</operations>`
    const { output, diagnostics } = parseExtractOutputWithDiagnostics(xml)
    expect(output.candidates).toHaveLength(1)
    expect(diagnostics.accepted).toBe(1)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('alternative root'))
  })
})

// ---------------------------------------------------------------------------
// Combined recovery: multiple recovery mechanisms in one batch
// ---------------------------------------------------------------------------

describe('parser — combined recovery scenarios', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('recovers alt root + uppercase type + missing key in one batch', () => {
    const xml = `<operations>
<operation type="IDENTITY" priority="high">
  <title>User Name</title>
  <description>User prefers to be called John</description>
  <content>Call me John.</content>
</operation>
<operation type="Preference" priority="medium">
  <canonical-key>preference.theme</canonical-key>
  <title>Theme</title>
  <description>Dark mode preferred</description>
  <content>Dark mode.</content>
</operation>
</operations>`
    const result = parseExtractOutput(xml)
    expect(result.candidates).toHaveLength(2)
    // First candidate: alt root + uppercase type + key generated from title
    expect(result.candidates[0]!.type).toBe('identity')
    expect(result.candidates[0]!.canonicalKey).toBe('identity.user_name')
    // Second candidate: alt root + mixed-case type
    expect(result.candidates[1]!.type).toBe('preference')
  })
})
