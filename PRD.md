## 1) Mastra “Observational Memory” — what it is and why it works

Mastra’s Observational Memory (OM) is a **three-tier memory system** designed for long conversations where raw transcripts exceed the context window. Instead of doing “retrieve memory every turn,” it **incrementally rewrites the conversation into a dense, cache-friendly memory block** and keeps only a small recent window of raw messages.

### The core architecture: Actor + Observer + Reflector

* **Actor**: your main agent (the one responding to the user).
* **Observer**: a background LLM pass that reads *recent transcript chunks* and produces a structured **observations block** (dense, dated bullets of what matters), plus a “current task” and a “suggested response.” ([Mastra][1])
* **Reflector**: a background LLM pass that **compresses older observations into even denser reflections** when the observation log grows too large. ([Mastra][1])

Mastra’s own guidance (and code) emphasizes that the Actor should treat observations as *its memory*, maintain continuity, and **not mention the memory system**. A dedicated “continuation hint” is injected to prevent “Hi, how can I help?” resets after the transcript is truncated. ([GitHub][2])

### The “three-tier” context window OM creates

In practice, the Actor sees:

1. **Recent unobserved messages** (short sliding window)
2. **Active observations** (dense memory of older parts of the conversation)
3. (Optionally) **Reflections** (compressed older observations)

Then OM **removes the older raw messages** that have been “observed,” replacing them with the observation text. That gives you a stable, bounded prompt.

### Defaults and mechanics from the implementation

From Mastra’s reference implementation, the defaults are intentionally sized for long context:

* Default model for Observer and Reflector: `google/gemini-2.5-flash` ([GitHub][2])
* Default thresholds:

  * `messageTokens`: **30,000** (when to observe) ([GitHub][2])
  * `observationTokens`: **40,000** (when to reflect) ([GitHub][2])

It also includes **async buffering** so you don’t “pay a blocking observation/reflection tax” right at the threshold:

* Observation buffering defaults to **buffer every 20%** of the message threshold and activate at **0.8** (keep ~20% of the threshold in raw messages). ([GitHub][2])
* Reflection buffering can start at **0.5** of the observation threshold. ([GitHub][2])
* The implementation seals and persists message boundaries before buffering so streaming doesn’t corrupt what’s being summarized. ([GitHub][2])

There’s also a **shared token budget** mode (`shareTokenBudget`) that lets message space expand into unused observation space, but it currently requires disabling async buffering (the implementation hard-errors otherwise). ([GitHub][2])

### Why OM is attractive (beyond “it summarizes”)

1. **Stable, cache-friendly prompts**: the “memory block” is a bounded structure instead of an ever-growing transcript.
2. **No per-turn retrieval loop**: OM keeps a canonical memory state and updates it when needed.
3. **Temporal reasoning is first-class**: the rules explicitly say newer observations override older ones, and planned actions in the past should be assumed completed unless contradicted. ([GitHub][2])
4. **Evidence of effectiveness**: Mastra positions OM as strong on long-memory benchmarks (LongMemEval is the headline) and frames it as a robust alternative to naïve “just summarize” compaction. ([Mastra][3])

---

## 2) “Skill Graphs” — what your graph-memory text is really proposing

Your “Skill Graphs > SKILL.md” text is essentially: **turn “skills” into a navigable knowledge graph**.

Key points (as you wrote them):

* **One file = one capability** breaks at depth. Real domains need *many* composable ideas.
* **Skill graph = many small files** (nodes), connected by **wikilinks embedded in prose** so links carry semantic intent.
* Every node has **YAML frontmatter descriptions** so an agent can scan cheaply.
* Use **MOCs (Maps of Content)** to organize subgraphs.
* Use **progressive disclosure**:
  `index → descriptions → links → sections → full content`

The important technical claim: **most decisions happen before reading full files** because the agent can navigate via metadata + link semantics, and only load what matters.

This is a *structured retrieval* strategy, but not in the “vector search returns blobs” sense—more like “attention routing over a curated small-world graph.”

---

## 3) The synthesis: Observational Memory Graph (OMG)

### The combined idea

**Observational Memory Graph (OMG)** = Mastra’s OM pipeline **but the “observations/reflections” are not one monolithic log**. Instead, they are written as a **graph of small, durable markdown nodes**, using the Skill Graph primitives:

* **Wikilinks in prose** (meaningful traversal cues)
* **YAML frontmatter descriptions** (cheap scanning)
* **MOCs** (cluster navigation)
* **Progressive disclosure** (load minimal → expand as needed)

In other words:

> Mastra OM answers “how do we compress and preserve conversation?”
> Skill Graphs answer “how do we structure and traverse knowledge at scale?”
> OMG answers “how do we compress conversation *into a traversable knowledge structure*?”

### Why this is strictly better than “observation log in one file”

A single observation log is:

* great for continuity,
* but weak for modular reuse, domain composition, and long-term maintenance.

A graph lets you:

* isolate “user preference” nodes from “project status” nodes from “health constraints,”
* link them explicitly,
* update one node without rewriting everything,
* and keep a stable index for prompt caching.

### Mapping OM concepts → graph concepts

| Mastra OM concept                         | Observational Memory Graph equivalent                                 |
| ----------------------------------------- | --------------------------------------------------------------------- |
| “Observations block”                      | Many **Observation Nodes** (atomic, dated, link-rich)                 |
| “Current task / suggested response”       | A **Now Node** (current state) that links out to supporting nodes     |
| “Reflections”                             | **Reflection Nodes** + **MOCs** that summarize clusters               |
| “Activation” (swap transcript for memory) | **Prompt injection** of: Index + relevant MOCs + a small set of nodes |
| “Async buffering”                         | Background node creation + scheduled reflection/MOC regeneration      |

---

## 4) OpenClaw implementation proposal: an OMG Skill + Plugin architecture

Below is a design that fits OpenClaw’s actual primitives: **sessions, compaction, memory files, skills, plugins, hooks, cron**.

### OpenClaw constraints and affordances we should respect

* **Session isolation matters**. OpenClaw explicitly warns that DM sessions can leak between users unless you enable secure DM scoping (`dmScope: per-channel-peer`, etc.). Your memory graph must key off that isolation model. ([OpenClaw][4])
* The Gateway is the source of truth for sessions and transcripts, and session files live on the gateway host. ([OpenClaw][4])
* OpenClaw already has:

  * **Compaction** (persistent summary entries) and a **pre-compaction memory flush** mechanism. ([OpenClaw][5])
  * A “silent turn” convention using `NO_REPLY`. ([OpenClaw][5])
  * A memory system that **watches memory files** and configures semantic memory search under `agents.defaults.memorySearch`. ([OpenClaw][6])
  * Hooks + plugin hooks at well-defined lifecycle points. ([OpenClaw][7])

So OMG should *compose* with these rather than fight them.

---

# A) The skill: `observational-memory-graph`

### Purpose of the skill

This is the **operator manual** the agent uses to:

* write observation nodes,
* maintain MOCs,
* follow progressive disclosure rules,
* and query/insert memory graph context intelligently.

OpenClaw skills are `SKILL.md` files with YAML frontmatter at minimum `name` and `description`. ([OpenClaw][8])
Skills load from bundled, `~/.openclaw/skills`, and `<workspace>/skills` with workspace precedence. ([OpenClaw][8])

### Skill package layout

Put the *methodology* in skills, and the *data* in memory:

```
<workspace>/
  skills/
    observational-memory-graph/
      SKILL.md
      index.md
      mocs/
        omg-moc-how-it-works.md
        omg-moc-writing-nodes.md
        omg-moc-retrieval.md
  memory/
    omg/
      index.md
      mocs/
      nodes/
      reflections/
      inbox/
```

This keeps the skill list small (important because skills are loaded and injected during session/workspace prep). ([OpenClaw][7])

### SKILL.md skeleton (OpenClaw-compliant)

```md
---
name: observational-memory-graph
description: Maintain a wiki-linked graph of durable user/session observations and reflections under memory/omg/ using progressive disclosure (index→MOCs→nodes).
metadata:
  {
    "openclaw": {
      "requires": { "config": ["agents.defaults.memorySearch"] }
    }
  }
---

# Observational Memory Graph

## Operator rules
- Write atomic nodes, not mega-notes.
- Embed wikilinks in prose so link intent is semantic.
- Keep index + MOCs scan-friendly; push details into nodes.
- Prefer newest facts; if conflict, newer supersedes older.
...
```

Notes:

* The gating pattern shown (`metadata.openclaw.requires`) follows OpenClaw’s skill gating design. ([OpenClaw][8])

---

# B) The data model: files as a graph (your “skill graph” primitives, applied to memory)

### 1) Node types

You want a small number of node “kinds,” because too many categories create taxonomy debt. A practical set:

* `identity`: stable info about the user/persona (role, constraints, goals)
* `preference`: stable user preferences (style, tools, routines)
* `project`: ongoing work threads
* `decision`: durable decisions and why
* `fact`: stable facts (but time-stamped)
* `episode`: “what happened” chunks that don’t deserve their own concept node
* `reflection`: summaries over clusters (weekly/monthly) + link hubs

### 2) YAML frontmatter for **memory nodes**

This is your progressive-disclosure surface.

```md
---
id: omg/preference/answer-style
description: User prefers short, concrete checklists; avoid long theory unless asked.
type: preference
priority: high
created: 2026-02-19
updated: 2026-02-19
appliesTo:
  sessionScope: "dm"         # or "group", "global"
  identityKey: "agent:myAgent:telegram:dm:alice"   # derived from sessionKey/dmScope
sources:
  - { sessionKey: "agent:...", kind: "message", timestamp: 1739920000 }
links:
  - "[[omg/moc-preferences]]"
  - "[[omg/preference/detail-level]]"
tags: [communication, format]
---
User consistently responds best to **short actionable lists**.
When stressed, start with the next step, then offer optional depth via [[omg/preference/detail-level]].
```

### 3) MOCs (Maps of Content)

Example:

```md
---
id: omg/moc-preferences
description: Entry point for user preferences and interaction constraints.
type: moc
updated: 2026-02-19
---

## Interaction preferences
- [[omg/preference/answer-style]] — short checklists first
- [[omg/preference/detail-level]] — progressive depth
- [[omg/preference/tools]] — preferred toolchain
```

### 4) The root index (the stable entry point)

This is what you want to be **small and cache-friendly**.

```md
---
id: omg/index
description: Top-level navigation for the Observational Memory Graph.
type: index
updated: 2026-02-19
---

## MOCs
- [[omg/moc-identity]]
- [[omg/moc-preferences]]
- [[omg/moc-projects]]
- [[omg/moc-open-loops]]
- [[omg/moc-reflections]]

## Retrieval rule
Start with MOCs → follow prose-links → load nodes only if relevant.
```

---

# C) The plugin: `@openclaw/plugin-omg` (automate extraction + graph maintenance)

OpenClaw plugins:

* can export a function `(api) => { ... }` or an object with `{ id, name, configSchema, register(api) { ... } }`. ([OpenClaw][9])
* run **in-process with the Gateway** (treat as trusted code). ([OpenClaw][9])
* can ship hooks and register them at runtime (example uses `registerPluginHooksFromDir`). ([OpenClaw][9])
* can include config schemas and UI hints (labels, sensitive fields). ([OpenClaw][9])

## C1) What the plugin is responsible for

1. **Observe**: after each turn (or on thresholds), extract new observation candidates.
2. **Write**: materialize those as nodes (append-only), add links, update relevant MOCs.
3. **Reflect**: periodically compress episodes into reflections and/or refresh MOCs.
4. **Inject**: ensure the model gets the right slice of the graph at prompt build time.

## C2) Hook points to implement (OpenClaw-native)

From OpenClaw’s agent loop, plugin hooks include:
`before_model_resolve`, `before_prompt_build`, `agent_end`, `before_compaction/after_compaction`, `before_tool_call/after_tool_call`, `tool_result_persist`, message hooks, session/gateway lifecycle hooks. ([OpenClaw][7])

A clean OMG plugin uses:

### 1) `before_prompt_build`

Goal: **load minimal, stable memory context**.

* Inject:

  * `memory/omg/index.md` (always)
  * 1–2 MOCs likely relevant to the current conversation (cheap routing)
  * A small “Now Node” (current task + last known state), if present

Mechanism: OpenClaw explicitly supports plugin hooks that can inject `prependContext` / `systemPrompt` **after session load** and before prompt submission. ([OpenClaw][7])

### 2) `agent_end`

Goal: **write memory** after the agent finishes.

* Read the final message list for the turn.
* Run “Observer” extraction (Mastra-style) to produce:

  * atomic observations
  * current task
  * suggested response (optional; often becomes “Now Node” content)
* Write new nodes into `memory/omg/nodes/...`
* Update MOCs (cheap: only the ones touched)

This is the direct analog of Mastra’s “processOutput triggers Observer/Reflector.” ([GitHub][2])

### 3) `before_compaction`

Goal: **don’t lose state when compaction fires**.

* OpenClaw already supports a pre-compaction memory flush and also exposes plugin hooks for compaction boundaries. ([OpenClaw][5])
* Your plugin should either:

  * rely on OpenClaw’s built-in `memoryFlush` mechanism (recommended), or
  * add a small additional “flush into OMG inbox” step.

The built-in memory flush is configured under `agents.defaults.compaction.memoryFlush` and is designed to run silently using `NO_REPLY`. ([OpenClaw][6])

### 4) `tool_result_persist`

Goal: make tool outputs “memory-safe.”

* This hook **synchronously** transforms tool results before they are written to the transcript. ([OpenClaw][7])
* Don’t do heavy LLM work here. But you can:

  * tag tool results with lightweight metadata (“this result created/updated node X”),
  * or redact/normalize large tool blobs consistently.

### 5) Message routing hooks (`message_received`, `message_sent`) + gateway hook equivalents

If you want memory graph to be **identity-aware** across channels, capture inbound/outbound routing context.

* OpenClaw hook events include `message:received` and `message:sent`, with fields like `from`, `to`, `content`, `channelId`, `accountId`, `conversationId`, and metadata. ([OpenClaw][10])
* Use that to derive `identityKey` (sessionKey or canonical identity mapping).

## C3) Hook packaging options (two layers)

OpenClaw has **two hook systems**:

* **Gateway hooks** (event-driven scripts; ex: `agent:bootstrap`, `message:received`, `command:new`). ([OpenClaw][7])
* **Plugin hooks** (deep lifecycle hooks inside agent/tool pipeline). ([OpenClaw][7])

Your plugin can use both:

* ship gateway hook directories (HOOK.md + handler.ts) for simple message events, discovered from workspace/managed/bundled directories. ([OpenClaw][10])
* implement plugin hooks for `before_prompt_build`, `agent_end`, etc.

## C4) Plugin registration skeleton (what OpenClaw docs actually show)

OpenClaw’s plugin docs show a minimal registration approach:

```ts
import { registerPluginHooksFromDir } from "openclaw/plugin-sdk";

export default function register(api) {
  registerPluginHooksFromDir(api, "./hooks");
}
```

([OpenClaw][9])

(Your OMG plugin would add its own registrations for the lifecycle hooks, but the exact API surface beyond this snippet isn’t shown in the excerpted docs—so treat additional hook wiring as “implementation detail.”)

## C5) Plugin config schema shape

Plugins can define a JSON schema + UI hints. ([OpenClaw][9])

So you’d expose (conceptually):

* storage root (`memory/omg`)
* per-identity mode (`sessionKey` vs canonical identity)
* observation cadence (every turn vs token thresholds)
* reflection cadence (daily cron vs thresholds)
* “high-priority always inject” list (critical nodes)

---

# D) How OMG uses OpenClaw “memory search” instead of reinventing retrieval

OpenClaw’s memory system:

* is enabled by default,
* watches memory files for changes,
* is configured under `agents.defaults.memorySearch`,
* and can auto-select embedding providers (local/openai/gemini/voyage) depending on what keys/models are available. ([OpenClaw][6])

It also has a `memory_search` tool surface, and can export sanitized session transcripts into a QMD collection when enabled. ([OpenClaw][6])

So OMG should:

* store nodes under `memory/omg/...` so they become searchable,
* and rely on `memory_search` as the “fast recall” layer,
* then use wikilinks + YAML to do “slow, deliberate traversal” when needed.

This gets you hybrid behavior:

* **search to find entry points**
* **graph traversal to expand context precisely**

---

# E) Operational safety: session isolation + identity mapping

Because OpenClaw defaults to DM continuity (`dmScope: "main"`), multi-user inboxes can leak context unless you enable secure DM mode. ([OpenClaw][4])

OMG must follow the same rule:

* **If DM scope is shared, the memory graph is shared.**
* If you enable `dmScope: per-channel-peer` (recommended for multi-user), then maintain **one memory graph per isolated sessionKey**, or map to a canonical identity if you explicitly configure identity collapsing. ([OpenClaw][4])

Practically:

* default `identityKey = sessionKey` (safe)
* optional `identityKey = canonical identity` (requires explicit identityLinks discipline)

---

# F) Background reflection / maintenance via Cron (optional but ideal)

Reflection and MOC regeneration are perfect for **isolated cron jobs**:

* Cron runs inside the Gateway and persists jobs. ([OpenClaw][11])
* Isolated cron runs happen in `cron:<jobId>` and mint a fresh session id per run (no carry-over). ([OpenClaw][11])

Use cron for:

* nightly “merge episodes into weekly reflection nodes”
* “repair links + regenerate MOCs”
* “dedupe near-duplicate nodes”

This keeps main chat clean, and you can keep delivery `none` or `announce` depending on how visible you want maintenance to be. ([OpenClaw][11])

---

## 5) What this enables (concretely)

### A) Cache-friendly, compaction-resilient memory

* The **index + a few MOCs** are stable and small → better prompt caching behavior.
* The graph is durable on disk → compaction can summarize transcripts without losing the “real memory,” especially if you leverage pre-compaction memory flush. ([OpenClaw][5])

### B) Better than “one long memory file”

* You can update a preference without rewriting everything.
* You can keep separate “project” and “personal preference” regions.
* You can audit/curate memory like a knowledge base.

### C) Controlled disclosure

The agent can:

* scan YAML descriptions,
* follow semantic wikilinks embedded in prose,
* load only the nodes that matter for the current turn.

This is exactly the “progressive disclosure” principle you described—now applied to durable conversational memory.

---

## 6) If you want a “minimal viable” version first

If you don’t want to ship the plugin immediately, you can still adopt OMG using **only** OpenClaw’s built-in mechanisms:

1. Create `memory/omg/index.md` + 3–5 MOCs.
2. Customize the pre-compaction memory flush prompt to write into `memory/omg/inbox/YYYY-MM-DD.md` using `NO_REPLY`. ([OpenClaw][6])
3. Add the `observational-memory-graph` skill so the agent knows how to split inbox notes into nodes and link them.
4. Use memory search to retrieve nodes. ([OpenClaw][6])

Then the plugin becomes “automation + better injection,” not a prerequisite.

---

## Bottom line

* **Mastra OM** gives you a *continuous compression pipeline* (Observer/Reflector) that preserves long-term conversational state with stable context. ([Mastra][1])
* **Skill Graphs** give you a *scalable knowledge architecture* (wikilinks + YAML + MOCs + progressive disclosure).
* **Observational Memory Graph** combines them: the Observer/Reflector produce **graph nodes** instead of a single log, and OpenClaw’s hooks/plugins/compaction/memory-search provide the runtime substrate to make it practical. ([OpenClaw][7])

If you want, I can also draft:

* a concrete `memory/omg/` starter vault (index + MOCs + node templates),
* a `SKILL.md` + 6–10 linked “how to operate OMG” nodes (a mini skill graph),
* and a minimal plugin skeleton that wires `before_prompt_build` + `agent_end` + `before_compaction` hooks (using exactly the hook names OpenClaw documents). ([OpenClaw][7])

[1]: https://mastra.ai/docs/memory/observational-memory "https://mastra.ai/docs/memory/observational-memory"
[2]: https://raw.githubusercontent.com/mastra-ai/mastra/main/packages/memory/src/processors/observational-memory/observational-memory.ts "https://raw.githubusercontent.com/mastra-ai/mastra/main/packages/memory/src/processors/observational-memory/observational-memory.ts"
[3]: https://mastra.ai/research/observational-memory "https://mastra.ai/research/observational-memory"
[4]: https://docs.openclaw.ai/concepts/session "https://docs.openclaw.ai/concepts/session"
[5]: https://docs.openclaw.ai/reference/session-management-compaction "https://docs.openclaw.ai/reference/session-management-compaction"
[6]: https://docs.openclaw.ai/concepts/memory "https://docs.openclaw.ai/concepts/memory"
[7]: https://docs.openclaw.ai/concepts/agent-loop "Agent Loop - OpenClaw"
[8]: https://docs.openclaw.ai/tools/skills "https://docs.openclaw.ai/tools/skills"
[9]: https://docs.openclaw.ai/tools/plugin "https://docs.openclaw.ai/tools/plugin"
[10]: https://docs.openclaw.ai/automation/hooks "Hooks - OpenClaw"
[11]: https://docs.openclaw.ai/automation/cron-jobs "https://docs.openclaw.ai/automation/cron-jobs"

