import { describe, it, expect } from 'vitest'
import { buildObserverSystemPrompt, buildObserverUserPrompt } from '../../src/observer/prompts.js'
import { NODE_TYPES } from '../../src/types.js'
import type { NodeIndexEntry, Message } from '../../src/types.js'

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

describe('buildObserverSystemPrompt', () => {
  it('returns a non-empty string', () => {
    const prompt = buildObserverSystemPrompt()
    expect(typeof prompt).toBe('string')
    expect(prompt.length).toBeGreaterThan(0)
  })

  it('includes all NodeType names', () => {
    const prompt = buildObserverSystemPrompt()
    for (const type of NODE_TYPES) {
      expect(prompt).toContain(type)
    }
  })

  it('includes action keywords create, update, supersede', () => {
    const prompt = buildObserverSystemPrompt()
    expect(prompt).toContain('create')
    expect(prompt).toContain('update')
    expect(prompt).toContain('supersede')
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

  it('includes wikilink format instruction', () => {
    const prompt = buildObserverSystemPrompt()
    expect(prompt).toContain('[[')
    expect(prompt).toContain(']]')
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

  const makeIndex = (...entries: [string, string][]): readonly NodeIndexEntry[] =>
    entries.map(([id, description]) => ({ id, description }))

  it('includes node IDs from the existing index', () => {
    const prompt = buildObserverUserPrompt({
      existingNodeIndex: makeIndex(
        ['omg/preference/dark-mode', 'User prefers dark mode'],
        ['omg/project/my-app', 'Main web application'],
      ),
      nowNode: null,
      messages: makeMessages('Hello'),
    })

    expect(prompt).toContain('omg/preference/dark-mode')
    expect(prompt).toContain('omg/project/my-app')
  })

  it('includes node descriptions from the existing index', () => {
    const prompt = buildObserverUserPrompt({
      existingNodeIndex: makeIndex(['omg/fact/test', 'A test fact']),
      nowNode: null,
      messages: makeMessages('Hello'),
    })

    expect(prompt).toContain('A test fact')
  })

  it('shows (none) for empty existing index', () => {
    const prompt = buildObserverUserPrompt({
      existingNodeIndex: [],
      nowNode: null,
      messages: makeMessages('Hello'),
    })

    expect(prompt).toContain('(none)')
  })

  it('includes messages with correct role formatting', () => {
    const prompt = buildObserverUserPrompt({
      existingNodeIndex: [],
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
      existingNodeIndex: [],
      nowNode: '## Current Focus\nWorking on auth module',
      messages: makeMessages('Hello'),
    })

    expect(prompt).toContain('Working on auth module')
  })

  it('shows (none) for null nowNode', () => {
    const prompt = buildObserverUserPrompt({
      existingNodeIndex: [],
      nowNode: null,
      messages: makeMessages('Hello'),
    })

    expect(prompt).toContain('(none)')
  })

  it('shows (none) for empty string nowNode', () => {
    const prompt = buildObserverUserPrompt({
      existingNodeIndex: [],
      nowNode: '   ',
      messages: makeMessages('Hello'),
    })

    expect(prompt).toContain('(none)')
  })

  it('includes session context as JSON when provided', () => {
    const prompt = buildObserverUserPrompt({
      existingNodeIndex: [],
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
      existingNodeIndex: [],
      nowNode: null,
      messages: makeMessages('Hello'),
    })

    expect(prompt).not.toContain('Session Context')
  })

  it('omits session context section when empty object provided', () => {
    const prompt = buildObserverUserPrompt({
      existingNodeIndex: [],
      nowNode: null,
      messages: makeMessages('Hello'),
      sessionContext: {},
    })

    expect(prompt).not.toContain('Session Context')
  })

  it('contains all required section headers', () => {
    const prompt = buildObserverUserPrompt({
      existingNodeIndex: makeIndex(['omg/fact/x', 'X']),
      nowNode: 'now content',
      messages: makeMessages('msg'),
    })

    expect(prompt).toContain('## Existing Node Index')
    expect(prompt).toContain('## Current Now Node')
    expect(prompt).toContain('## Messages to Observe')
  })
})
