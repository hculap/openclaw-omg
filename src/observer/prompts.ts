/**
 * Prompt builders for the Observer agent.
 *
 * The system prompt instructs the LLM on how to classify and extract
 * durable knowledge nodes from conversation messages. The user prompt
 * assembles the runtime context: existing node index, current now node,
 * messages to analyse, and optional session metadata.
 */

import type { NodeIndexEntry, Message } from '../types.js'
import { NODE_TYPES } from '../types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All runtime parameters needed to build the Observer user prompt. */
export interface ObserverUserPromptParams {
  /** Compact index of nodes already in the graph. */
  readonly existingNodeIndex: readonly NodeIndexEntry[]
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
to create, update, or supersede, and how to update the current-state snapshot.

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

## Action Rules

Choose the right action for each node:

**create** — The information is new; no existing node covers it.
  Provide: id, description, content, and optionally links, tags.

**update** — An existing node covers the same topic; the content should be augmented or corrected.
  Provide: target-id (the existing node's ID), id (can be same as target-id), description, content.
  Use update when the existing node is still valid but incomplete or needs minor correction.

**supersede** — An existing node is outdated or contradicted; replace it entirely.
  Provide: target-id (the ID of the node being replaced), a new id, description, content.
  Use supersede when the old node should no longer be used (e.g. the user changed their preference).

## Node IDs

Node IDs use the format: omg/{type}/{slug}
Where slug is lowercase, hyphenated, and concise (e.g. omg/preference/editor-theme).
For update operations, the id in <id> can match the target-id.
For supersede operations, use a fresh slug that reflects the updated content.

## Output Format

Respond ONLY with valid XML matching this schema. Do not add any text outside the XML.

\`\`\`xml
<observations>
  <operations>
    <!-- For a create operation: -->
    <operation action="create" type="preference" priority="high">
      <id>omg/preference/editor-theme</id>
      <description>User prefers dark mode in all editors</description>
      <content>
The user explicitly stated they prefer dark mode in all development editors.
They find it reduces eye strain during long sessions.
      </content>
      <links>[[omg/moc-preferences]]</links>
      <tags>editor, appearance, preferences</tags>
    </operation>

    <!-- For an update operation: -->
    <operation action="update" type="project" priority="medium">
      <target-id>omg/project/my-app</target-id>
      <id>omg/project/my-app</id>
      <description>Main web application project</description>
      <content>
Updated project description with new details from this session.
      </content>
    </operation>

    <!-- For a supersede operation: -->
    <operation action="supersede" type="preference" priority="high">
      <target-id>omg/preference/old-editor-theme</target-id>
      <id>omg/preference/editor-theme-2026</id>
      <description>User switched from dark mode to high-contrast theme</description>
      <content>
The user now prefers a high-contrast theme after finding it easier to read.
      </content>
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

  <!-- Optional: list MOC domains affected. Omit if no nodes touch a MOC. -->
  <moc-updates>
    <moc domain="preferences" action="add" />
    <moc domain="project-my-app" action="add" />
  </moc-updates>
</observations>
\`\`\`

## Rules

1. Only extract observations that are **durable** — likely to be useful in a future session.
   Skip small talk, transient questions, and purely ephemeral activity.
2. Each <content> block should be self-contained markdown that makes sense without the conversation.
3. Use <links> to reference related nodes with wikilink syntax: [[omg/node-id]].
   Separate multiple links with spaces or newlines: [[omg/id-one]] [[omg/id-two]]
4. Use <tags> as a comma-separated list: preferences, dark-mode, editor
5. Do not invent node IDs that are not in the existing index. Only reference nodes you know exist.
6. If nothing durable was observed, return an empty <operations> block.
7. The <now-update> should reflect the user's current focus and state — not a full history.
`
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

/**
 * Builds the per-turn user prompt for the Observer LLM call.
 * Assembles existing node index, now node content, messages, and session context.
 */
export function buildObserverUserPrompt(params: ObserverUserPromptParams): string {
  const { existingNodeIndex, nowNode, messages, sessionContext } = params
  const parts: string[] = []

  // --- Existing Node Index ---
  if (existingNodeIndex.length === 0) {
    parts.push('## Existing Node Index\n(none)')
  } else {
    const indexLines = existingNodeIndex
      .map((entry) => `- ${entry.id}: ${entry.description}`)
      .join('\n')
    parts.push(`## Existing Node Index\n${indexLines}`)
  }

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
