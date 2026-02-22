---
name: observational-memory-graph
description: Maintain a wiki-linked graph of durable observations under memory/omg/ using progressive disclosure (index→MOCs→nodes).
---

# Observational Memory Graph (OMG)

## Overview

OMG is a persistent memory system that stores durable observations as wiki-linked Markdown nodes. The graph lives under `memory/omg/` in the workspace and survives across sessions.

**Graph structure:**

```
memory/omg/
├── index.md         — root navigation, lists all MOCs
├── now.md           — current session state (updated each observation)
├── mocs/            — Maps of Content (one per domain)
│   ├── moc-identity.md
│   ├── moc-preferences.md
│   ├── moc-projects.md
│   ├── moc-decisions.md
│   ├── moc-facts.md
│   └── moc-reflections.md
└── nodes/           — individual observation nodes
    ├── identity/
    ├── preference/
    ├── project/
    ├── decision/
    ├── fact/
    ├── episode/
    └── reflection/
```

## Operator Rules

1. **Atomic nodes** — each node captures one durable observation. Do not bundle unrelated facts.
2. **Wikilinks** — cross-reference related nodes using `[[node-id]]` syntax.
3. **Progressive disclosure** — navigate `index.md → MOC → node`, not by scanning directories.
4. **Newer-wins** — when creating a node that supersedes an existing one, set `supersedes: [old-id]` in frontmatter and mark the old node `archived: true`.
5. **Never delete** — archive nodes rather than deleting them. Deleted nodes break wikilinks.
6. **Frontmatter required** — every node must have `id`, `type`, `created`, `updated` fields.

## Navigation

Start from `index.md`, follow links to the relevant MOC, then follow links to individual nodes. Check `now.md` for current session context.

**Do not scan the `nodes/` directory directly** — use the MOC as your entry point.

## Node Metadata Format

```yaml
---
id: omg/identity-name           # namespace/slug format
type: identity                  # identity|preference|project|decision|fact|episode|reflection
priority: p1                    # p0 (critical) | p1 (high) | p2 (medium) | p3 (low)
tags: [identity]                # domain tags matching MOC names
created: 2024-01-01
updated: 2024-01-01
archived: false                 # set true instead of deleting
supersedes: []                  # list of node IDs this node replaces
---
```

## Triggering Observation

Observation runs automatically based on the configured trigger mode:
- `threshold` — runs when accumulated message tokens exceed `messageTokenThreshold`
- `every-turn` — runs after every agent turn (dev/test mode)
- `manual` — only when explicitly requested

To request a manual observation, include `[observe]` in your message.
