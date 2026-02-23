import { describe, it, expect } from 'vitest'
import { buildObserverSystemPrompt, buildObserverUserPrompt } from '../../src/observer/prompts.js'
import { NODE_TYPES } from '../../src/types.js'
import type { Message } from '../../src/types.js'

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

describe('buildObserverSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildObserverSystemPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  it('includes all NodeType names (derived from NODE_TYPES at call time)', () => {
    const prompt = buildObserverSystemPrompt()
    for (const type of NODE_TYPES) {
      expect(prompt).toContain(type)
    }
  })

  it('includes canonical-key format instructions', () => {
    const prompt = buildObserverSystemPrompt()
    expect(prompt).toContain('canonical-key')
  })

  it('includes priority keywords high, medium, low', () => {
    const prompt = buildObserverSystemPrompt()
    expect(prompt).toContain('high')
    expect(prompt).toContain('medium')
    expect(prompt).toContain('low')
  })

  it('includes XML schema example with <observations> element', () => {
    const prompt = buildObserverSystemPrompt()
    expect(prompt).toContain('<observations>')
    expect(prompt).toContain('<operations>')
    expect(prompt).toContain('<operation')
  })

  it('includes <now-update> in the schema', () => {
    const prompt = buildObserverSystemPrompt()
    expect(prompt).toContain('now-update')
  })

  it('does NOT include the old existingNodeIndex / action / supersede instructions', () => {
    const prompt = buildObserverSystemPrompt()
    // New format uses only upsert — no create/update/supersede action attributes
    expect(prompt).not.toContain('action="create"')
    expect(prompt).not.toContain('action="update"')
    expect(prompt).not.toContain('action="supersede"')
    // No node index scanning instruction
    expect(prompt).not.toContain('existing node index')
  })

  it('includes <canonical-key> in the XML schema example', () => {
    const prompt = buildObserverSystemPrompt()
    expect(prompt).toContain('<canonical-key>')
  })

  it('includes <moc-hints> in the schema', () => {
    const prompt = buildObserverSystemPrompt()
    expect(prompt).toContain('moc-hints')
  })
})

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

describe('buildObserverUserPrompt', () => {
  const makeMessages = (...contents: string[]): readonly Message[] =>
    contents.map((content, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content,
    }))

  it('includes messages with correct role formatting', () => {
    const prompt = buildObserverUserPrompt({
      nowNode: null,
      messages: [
        { role: 'user', content: 'I prefer TypeScript' },
        { role: 'assistant', content: 'Noted!' },
      ],
    })

    expect(prompt).toContain('[user]: I prefer TypeScript')
    expect(prompt).toContain('[assistant]: Noted!')
  })

  it('includes the now node content when provided', () => {
    const prompt = buildObserverUserPrompt({
      nowNode: '## Current Focus\nWorking on auth module',
      messages: makeMessages('Hello'),
    })

    expect(prompt).toContain('Working on auth module')
  })

  it('shows (none) for null nowNode', () => {
    const prompt = buildObserverUserPrompt({
      nowNode: null,
      messages: makeMessages('Hello'),
    })

    expect(prompt).toContain('(none)')
  })

  it('shows (none) for empty string nowNode', () => {
    const prompt = buildObserverUserPrompt({
      nowNode: '   ',
      messages: makeMessages('Hello'),
    })

    expect(prompt).toContain('(none)')
  })

  it('includes session context as JSON when provided', () => {
    const prompt = buildObserverUserPrompt({
      nowNode: null,
      messages: makeMessages('Hello'),
      sessionContext: { agentId: 'agent-123', workspace: '/home/user' },
    })

    expect(prompt).toContain('agentId')
    expect(prompt).toContain('agent-123')
    expect(prompt).toContain('workspace')
  })

  it('omits session context section when not provided', () => {
    const prompt = buildObserverUserPrompt({
      nowNode: null,
      messages: makeMessages('Hello'),
    })

    expect(prompt).not.toContain('Session Context')
  })

  it('omits session context section when empty object provided', () => {
    const prompt = buildObserverUserPrompt({
      nowNode: null,
      messages: makeMessages('Hello'),
      sessionContext: {},
    })

    expect(prompt).not.toContain('Session Context')
  })

  it('does NOT include an existing node index section', () => {
    const prompt = buildObserverUserPrompt({
      nowNode: null,
      messages: makeMessages('Hello'),
    })

    expect(prompt).not.toContain('Existing Node Index')
    expect(prompt).not.toContain('existingNodeIndex')
  })

  it('contains required section headers', () => {
    const prompt = buildObserverUserPrompt({
      nowNode: 'now content',
      messages: makeMessages('msg'),
    })

    expect(prompt).toContain('## Current Now Node')
    expect(prompt).toContain('## Messages to Observe')
  })

  it('orders sections: now node → messages → session context', () => {
    const prompt = buildObserverUserPrompt({
      nowNode: 'now content',
      messages: makeMessages('msg'),
      sessionContext: { key: 'val' },
    })

    const nowPos = prompt.indexOf('## Current Now Node')
    const msgPos = prompt.indexOf('## Messages to Observe')
    const ctxPos = prompt.indexOf('## Session Context')

    expect(nowPos).toBeLessThan(msgPos)
    expect(msgPos).toBeLessThan(ctxPos)
  })
})
