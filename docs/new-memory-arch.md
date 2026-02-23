You’re not imagining it: the current design pattern (“send the full node index into every observer call”) is a **structural token bomb**. It hurts bootstrap *and* any per-turn / agent_end observation you do, and it can also quietly poison **every single model call** if you accidentally put big content into injected bootstrap files like `MEMORY.md`.

Below is a redesign that fixes the root causes instead of patching symptoms.

---

## 0) The non-obvious “every call is expensive” trap

OpenClaw injects certain workspace files **on every turn** under Project Context (system prompt). That includes `MEMORY.md` / `memory.md` when present, and OpenClaw explicitly warns to keep `MEMORY.md` concise because it grows and increases context usage + compaction. ([OpenClaw][1])

So if your plugin ever wrote a big “node index” into `MEMORY.md` (or any always-injected bootstrap file like `TOOLS.md`), you will pay for it **on every call** even when bootstrap is not running.

**Immediate sanity check**

* Send `/context detail` and look at:

  * injected workspace file sizes
  * system prompt size
  * tool schema overhead
    ([OpenClaw][2])

**Hard rule**

* `MEMORY.md` should be a **pointer / table of contents**, not a database dump.
* Put the graph under `memory/omg/**` (not injected), and pull it on demand via memory tools.

OpenClaw’s model-facing memory tools are explicitly designed for this:

* `memory_search` returns snippets with file + line ranges
* `memory_get` reads a specific memory file/line range
  ([OpenClaw][3])

---

## 1) Why the current approach explodes tokens (the real root cause)

Your current bootstrap does this per chunk:

1. `listAllNodes()`
2. build `existingNodeIndex` (id + description for every node)
3. send that **entire index** into the LLM prompt
4. LLM uses it to avoid duplicates

That makes prompt size scale with `O(chunks × nodes)`.

Even if you snapshot once (A1), you still have a second issue:

### Your SQLite “chunk” source likely isn’t what you think

OpenClaw docs distinguish:

* **Session transcripts**: `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl` ([OpenClaw][4])
* **Memory search index store**: per-agent SQLite at `~/.openclaw/memory/<agentId>.sqlite` ([OpenClaw][3])

If you’re reading `~/.openclaw/memory/<agentId>.sqlite` and treating its `chunks.text` as “session summaries,” you may actually be re-ingesting **already-chunked memory-search material**, which is inherently redundant. That explains why you see tons of near-duplicate “session-ish” chunks.

So: you’re paying LLM tokens to extract nodes from… an index that OpenClaw already maintains for recall.

---

## 2) Redesign goal

You want **Observational Memory Graph** that is:

* **bounded prompt size**
* **no global index in prompts**
* **dedup done in code, not tokens**
* **bootstrap resumable + restart-safe**
* **rate-limit safe (stop/backoff, don’t “skip”)**
* **works for bootstrap and normal agent_end**

The key architectural shift:

> The LLM should never receive “the whole graph” as an input.
> The LLM should receive: *the new delta* + *a tiny relevant slice of existing nodes*, if needed.

---

## 3) The core fix: replace “send full node index” with an Upsert Engine

### 3.1 Deterministic IDs (dedup without tokens)

Stop asking the LLM to dedup by scanning an index. Do it in code.

Define node IDs as **content-addressed** or **key-addressed**:

**Option 1 (recommended): key-addressed IDs**

* `nodeId = sha256(identityScope + type + canonicalKey)` (shortened)
* `canonicalKey` is a strict normalized key like:

  * `preferences.answer_style.checklist_first`
  * `project.secretary.bootstrap.status`

Your observer prompt output includes `type` + `canonicalKey` + `description` + `body`.

Then writing is trivial:

* if file exists → update/merge
* else → create

No node index in prompt. Dedup is O(1) filesystem existence.

**Option 2: content-addressed IDs**

* `nodeId = sha256(normalize(description + body))`
  This avoids key drift but makes intentional updates harder.

### 3.2 Local registry (fast lookup, still no tokens)

Maintain a lightweight registry on disk:

`memory/omg/.registry.json`

```json
{
  "version": 2,
  "nodes": {
    "omg/preference/7f3a9c2b": { "type": "preference", "description": "...", "updated": "..." }
  }
}
```

Update this registry on each write. Now you don’t need `listAllNodes()` constantly.

### 3.3 “Semantic dedup” becomes a background maintenance job

Trying to solve semantic duplicates *during ingest* is what caused the index explosion.

Instead:

* ingest fast with deterministic IDs
* run periodic “merge duplicates” passes via cron (isolated), with a *small* working set each time

Cron is built for persistent scheduled jobs and isolated runs, and isolated cron sessions mint fresh session IDs (no cross-contamination). ([OpenClaw][5])

---

## 4) New prompt strategy: split “extract” from “merge”

### Step A — Extract candidates (no index)

Observer prompt input:

* chunk/batch text
* small schema
* maybe `now.md` (small)
* **no node index**

Observer output (JSON):

```json
{
  "candidates": [
    {
      "type": "preference",
      "canonicalKey": "preferences.answer_style.checklist_first",
      "description": "User prefers short checklists first.",
      "content": "..."
    }
  ]
}
```

### Step B — Upsert in code (no LLM) most of the time

* Convert `type + canonicalKey` → deterministic path/id
* Write or update markdown
* Update `.registry.json`
* Update MOCs incrementally

### Step C — Only if you must merge: retrieve *top-K* related nodes (not full index)

If you still want some semantic dedup:

* run a cheap retrieval (more below)
* send only top 5–10 matching nodes (titles+descriptions) to an LLM merge prompt

This changes the scaling from:

* **old:** `O(total_nodes)` tokens per call
  to
* **new:** `O(K)` tokens per call, where K is fixed (5–10)

---

## 5) Retrieval: use OpenClaw memory tools instead of inventing your own index prompt

OpenClaw already has semantic recall:

* `memory_search` over Markdown chunks (~400 token chunks with overlap), returns snippet + path + line range ([OpenClaw][3])
* `memory_get` to fetch exact lines ([OpenClaw][3])

So for runtime (and even bootstrap merge passes), your workflow should be:

1. `memory_search` with a query derived from the current chunk / recent messages
2. use returned paths to `memory_get` the exact nodes to consider
3. include *only those* in the LLM call

This is literally what memory_search is for, and it avoids the “send the entire index” anti-pattern.

---

## 6) Bootstrap redesign: make it bounded, resumable, and restart-proof

### 6.1 Never run full bootstrap “fire-and-forget” on gateway start

Given your gateway restarts frequently, the safest model is:

* On startup: **only schedule bootstrap work**, don’t execute it inline
* Execute work in:

  * isolated cron, or
  * a heartbeat-driven queue with a strict per-run budget

Cron persists jobs across restarts, and isolated jobs are explicitly meant for “clean slate / different model / background tasks.” ([OpenClaw][5])

### 6.2 Batching: your biggest cheap win

Your SQLite chunks average ~1400 chars; you are paying the system prompt overhead ~1000 times.

Instead, pack many small chunks into one batch up to your budget.

Example: pack to ~18k–24k chars/batch → you drop 1041 calls to ~60 calls.

This alone often yields a **10–20× reduction** in calls.

### 6.3 Progress tracking: don’t use a single sentinel as the only state

Replace `.bootstrap-done` with a state machine file:

`memory/omg/.bootstrap-state.json`

```json
{
  "version": 2,
  "status": "running",
  "startedAt": "...",
  "updatedAt": "...",
  "cursor": 418,
  "total": 612,
  "ok": 410,
  "fail": 8,
  "lastError": "..."
}
```

* update `cursor/ok/fail` after each batch
* on restart, resume from cursor
* if stale lock detected → recover

### 6.4 Add a lease lock (atomic)

Use an atomic file create for a lock:

* `memory/omg/.bootstrap-lock` opened with `wx`
* include `{ pid, startedAt }`
* if lock exists and is fresh → skip
* if lock exists but old → treat as stale and recover

This prevents multi-run duplication even if your sentinel logic regresses.

---

## 7) Rate limit handling: treat it as a global circuit breaker

OpenClaw itself uses retry/backoff patterns in a few places (cron has exponential retry backoff after consecutive errors). ([OpenClaw][6])

Your LlmClient should do the same:

### A robust detection rule (works even with “HTTP 200 ⚠️ …”)

Instead of matching strings:

* Require that the LLM output parses as valid JSON (or whatever schema you enforce)
* If it fails parsing → classify as `TransientError` and retry with backoff
* Also treat specific gateway warning prefixes as transient (your current fix), but parsing is the real anchor

### Backoff strategy (simple and safe)

* exponential: 15s → 30s → 60s → 120s → 300s
* after N failures, **pause the whole pipeline**, not just the current chunk
* drop concurrency to 1 after first rate limit

Critically: **do not “skip and continue”**. That’s how you burn tokens 1000 times in a row.

---

## 8) Remove third-party fallback (architectural correctness)

You already said it: if this plugin is designed to run via the OpenClaw gateway, a direct OpenAI fallback is not “resilience,” it’s “silent misrouting.”

Also: it makes debugging impossible.

So:

* Gateway unreachable → fail loudly
* Rate limit → retry/backoff
* Permanent error → mark batch failed, stop bootstrap run, persist state

(Plugin hooks run inside the gateway pipeline; use explicit plugin hook registration patterns only. ([OpenClaw][7]))

---

## 9) Fix runtime too: don’t do “observer on every turn” by default

Mastra’s observational memory is threshold-based (observe/reflect when token pressure warrants it), not “always run a full observer.” ([mastra.ai][8])

In OpenClaw you already have a natural trigger: **compaction pressure** and the pre-compaction **memory flush** mechanism. ([OpenClaw][9])

A good OpenClaw-native policy:

### When to run observation (agent_end)

Run the observer only if one of:

* session contextTokens is above X (approaching soft threshold)
* N turns since last observation
* time since last observation > T minutes
* a “high-signal” event occurred (task completion, preference update, new project)

### When to write durable memory

Leverage memoryFlush (silent NO_REPLY) as a “last chance” safety net. ([OpenClaw][9])
But don’t rely on it as the only mechanism (there are active bug reports about reliability). ([GitHub][10])

---

## 10) Practical “do this now” checklist (highest ROI)

### Stop the bleeding today

1. **Ensure `MEMORY.md` is small** (just links/pointers). Remember it is injected every turn. ([OpenClaw][1])
2. **Remove node index from all LLM calls** (bootstrap *and* runtime observer). Replace with deterministic IDs + code upsert.
3. **Batch SQLite chunks** (pack into fewer calls).
4. **Make bootstrap resumable** (`.bootstrap-state.json` + cursor) + atomic lock.
5. **Implement circuit-breaker backoff** on parse failure / rate-limit signals.
6. **Remove OpenAI fallback entirely**.

### Then do the proper architecture

7. Switch dedup strategy to:

   * deterministic IDs (fast)
   * background merge job (cron isolated) ([OpenClaw][5])
8. For runtime injection:

   * inject only `memory/omg/index.md` (tiny)
   * retrieve nodes via `memory_search`/`memory_get` when needed ([OpenClaw][3])

---

## If you want, I can turn this into a concrete v2 spec for your codebase

You already have good internal docs; the next step is to write a tight “OMG v2” spec that defines:

* canonicalKey format (per node type)
* file path scheme
* `.registry.json` schema
* bootstrap batch packing algorithm
* retry/backoff rules
* hook policy:

  * `before_prompt_build` only injects pointers (small) ([OpenClaw][11])
  * `agent_end` runs observer only when thresholds are crossed ([OpenClaw][11])

If you paste (or summarize) your current `runObservation()` prompt contract and the `writeObservationNode()` logic (especially how IDs/paths are formed), I’ll map it directly into the deterministic-upsert design so you can implement it with minimal refactoring.

[1]: https://docs.openclaw.ai/concepts/system-prompt "System Prompt - OpenClaw"
[2]: https://docs.openclaw.ai/concepts/context "Context - OpenClaw"
[3]: https://docs.openclaw.ai/concepts/memory "Memory - OpenClaw"
[4]: https://docs.openclaw.ai/concepts/session "Session Management - OpenClaw"
[5]: https://docs.openclaw.ai/automation/cron-jobs "Cron Jobs - OpenClaw"
[6]: https://docs.openclaw.ai/cli/cron "cron - OpenClaw"
[7]: https://docs.openclaw.ai/tools/plugin "Plugins - OpenClaw"
[8]: https://mastra.ai/docs/memory/observational-memory?utm_source=chatgpt.com "Observational Memory - Mastra Docs"
[9]: https://docs.openclaw.ai/reference/session-management-compaction "Session Management Deep Dive - OpenClaw"
[10]: https://github.com/openclaw/openclaw/issues/12590?utm_source=chatgpt.com "[Bug]: `memoryFlush` does not fire reliably · Issue #12590"
[11]: https://docs.openclaw.ai/concepts/agent-loop "Agent Loop - OpenClaw"
