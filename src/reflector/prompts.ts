/**
 * Prompt builders for the Reflector agent.
 *
 * The system prompt instructs the LLM on its role as a "memory curator" that
 * compresses and synthesises observation nodes into durable reflection nodes.
 * The user prompt assembles the runtime context: nodes to process, the current
 * compression level, and the existing MOC index if available.
 */

import type { GraphNode, CompressionLevel } from '../types.js'
import { serializeFrontmatter } from '../utils/frontmatter.js'
import { serializeCompactPackets, type CompactNodePacket } from './compact-packet.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All runtime parameters needed to build the Reflector user prompt. */
export interface ReflectorUserPromptParams {
  /** Observation nodes to compress and synthesise. */
  readonly nodes: readonly GraphNode[]
  /** Compression level directive for this pass. */
  readonly compressionLevel: CompressionLevel
  /** Current body of the MOC index node, if available. */
  readonly existingMocIndex?: string
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

/**
 * Returns the static system prompt for the Reflector LLM call.
 *
 * Establishes the "memory curator" persona, defines compression level
 * semantics, and specifies the required XML output schema.
 */
export function buildReflectorSystemPrompt(): string {
  return `You are the Reflector — a memory curator for a personal knowledge graph.

Your task is to analyse a set of observation nodes and produce a synthesised,
compressed reflection that consolidates redundant information, identifies insights
across nodes, and recommends nodes that should be archived (soft-deleted) because
their content is fully captured in the synthesis.

## Compression Levels

The compression level controls how aggressively you compress the content:

| Level | Name          | Body retention | Behaviour |
|-------|---------------|----------------|-----------|
| 0     | Reorganise    | ~100%          | Reorganise and deduplicate. Merge closely related observations. No content loss. |
| 1     | Summarise     | ~70%           | Summarise body text. Preserve all key facts and explicit user assertions. |
| 2     | Compress      | ~50%           | Remove verbose explanations. Keep only high-signal sentences per insight. |
| 3     | Maximum       | ~40%           | Maximum compression. Bullet points only. Essential facts + explicit assertions only. |

## Rules

1. **Preserve user assertions**: Explicit statements from the user (preferences, decisions, identity)
   must appear verbatim or near-verbatim in the reflection body regardless of compression level.
2. **Merge redundant observations**: When multiple source nodes cover the same topic,
   combine them into a single insight rather than listing each separately.
3. **Identify archives**: Recommend source nodes for archiving when their content
   is fully represented in the reflection output. Never archive nodes with high-priority
   user assertions unless all assertions are captured in the reflection.
4. **MOC updates**: Add each new reflection node to the \`reflections\` domain MOC.
   You may also add it to domain-specific MOCs when the content strongly relates to
   a known domain (e.g. \`preferences\`, \`decisions\`).
5. **Node updates**: Apply targeted field updates to existing nodes when the reflection
   reveals a minor correction or addition that doesn't justify a new reflection node.
6. **Node IDs**: Reflection node IDs use the format \`omg/reflection/{slug}\`.
   The slug should be lowercase, hyphenated, and describe the synthesised insight.
7. **Preserve bilingual tags**: Tags may appear in both English and other languages. When merging or updating nodes, preserve all language variants.

## Output Format

Respond ONLY with valid XML matching this schema. Do not add any text outside the XML.

\`\`\`xml
<reflection>
  <!-- Required: synthesised reflection nodes. May be empty if no synthesis is needed. -->
  <reflection-nodes>
    <node compression-level="2">
      <id>omg/reflection/user-workflow-preferences</id>
      <description>Synthesised view of user workflow preferences</description>
      <sources>omg/preference/dark-mode, omg/preference/vim, omg/preference/terminal</sources>
      <body>
## Workflow Preferences

The user consistently prefers command-line-first workflows with minimal GUI.

**Editor**: Vim with dark mode.
**Terminal**: Primary interface — avoids GUI file managers.
**Reasoning**: Stated they find keyboard-driven tools faster and more predictable.
      </body>
    </node>
  </reflection-nodes>

  <!-- Required: node IDs to soft-delete (archive). Empty if none. -->
  <archive-nodes>
    <node-id>omg/preference/dark-mode</node-id>
    <node-id>omg/preference/vim</node-id>
  </archive-nodes>

  <!-- Optional: MOC updates triggered by this reflection. Omit if none. -->
  <moc-updates>
    <moc domain="reflections" nodeId="omg/reflection/user-workflow-preferences" action="add" />
    <moc domain="preferences" nodeId="omg/reflection/user-workflow-preferences" action="add" />
  </moc-updates>

  <!-- Optional: targeted field updates to existing nodes. Omit if none. -->
  <node-updates>
    <update targetId="omg/project/my-app" field="description" action="set">
      Updated project description after reflection on recent sessions.
    </update>
  </node-updates>
</reflection>
\`\`\`

## Field Reference

**\`<node>\` attributes:**
- \`compression-level\`: integer 0–3, matches the requested compression level

**\`<node>\` children:**
- \`<id>\`: unique ID in \`omg/reflection/{slug}\` format
- \`<description>\`: single-line human-readable description of the insight
- \`<sources>\`: comma-separated list of source node IDs that contributed
- \`<body>\`: the synthesised markdown content

**\`<archive-nodes>\`:**
- One \`<node-id>\` per node to archive. Only archive nodes whose content is
  fully captured in the reflection output.

**\`<moc-updates>\`:**
- \`domain\`: the MOC domain slug (e.g. "reflections", "preferences")
- \`nodeId\`: the full node ID to add or remove
- \`action\`: "add" or "remove"

**\`<node-updates>\`:**
- \`targetId\`: ID of the node to update
- \`field\`: one of: description, priority, body, tags, links
- \`action\`: one of: set (overwrite), add (append), remove (delete member)
- Element content: the value to apply
`
}

// ---------------------------------------------------------------------------
// User prompt
// ---------------------------------------------------------------------------

/**
 * Builds the per-run user prompt for the Reflector LLM call.
 * Serialises each node as a fenced markdown block with frontmatter,
 * states the current compression level, and includes the MOC index if available.
 */
export function buildReflectorUserPrompt(params: ReflectorUserPromptParams): string {
  const { nodes, compressionLevel, existingMocIndex } = params
  const parts: string[] = []

  // --- Compression level directive ---
  parts.push(`## Compression Level\n${compressionLevel}`)

  // --- Existing MOC index (optional) ---
  if (existingMocIndex !== undefined && existingMocIndex.trim().length > 0) {
    parts.push(`## Existing MOC Index\n${existingMocIndex.trim()}`)
  }

  // --- Nodes to process ---
  if (nodes.length === 0) {
    parts.push('## Nodes to Process\n(none)')
  } else {
    const nodeBlocks = nodes.map((node) => {
      const fm = node.frontmatter
      const frontmatterRecord: Record<string, unknown> = {
        id: fm.id,
        description: fm.description,
        type: fm.type,
        priority: fm.priority,
        created: fm.created,
        updated: fm.updated,
        ...(fm.canonicalKey !== undefined && { canonicalKey: fm.canonicalKey }),
        ...(fm.tags !== undefined && { tags: fm.tags }),
        ...(fm.links !== undefined && { links: fm.links }),
        ...(fm.compressionLevel !== undefined && { compressionLevel: fm.compressionLevel }),
      }
      const serialized = serializeFrontmatter(frontmatterRecord, node.body)
      return `\`\`\`markdown\n${serialized}\n\`\`\``
    })
    parts.push(`## Nodes to Process\n\n${nodeBlocks.join('\n\n')}`)
  }

  return parts.join('\n\n')
}

// ---------------------------------------------------------------------------
// Clustered user prompt
// ---------------------------------------------------------------------------

/** Parameters for building a domain-scoped clustered reflection prompt. */
export interface ClusteredReflectorUserPromptParams {
  /** Compact packets (not full nodes) — token-efficient input. */
  readonly compactPackets: readonly CompactNodePacket[]
  /** Compression level directive for this pass. */
  readonly compressionLevel: CompressionLevel
  /** Domain this cluster covers. */
  readonly domain: string
  /** Time range for context. */
  readonly timeRange: { readonly start: string; readonly end: string }
}

/**
 * Builds a domain-scoped user prompt using compact packets instead of full nodes.
 * Adds domain context and time range for LLM grounding.
 */
export function buildClusteredReflectorUserPrompt(params: ClusteredReflectorUserPromptParams): string {
  const { compactPackets, compressionLevel, domain, timeRange } = params
  const parts: string[] = []

  // --- Domain context ---
  parts.push(
    `## Domain Context\nThis reflection covers the '${domain}' domain, ` +
    `from ${timeRange.start} to ${timeRange.end}.`
  )

  // --- Compression level directive ---
  parts.push(`## Compression Level\n${compressionLevel}`)

  // --- Compact node packets ---
  if (compactPackets.length === 0) {
    parts.push('## Nodes to Process\n(none)')
  } else {
    parts.push(`## Nodes to Process (${compactPackets.length} nodes)\n\n${serializeCompactPackets(compactPackets)}`)
  }

  return parts.join('\n\n')
}
