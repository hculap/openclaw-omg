import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseObserverOutput } from '../../src/observer/parser.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeXml(inner: string): string {
  return `<observations>${inner}</observations>`
}

function makeOperation(attrs: string, children: string): string {
  return `<operation ${attrs}>${children}</operation>`
}

const VALID_CREATE = makeOperation(
  'action="create" type="preference" priority="high"',
  `<id>omg/preference/dark-mode</id>
   <description>User prefers dark mode</description>
   <content>The user prefers dark mode in all editors.</content>`,
)

const VALID_UPDATE = makeOperation(
  'action="update" type="project" priority="medium"',
  `<target-id>omg/project/my-app</target-id>
   <id>omg/project/my-app</id>
   <description>Main web app project</description>
   <content>Updated details about the project.</content>`,
)

const VALID_SUPERSEDE = makeOperation(
  'action="supersede" type="preference" priority="high"',
  `<target-id>omg/preference/light-mode</target-id>
   <id>omg/preference/dark-mode-2026</id>
   <description>User switched to dark mode</description>
   <content>User now prefers dark mode after finding it easier on the eyes.</content>`,
)

// ---------------------------------------------------------------------------
// Valid XML: basic cases
// ---------------------------------------------------------------------------

describe('parseObserverOutput — valid XML', () => {
  it('parses a single create operation correctly', () => {
    const xml = makeXml(`<operations>${VALID_CREATE}</operations>`)
    const output = parseObserverOutput(xml)

    expect(output.operations).toHaveLength(1)
    const op = output.operations[0]!
    expect(op.kind).toBe('create')
    expect(op.frontmatter.id).toBe('omg/preference/dark-mode')
    expect(op.frontmatter.description).toBe('User prefers dark mode')
    expect(op.frontmatter.type).toBe('preference')
    expect(op.frontmatter.priority).toBe('high')
    expect(op.body).toBe('The user prefers dark mode in all editors.')
  })

  it('parses an update operation with targetId', () => {
    const xml = makeXml(`<operations>${VALID_UPDATE}</operations>`)
    const output = parseObserverOutput(xml)

    expect(output.operations).toHaveLength(1)
    const op = output.operations[0]!
    expect(op.kind).toBe('update')
    if (op.kind === 'update') {
      expect(op.targetId).toBe('omg/project/my-app')
    }
  })

  it('parses a supersede operation with targetId', () => {
    const xml = makeXml(`<operations>${VALID_SUPERSEDE}</operations>`)
    const output = parseObserverOutput(xml)

    expect(output.operations).toHaveLength(1)
    const op = output.operations[0]!
    expect(op.kind).toBe('supersede')
    if (op.kind === 'supersede') {
      expect(op.targetId).toBe('omg/preference/light-mode')
      expect(op.frontmatter.id).toBe('omg/preference/dark-mode-2026')
    }
  })

  it('parses multiple operations in order', () => {
    const xml = makeXml(`<operations>${VALID_CREATE}${VALID_UPDATE}</operations>`)
    const output = parseObserverOutput(xml)

    expect(output.operations).toHaveLength(2)
    expect(output.operations[0]!.kind).toBe('create')
    expect(output.operations[1]!.kind).toBe('update')
  })

  it('defaults priority to medium when attribute is missing', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="create" type="fact"',
      `<id>omg/fact/x</id>
       <description>Some fact</description>
       <content>content</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations[0]!.frontmatter.priority).toBe('medium')
  })

  it('defaults priority to medium when priority attribute is an unrecognised value', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="create" type="fact" priority="urgent"',
      `<id>omg/fact/x</id>
       <description>Some fact</description>
       <content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations[0]!.frontmatter.priority).toBe('medium')
  })

  it('all operations from one parse call share the same created/updated timestamp', () => {
    const xml = makeXml(`<operations>${VALID_CREATE}${VALID_UPDATE}</operations>`)
    const output = parseObserverOutput(xml)

    expect(output.operations).toHaveLength(2)
    expect(output.operations[0]!.frontmatter.created).toBe(output.operations[1]!.frontmatter.created)
    expect(output.operations[0]!.frontmatter.updated).toBe(output.operations[1]!.frontmatter.updated)
  })

  it('sets created and updated to ISO 8601 timestamps', () => {
    const xml = makeXml(`<operations>${VALID_CREATE}</operations>`)
    const output = parseObserverOutput(xml)

    const fm = output.operations[0]!.frontmatter
    expect(fm.created).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(fm.updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('parses <links> into an array of wikilink targets', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="create" type="preference" priority="high"',
      `<id>omg/preference/vim</id>
       <description>User uses vim</description>
       <content>content</content>
       <links>[[omg/moc-preferences]] [[omg/moc-tools]]</links>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    const links = output.operations[0]!.frontmatter.links
    expect(links).toContain('omg/moc-preferences')
    expect(links).toContain('omg/moc-tools')
  })

  it('parses <tags> into a trimmed array', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="create" type="preference" priority="medium"',
      `<id>omg/preference/terminal</id>
       <description>Uses terminal</description>
       <content>content</content>
       <tags>editor, tooling,  terminal </tags>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    const tags = output.operations[0]!.frontmatter.tags
    expect(tags).toEqual(expect.arrayContaining(['editor', 'tooling', 'terminal']))
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
    const xml = makeXml(`<operations>${VALID_CREATE}</operations>`)
    const output = parseObserverOutput(xml)
    expect(output.nowUpdate).toBeNull()
  })

  it('returns nowUpdate: null when <now-update> is empty', () => {
    const xml = makeXml(`<operations></operations><now-update>   </now-update>`)
    const output = parseObserverOutput(xml)
    expect(output.nowUpdate).toBeNull()
  })

  it('parses <moc-updates> into an array of domain strings', () => {
    const xml = makeXml(`
      <operations></operations>
      <moc-updates>
        <moc domain="preferences" action="add" />
        <moc domain="projects" action="add" />
      </moc-updates>
    `)
    const output = parseObserverOutput(xml)
    expect(output.mocUpdates).toContain('preferences')
    expect(output.mocUpdates).toContain('projects')
  })

  it('parses a single <moc> element as an array (isArray guard)', () => {
    const xml = makeXml(`
      <operations></operations>
      <moc-updates>
        <moc domain="preferences" action="add" />
      </moc-updates>
    `)
    const output = parseObserverOutput(xml)
    expect(output.mocUpdates).toHaveLength(1)
    expect(output.mocUpdates[0]).toBe('preferences')
  })

  it('deduplicates repeated MOC domains', () => {
    const xml = makeXml(`
      <operations></operations>
      <moc-updates>
        <moc domain="preferences" action="add" />
        <moc domain="preferences" action="add" />
      </moc-updates>
    `)
    const output = parseObserverOutput(xml)
    const prefCount = output.mocUpdates.filter((d) => d === 'preferences').length
    expect(prefCount).toBe(1)
  })

  it('returns empty mocUpdates when <moc-updates> is absent', () => {
    const xml = makeXml(`<operations></operations>`)
    const output = parseObserverOutput(xml)
    expect(output.mocUpdates).toHaveLength(0)
  })

  it('handles XML with HTML entities (&amp;, &quot;) correctly', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="create" type="fact" priority="low"',
      `<id>omg/fact/ampersand</id>
       <description>AT&amp;T fact</description>
       <content>Content with &quot;quotes&quot; and &amp; ampersand.</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    expect(output.operations[0]!.frontmatter.description).toContain('AT&T fact')
  })

  it('returns empty operations array for empty <operations> block', () => {
    const xml = makeXml(`<operations></operations>`)
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
    expect(output.nowUpdate).toBeNull()
    expect(output.mocUpdates).toHaveLength(0)
  })

  it('works when LLM wraps XML in ``` code fences', () => {
    const raw = `Here is my analysis:\n\`\`\`xml\n${makeXml(`<operations>${VALID_CREATE}</operations>`)}\n\`\`\``
    const output = parseObserverOutput(raw)
    expect(output.operations).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Invalid operations: skipped with warning
// ---------------------------------------------------------------------------

describe('parseObserverOutput — invalid operations skipped', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('skips an operation with an invalid node type and logs a warning', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="create" type="invalidType" priority="high"',
      `<id>omg/fact/x</id><description>desc</description><content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipped 1'))
  })

  it('skips an operation with an invalid action', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="delete" type="fact" priority="high"',
      `<id>omg/fact/x</id><description>desc</description><content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
  })

  it('skips an update operation with missing target-id', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="update" type="fact" priority="medium"',
      `<id>omg/fact/x</id><description>desc</description><content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
  })

  it('skips a supersede operation with missing target-id', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="supersede" type="preference" priority="high"',
      `<id>omg/preference/new</id><description>new desc</description><content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
  })

  it('skips an operation with missing id', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="create" type="fact" priority="medium"',
      `<description>desc</description><content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
  })

  it('skips an operation with missing description', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="create" type="fact" priority="medium"',
      `<id>omg/fact/x</id><content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
  })

  it('still returns valid operations when mixed with invalid ones', () => {
    const badOp = makeOperation(
      'action="create" type="not-a-type" priority="high"',
      `<id>omg/fact/bad</id><description>bad</description><content>body</content>`,
    )
    const xml = makeXml(`<operations>${badOp}${VALID_CREATE}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
    expect(output.operations[0]!.kind).toBe('create')
  })

  it('logs a warning with the count of skipped operations', () => {
    const badOp = makeOperation(
      'action="create" type="not-a-type" priority="high"',
      `<id>omg/fact/bad</id><description>bad</description><content>body</content>`,
    )
    const xml = makeXml(`<operations>${badOp}${badOp}${VALID_CREATE}</operations>`)

    parseObserverOutput(xml)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('skipped 2'))
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
    // Force a parse failure by feeding something that looks XML-ish but breaks the parser
    parseObserverOutput('<observations')
    expect(errorSpy).toHaveBeenCalled()
  })
})
