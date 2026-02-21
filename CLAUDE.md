# CLAUDE.md — openclaw-omg

## Project Overview

OpenClaw plugin — TypeScript ESM package.

Key stacks: TypeScript 5.x, Node 20+, Vitest, Zod, pnpm.

## Build & Run

```bash
pnpm install
pnpm test          # full suite
pnpm typecheck     # tsc --noEmit
```

---

## PR Review Rules (MANDATORY)

### Confidence threshold

Only report issues with **confidence ≥ 80** (0–100 scale):
- **91–100** → BLOCKER candidate
- **80–90** → DEBT or NITPICK candidate
- **< 80** → silently drop, do not report

### Severity tiers — hard definitions

| Tier | Definition | Action |
|------|-----------|--------|
| 🔴 BLOCKER | Data loss · security vuln · hard crash · broken test · wrong business logic · deadlock · unhandled production error | **Must fix before merge** |
| 🟡 DEBT | Perf issue · missing edge case (non-critical) · refactor opportunity · unclear naming · missing test for happy path | **`gh issue create`, do not block merge** |
| 🔵 NITPICK | Style · doc · minor inconsistency · naming preference | **Mention once, never escalate** |

### Review process — 2 rounds HARD LIMIT

1. **Round 1** — full diff pass. Categorize ALL ≥80-confidence findings as BLOCKER / DEBT / NITPICK.
   Output in structured format below. Do not fix anything yet.
2. **Fix phase** — author fixes BLOCKERs only. DEBT items → `gh issue create` immediately.
3. **Round 2** — targeted re-run on **fixed files only** (not full diff). Flag NEW BLOCKERs
   introduced by the fix. Do not re-raise old findings.
   - Zero new BLOCKERs → **LGTM. Merge.**
   - New BLOCKERs found → output them, **STOP. Human decides whether to merge.**
4. **Session ends.** No further review rounds regardless of outcome.

> ⚠️ The `review-pr` command's "Re-run after fixes" suggestion is **overridden** by these rules.
> Only fixed files are re-checked in Round 2. This is still counted as Round 2.

### Forbidden behaviors

- ❌ NEVER upgrade a DEBT to BLOCKER between rounds
- ❌ NEVER add unrelated findings in Round 2
- ❌ NEVER run a full diff review in Round 2 (only fixed files)
- ❌ NEVER block merge on "could be better", "should consider", "might cause issues"
- ❌ NEVER repeat NITPICKS that were already noted
- ❌ NEVER run Round 3, even if Round 2 reveals new BLOCKERs
- ❌ NEVER auto-merge when Round 2 reveals new BLOCKERs — stop and wait for human
- ❌ NEVER report issues with confidence < 80

### Structured output format

```
## PR REVIEW — Round N: [branch or PR title]

### 🔴 BLOCKERS (fix before merge)
- [ ] `file.ts:42` — Description [confidence: 95]. Impact: [specific production harm]

### 🟡 DEBT (gh issue create, merge anyway)
- [ ] `file.ts:17` — Description [confidence: 82] → gh issue create

### 🔵 NITPICKS (optional)
- `file.ts:8` — Suggestion [confidence: 80]

---
BLOCKERS: N | DEBT: N | NITPICKS: N
→ [MERGE READY / HUMAN DECISION REQUIRED: N new blockers from fix / N blockers remaining]
```

### Review prompt template (use this when invoking review)

```
Review this PR diff. Output ONLY in the structured format from CLAUDE.md.
Severity rules are strict: BLOCKER = production harm only. Confidence threshold: ≥80.
Scope: diff only — do not flag pre-existing issues outside the diff.
This is Round [1/2].
[Round 2: review ONLY files touched by the fix. Flag new BLOCKERs introduced by the fix.
If new BLOCKERs found → STOP, human decides. No Round 3.]
```
