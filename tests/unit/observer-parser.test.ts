import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseObserverOutput, parseExtractOutput } from '../../src/observer/parser.js'

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

  it('skips an operation with missing canonical-key and logs a warning', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'type="fact" priority="medium"',
      `<title>Some Fact</title>
       <description>desc</description>
       <content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing canonical-key'))
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

  it('logs a warning with the count of skipped operations', () => {
    const badOp = makeOperation(
      'type="not-a-type" priority="high"',
      `<canonical-key>some.key</canonical-key>
       <title>Title</title>
       <description>bad</description>
       <content>body</content>`,
    )
    const xml = makeXml(`<operations>${badOp}${badOp}${VALID_UPSERT_PREFERENCE}</operations>`)

    parseObserverOutput(xml)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipped 2'))
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

  it('returns empty output when <observations> root is missing and logs an error', () => {
    const output = parseObserverOutput('<result><nothing/></result>')
    expect(output.operations).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('<observations>'))
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

  it('drops candidates with missing canonical-key', () => {
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
