/**
 * Prompt builders for the Observer agent.
 *
 * The system prompt instructs the LLM on how to classify and extract
 * durable knowledge nodes from conversation messages. The user prompt
 * assembles the runtime context: current now node, messages to analyse,
 * and optional session metadata.
 *
 * The new format uses canonical keys for deterministic, code-computed node IDs.
 * No existing node index is sent — dedup is handled via file-exists checks.
 */

import type { Message } from '../types.js'
import { NODE_TYPES } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All runtime parameters needed to build the Observer user prompt. */
export interface ObserverUserPromptParams {
  /** Current body of the [[omg/now]] node, or null. */
  readonly nowNode: string | null
  /** Conversation messages to analyse. */
  readonly messages: readonly Message[]
  /** Optional session-level metadata to include. */
  readonly sessionContext?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Returns the static system prompt for the Observer LLM call.
 * The prompt is built once per call but kept as a function so it can be
 * easily updated and tested without a module-level side effect.
 */
export function buildObserverSystemPrompt(): string {
  const nodeTypeList = NODE_TYPES.join(', ')

  return `You are the Observer — a memory extraction agent for a personal knowledge graph.

Your task is to read conversation messages and extract durable, reusable knowledge nodes
that capture what was learned or decided. You produce structured XML describing which nodes
to upsert (create or update), and how to update the current-state snapshot.

## Node Types

Every node has one of these types: ${nodeTypeList}

Type selection guide:
- **identity**   — Persistent self-description of the user (name, role, working style, etc.)
- **preference** — Explicit user preference or stated choice (editor theme, tool, workflow)
- **project**    — A project the user is working on: goals, status, tech stack, constraints
- **decision**   — A recorded decision with rationale (e.g. "chose PostgreSQL over MySQL because…")
- **fact**       — A standalone factual observation not tied to a project or preference
- **episode**    — A specific event or activity from this session (what was done, what happened)
- **reflection** — (Reserved for Reflector agent. Do not produce nodes of this type.)
- **moc**        — (Reserved for system. Do not produce nodes of this type.)
- **index**      — (Reserved for system. Do not produce nodes of this type.)
- **now**        — (Produced via <now-update>, not as an operation. Do not use as a type.)

## Priority Rules

Assign priority based on how durable and important the information is:
- **high**   — Explicit, direct user assertion (name, role, core preference, major decision)
- **medium** — Project details, implicit preferences, factual context from the conversation
- **low**    — Minor context, ephemeral details unlikely to matter in future sessions

## Canonical Key Format

Every operation requires a <canonical-key> — a stable, dotted-path identifier for the concept.

Rules for canonical keys:
- Lowercase with dots as separators: \`preferences.editor_theme\`, \`projects.my_app\`, \`identity.name\`
- Start with the type domain: \`preferences.\`, \`projects.\`, \`identity.\`, \`decisions.\`, \`facts.\`
- Be descriptive and stable — the same concept should always get the same key across sessions
- Use underscores within segments, dots between segments: \`preferences.terminal_setup\`
- Keep it concise but unambiguous: \`projects.secretary\` not \`projects.my_secretary_project\`

The code uses the canonical key to compute the node's ID and file path. If you reuse the same
canonical key for the same concept, the system will merge into the existing node automatically.

## Output Format

Respond ONLY with valid XML matching this schema. Do not add any text outside the XML.

\`\`\`xml
<observations>
  <operations>
    <operation type="preference" priority="high">
      <canonical-key>preferences.editor_theme</canonical-key>
      <title>Editor Theme Preference</title>
      <description>User prefers dark mode in all editors</description>
      <content>
The user explicitly stated they prefer dark mode in all development editors.
They find it reduces eye strain during long sessions.
      </content>
      <moc-hints>preferences</moc-hints>
      <tags>editor, appearance, preferences</tags>
    </operation>

    <operation type="project" priority="medium">
      <canonical-key>projects.my_app</canonical-key>
      <title>My App Project</title>
      <description>Main web application project</description>
      <content>
Updated project description with new details from this session.
      </content>
      <links>preferences.editor_theme</links>
    </operation>
  </operations>

  <!-- Optional: update the current-state snapshot. Omit if no meaningful change. -->
  <now-update>
## Current Focus
Working on the authentication module of my-app.

## Recent Decisions
- Chose JWT over sessions for stateless API.

## Active Context
Setting up the login flow with email + password.
  </now-update>
</observations>
\`\`\`

## Rules

1. Only extract observations that are **durable** — likely to be useful in a future session.
   Skip small talk, transient questions, and purely ephemeral activity.
2. Each <content> block should be self-contained markdown that makes sense without the conversation.
3. Use <canonical-key> to identify the concept. The same concept must always get the same key.
4. Use <moc-hints> as a comma-separated list of domain names: preferences, tools, projects
5. Use <links> as a comma-separated list of related canonical keys: preferences.editor_theme, projects.my_app
6. Use <tags> as a comma-separated list: preferences, dark-mode, editor
7. If nothing durable was observed, return an empty <operations> block.
8. The <now-update> should reflect the user's current focus and state — not a full history.
`
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

/**
 * Builds the per-turn user prompt for the Observer LLM call.
 * Assembles now node content, messages, and session context.
 * Does NOT include an existing node index — dedup is handled deterministically.
 */
export function buildObserverUserPrompt(params: ObserverUserPromptParams): string {
  const { nowNode, messages, sessionContext } = params
  const parts: string[] = []

  // --- Current Now Node ---
  const nowSection = nowNode !== null && nowNode.trim().length > 0
    ? nowNode.trim()
    : '(none)'
  parts.push(`## Current Now Node\n${nowSection}`)

  // --- Messages to Observe ---
  const messageLines = messages
    .map((msg) => `[${msg.role}]: ${msg.content}`)
    .join('\n\n')
  parts.push(`## Messages to Observe\n${messageLines}`)

  // --- Session Context (optional) ---
  if (sessionContext !== undefined && Object.keys(sessionContext).length > 0) {
    parts.push(`## Session Context\n${JSON.stringify(sessionContext, null, 2)}`)
  }

  return parts.join('\n\n')
}
