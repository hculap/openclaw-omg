import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseReflectorOutput, EMPTY_REFLECTOR_OUTPUT } from '../../src/reflector/parser.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReflectionXml(inner: string): string {
  return `<reflection>${inner}</reflection>`
}

const VALID_REFLECTION_NODE = `
  <reflection-nodes>
    <node compression-level="1">
      <id>omg/reflection/workflow-prefs</id>
      <description>Synthesised workflow preferences</description>
      <sources>omg/preference/dark-mode, omg/preference/vim</sources>
      <body>
## Workflow Preferences

User prefers command-line tools.
      </body>
    </node>
  </reflection-nodes>
`

const VALID_ARCHIVE_NODES = `
  <archive-nodes>
    <node-id>omg/preference/dark-mode</node-id>
    <node-id>omg/preference/vim</node-id>
  </archive-nodes>
`

const VALID_MOC_UPDATES = `
  <moc-updates>
    <moc domain="reflections" nodeId="omg/reflection/workflow-prefs" action="add" />
  </moc-updates>
`

const VALID_NODE_UPDATES = `
  <node-updates>
    <update targetId="omg/project/my-app" field="description" action="set">Updated description.</update>
  </node-updates>
`

// ---------------------------------------------------------------------------
// Valid XML — basic cases
// ---------------------------------------------------------------------------

describe('parseReflectorOutput — valid XML', () => {
  it('parses a complete reflection with all four sections', () => {
    const xml = makeReflectionXml(
      VALID_REFLECTION_NODE + VALID_ARCHIVE_NODES + VALID_MOC_UPDATES + VALID_NODE_UPDATES
    )
    const output = parseReflectorOutput(xml)

    expect(output.reflectionNodes).toHaveLength(1)
    expect(output.archiveNodeIds).toHaveLength(2)
    expect(output.mocUpdates).toHaveLength(1)
    expect(output.nodeUpdates).toHaveLength(1)
  })

  it('parses reflection node fields correctly', () => {
    const xml = makeReflectionXml(VALID_REFLECTION_NODE)
    const output = parseReflectorOutput(xml)

    const node = output.reflectionNodes[0]!
    expect(node.id).toBe('omg/reflection/workflow-prefs')
    expect(node.description).toBe('Synthesised workflow preferences')
    expect(node.compressionLevel).toBe(1)
    expect(node.sources).toContain('omg/preference/dark-mode')
    expect(node.sources).toContain('omg/preference/vim')
    expect(node.body).toContain('Workflow Preferences')
  })

  it('parses bilingual tags from reflection nodes', () => {
    const xml = makeReflectionXml(`
      <reflection-nodes>
        <node compression-level="2">
          <id>omg/reflection/family-overview</id>
          <description>Family structure overview — Przegląd struktury rodziny</description>
          <tags>family, rodzina, relationships, relacje, children, dzieci, partner, partnerka, identity, tożsamość</tags>
          <sources>omg/identity/wife, omg/identity/children</sources>
          <body>Family overview.</body>
        </node>
      </reflection-nodes>
    `)
    const output = parseReflectorOutput(xml)
    const node = output.reflectionNodes[0]!
    expect(node.tags).toContain('family')
    expect(node.tags).toContain('rodzina')
    expect(node.tags).toContain('dzieci')
    expect(node.tags).toHaveLength(10)
  })

  it('returns empty tags array when <tags> element is missing', () => {
    const xml = makeReflectionXml(VALID_REFLECTION_NODE)
    const output = parseReflectorOutput(xml)
    expect(output.reflectionNodes[0]!.tags).toEqual([])
  })

  it('parses archive node IDs correctly', () => {
    const xml = makeReflectionXml(VALID_ARCHIVE_NODES)
    const output = parseReflectorOutput(xml)

    expect(output.archiveNodeIds).toContain('omg/preference/dark-mode')
    expect(output.archiveNodeIds).toContain('omg/preference/vim')
  })

  it('deduplicates archive node IDs', () => {
    const xml = makeReflectionXml(`
      <archive-nodes>
        <node-id>omg/preference/dark-mode</node-id>
        <node-id>omg/preference/dark-mode</node-id>
      </archive-nodes>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.archiveNodeIds).toHaveLength(1)
    expect(output.archiveNodeIds[0]).toBe('omg/preference/dark-mode')
  })

  it('parses MOC update fields correctly', () => {
    const xml = makeReflectionXml(VALID_MOC_UPDATES)
    const output = parseReflectorOutput(xml)

    const moc = output.mocUpdates[0]!
    expect(moc.domain).toBe('reflections')
    expect(moc.nodeId).toBe('omg/reflection/workflow-prefs')
    expect(moc.action).toBe('add')
  })

  it('parses node update fields correctly', () => {
    const xml = makeReflectionXml(VALID_NODE_UPDATES)
    const output = parseReflectorOutput(xml)

    const update = output.nodeUpdates[0]!
    expect(update.targetId).toBe('omg/project/my-app')
    expect(update.field).toBe('description')
    expect(update.action).toBe('set')
    expect(update.value).toContain('Updated description')
  })

  it('defaults compression-level to 0 when attribute is missing or invalid', () => {
    const xml = makeReflectionXml(`
      <reflection-nodes>
        <node>
          <id>omg/reflection/no-level</id>
          <description>No compression level</description>
          <sources></sources>
          <body>Some body.</body>
        </node>
      </reflection-nodes>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.reflectionNodes[0]!.compressionLevel).toBe(0)
  })

  it('returns empty arrays for missing sections', () => {
    const xml = makeReflectionXml('')
    const output = parseReflectorOutput(xml)
    expect(output.reflectionNodes).toHaveLength(0)
    expect(output.archiveNodeIds).toHaveLength(0)
    expect(output.mocUpdates).toHaveLength(0)
    expect(output.nodeUpdates).toHaveLength(0)
  })

  it('parses multiple reflection nodes in order', () => {
    const xml = makeReflectionXml(`
      <reflection-nodes>
        <node compression-level="0">
          <id>omg/reflection/first</id>
          <description>First</description>
          <sources></sources>
          <body>First body.</body>
        </node>
        <node compression-level="2">
          <id>omg/reflection/second</id>
          <description>Second</description>
          <sources></sources>
          <body>Second body.</body>
        </node>
      </reflection-nodes>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.reflectionNodes).toHaveLength(2)
    expect(output.reflectionNodes[0]!.id).toBe('omg/reflection/first')
    expect(output.reflectionNodes[1]!.id).toBe('omg/reflection/second')
  })

  it('works when LLM wraps XML in ``` code fences', () => {
    const raw = `Here is the reflection:\n\`\`\`xml\n${makeReflectionXml(VALID_REFLECTION_NODE)}\n\`\`\``
    const output = parseReflectorOutput(raw)
    expect(output.reflectionNodes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Invalid/dropped records
// ---------------------------------------------------------------------------

describe('parseReflectorOutput — invalid records dropped with warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('drops reflection node with invalid ID format', () => {
    const xml = makeReflectionXml(`
      <reflection-nodes>
        <node compression-level="0">
          <id>INVALID ID!!!</id>
          <description>Some node</description>
          <sources></sources>
          <body>body</body>
        </node>
      </reflection-nodes>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.reflectionNodes).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid or missing id'))
  })

  it('drops reflection node with missing description', () => {
    const xml = makeReflectionXml(`
      <reflection-nodes>
        <node compression-level="0">
          <id>omg/reflection/no-desc</id>
          <sources></sources>
          <body>body</body>
        </node>
      </reflection-nodes>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.reflectionNodes).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing description'))
  })

  it('drops archive node with invalid ID format', () => {
    const xml = makeReflectionXml(`
      <archive-nodes>
        <node-id>NOT VALID///</node-id>
        <node-id>omg/preference/valid</node-id>
      </archive-nodes>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.archiveNodeIds).toHaveLength(1)
    expect(output.archiveNodeIds[0]).toBe('omg/preference/valid')
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid node ID'))
  })

  it('drops MOC update with missing domain', () => {
    const xml = makeReflectionXml(`
      <moc-updates>
        <moc nodeId="omg/reflection/test" action="add" />
      </moc-updates>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.mocUpdates).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('missing domain'))
  })

  it('drops MOC update with unknown action', () => {
    const xml = makeReflectionXml(`
      <moc-updates>
        <moc domain="reflections" nodeId="omg/reflection/test" action="upsert" />
      </moc-updates>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.mocUpdates).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown action'))
  })

  it('drops node-update with unknown field', () => {
    const xml = makeReflectionXml(`
      <node-updates>
        <update targetId="omg/fact/some-fact" field="nonexistent" action="set">value</update>
      </node-updates>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.nodeUpdates).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown field'))
  })

  it('drops node-update with unknown action', () => {
    const xml = makeReflectionXml(`
      <node-updates>
        <update targetId="omg/fact/some-fact" field="description" action="replace">value</update>
      </node-updates>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.nodeUpdates).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown action'))
  })

  it('drops node-update with invalid targetId', () => {
    const xml = makeReflectionXml(`
      <node-updates>
        <update targetId="INVALID ID" field="description" action="set">value</update>
      </node-updates>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.nodeUpdates).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('invalid or missing targetId'))
  })

  it('warns when reflection node has fewer than 10 tags', () => {
    const xml = makeReflectionXml(`
      <reflection-nodes>
        <node compression-level="1">
          <id>omg/reflection/few-tags</id>
          <description>Node with few tags</description>
          <tags>one, two, three</tags>
          <sources>omg/preference/dark-mode</sources>
          <body>Some body.</body>
        </node>
      </reflection-nodes>
    `)
    const output = parseReflectorOutput(xml)
    expect(output.reflectionNodes).toHaveLength(1)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('has 3 tags (recommended minimum: 10)')
    )
  })
})

// ---------------------------------------------------------------------------
// Malformed / invalid input
// ---------------------------------------------------------------------------

describe('parseReflectorOutput — malformed input', () => {
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
    expect(() => parseReflectorOutput('<reflection><unclosed')).not.toThrow()
  })

  it('does not throw on completely invalid input', () => {
    expect(() => parseReflectorOutput('not xml at all 🎉')).not.toThrow()
  })

  it('does not throw on empty string', () => {
    expect(() => parseReflectorOutput('')).not.toThrow()
  })

  it('returns empty output for empty string and logs a warning', () => {
    const output = parseReflectorOutput('')
    expect(output.reflectionNodes).toHaveLength(0)
    expect(output.archiveNodeIds).toHaveLength(0)
    expect(output.mocUpdates).toHaveLength(0)
    expect(output.nodeUpdates).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('empty response'))
  })

  it('returns empty output when <reflection> root is missing and logs an error', () => {
    const output = parseReflectorOutput('<result><nothing/></result>')
    expect(output.reflectionNodes).toHaveLength(0)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('<reflection>'))
  })

  it('returns a valid shape on any failure', () => {
    const output = parseReflectorOutput('<<< totally broken >>>')
    expect(Array.isArray(output.reflectionNodes)).toBe(true)
    expect(Array.isArray(output.archiveNodeIds)).toBe(true)
    expect(Array.isArray(output.mocUpdates)).toBe(true)
    expect(Array.isArray(output.nodeUpdates)).toBe(true)
  })

  it('EMPTY_REFLECTOR_OUTPUT has all required array properties', () => {
    expect(Array.isArray(EMPTY_REFLECTOR_OUTPUT.reflectionNodes)).toBe(true)
    expect(Array.isArray(EMPTY_REFLECTOR_OUTPUT.archiveNodeIds)).toBe(true)
    expect(Array.isArray(EMPTY_REFLECTOR_OUTPUT.mocUpdates)).toBe(true)
    expect(Array.isArray(EMPTY_REFLECTOR_OUTPUT.nodeUpdates)).toBe(true)
  })
})
