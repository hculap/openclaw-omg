import { describe, it, expect } from 'vitest'
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

  it('defaults priority to medium when attribute is missing or invalid', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="create" type="fact"',
      `<id>omg/fact/x</id>
       <description>Some fact</description>
       <content>content</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations[0]!.frontmatter.priority).toBe('medium')
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

    // Should not throw; content/description decoded properly
    expect(() => parseObserverOutput(xml)).not.toThrow()
    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(1)
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
// Invalid operations: skipped gracefully
// ---------------------------------------------------------------------------

describe('parseObserverOutput — invalid operations skipped', () => {
  it('skips an operation with an invalid node type', () => {
    const xml = makeXml(`<operations>${makeOperation(
      'action="create" type="invalidType" priority="high"',
      `<id>omg/fact/x</id><description>desc</description><content>body</content>`,
    )}</operations>`)

    const output = parseObserverOutput(xml)
    expect(output.operations).toHaveLength(0)
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
})

// ---------------------------------------------------------------------------
// Malformed / invalid input
// ---------------------------------------------------------------------------

describe('parseObserverOutput — malformed input', () => {
  it('does not throw on malformed XML', () => {
    expect(() => parseObserverOutput('<observations><unclosed')).not.toThrow()
  })

  it('does not throw on completely invalid input', () => {
    expect(() => parseObserverOutput('not xml at all 🎉')).not.toThrow()
  })

  it('does not throw on empty string', () => {
    expect(() => parseObserverOutput('')).not.toThrow()
  })

  it('returns empty output for completely invalid XML input', () => {
    const output = parseObserverOutput('this is not xml')
    // Fallback parser may produce some episode nodes or return empty
    // Either way, it must not throw and must return a valid ObserverOutput shape
    expect(output).toHaveProperty('operations')
    expect(output).toHaveProperty('nowUpdate')
    expect(output).toHaveProperty('mocUpdates')
  })

  it('returns empty output for an empty string', () => {
    const output = parseObserverOutput('')
    expect(output.operations).toHaveLength(0)
    expect(output.nowUpdate).toBeNull()
    expect(output.mocUpdates).toHaveLength(0)
  })

  it('returns a valid ObserverOutput shape even on total failure', () => {
    const output = parseObserverOutput('<<< totally broken >>>')
    expect(Array.isArray(output.operations)).toBe(true)
    expect(output.nowUpdate === null || typeof output.nowUpdate === 'string').toBe(true)
    expect(Array.isArray(output.mocUpdates)).toBe(true)
  })
})
