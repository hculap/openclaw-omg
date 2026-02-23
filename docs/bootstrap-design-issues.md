# Bootstrap Design Issues — Analysis & Redesign Options

## What Happened (Incident 2026-02-23)

Bootstrap ran multiple times overnight burning the weekly Claude Code token budget with no nodes to show for it. Root causes:

### 1. Sentinel written at END, not START

**Bug:** `runBootstrap()` wrote `.bootstrap-done` only after all 1079 chunks finished. The gateway restarts every 5–15 min (each agent session triggers a fresh `register()` + `gateway_start()` cycle). Every restart fired a new full bootstrap run from scratch.

**Observed:** Bootstrap started at least 4 times with 1079 chunks each = ~4000+ LLM calls total.

**Partial fix applied:** Sentinel now written at bootstrap start. But the sentinel records `chunksSucceeded: 0` permanently — there is no resume/restart capability.

---

### 2. Node index sent on every single chunk call

**Bug:** `processChunk()` calls `listAllNodes(omgRoot)` on every iteration to build `existingNodeIndex`. This is passed into every observer LLM call. The index grows as nodes are written.

**Observed from logs:** `nodeIndexSize: 283` by the time runs were hitting errors — meaning 283 node IDs + descriptions sent in every prompt.

**Cost breakdown:**
- 436 nodes × ~30 words × ~1.3 tokens = **~17K tokens per call** just for the index
- 1079 chunks × ~17K input tokens = **~18M tokens** for the index alone across one full run
- Plus system prompt (~2K tokens) + chunk content (~500 tokens) per call
- **Estimated cost per full run: ~$55–70** (Sonnet 4.6 at $3/M input)
- 4 runs = **~$200–280 total burned**

**Why the index exists:** Observer needs it to avoid creating duplicate nodes (checks ID before creating). But for bootstrap, this deduplication value is low — chunks are processed roughly in order and exact duplicates across sources are rare.

---

### 3. Stale API error silently treated as success

**Bug:** Gateway returns rate limit errors as HTTP 200 with body `⚠️ API rate limit reached. Please try again later.`. Before the fix, `GATEWAY_ERROR_PATTERNS` matched this and incorrectly triggered OpenAI fallback. After removing patterns entirely, the `⚠️` response was returned as `content` to the observer, which returned `operations=0` — chunk counted as processed, 0 nodes written, token still consumed.

**Partial fix applied:** Detect `⚠️` prefix and `Connection error` prefix, re-throw. But this is fragile — depends on the exact gateway error string format.

---

### 4. OpenAI fallback on gateway errors

**Bug:** When gateway returned body-pattern errors (old code) or network errors, the LLM client permanently switched to OpenAI fallback for the session. OpenAI then 429'd because it has actual quotas.

**Root issue:** Using OpenAI as a fallback for a plugin that is meant to run exclusively through the OpenClaw gateway is wrong. There's no scenario where falling back to a third-party API key that the user may not have, or may have quota limits on, is correct behavior.

**Partial fix applied:** Fallback only on network connectivity errors (ECONNREFUSED, ECONNRESET, etc.). Rate limit errors re-throw instead.

---

## Redesign Options

### Issue A: Token cost of node index

**Option A1 — Snapshot index once at bootstrap start (quick fix)**
- Take `existingNodeIndex` once before the chunk loop, pass it to all `processChunk()` calls
- Pros: reduces index calls from 1079 to 1; index doesn't grow during the run (simpler)
- Cons: new nodes written in chunk N won't be visible to chunk N+1 (minor dedup loss)
- **Recommended for immediate implementation**

**Option A2 — Skip index entirely during bootstrap**
- Don't send `existingNodeIndex` to the observer at all during bootstrap
- Let the observer create nodes freely; rely on IDs being deterministic (same source → same ID)
- Pros: massively reduces token cost (~17K tokens saved per call)
- Cons: may create duplicates if multiple chunks describe the same fact with slightly different wording; LLM may create redundant nodes
- **Viable if chunk sources are distinct (md files vs sqlite are non-overlapping)**

**Option A3 — Send index only for same-source chunks (batching)**
- Group chunks by source file; for each source batch, snapshot index once before batch
- Within a batch, update the in-memory index with newly written node IDs (no re-read from disk)
- Pros: good balance of dedup accuracy vs token cost
- Cons: more complex orchestration
- **Best long-term option**

**Option A4 — Hash-based dedup instead of index**
- Before writing a node, hash the source chunk. Store hashes. Skip if hash seen.
- Pros: O(1) dedup, no LLM index overhead
- Cons: doesn't catch semantic duplicates (same fact, different wording)
- **Useful as a pre-filter before LLM, not a replacement**

---

### Issue B: Resumable bootstrap (chunks not re-processed on restart)

**Current state:** Sentinel written at start (no re-trigger), but if bootstrap dies mid-way, the remaining chunks are never processed.

**Option B1 — Track processed chunks in sentinel**
- Sentinel stores list of completed chunk IDs (hash of source label + content)
- On restart (force=true or new CLI flag), skip already-processed chunks
- Pros: true resume capability
- Cons: sentinel file grows large for 1079 chunks; requires chunk hashing

**Option B2 — Per-chunk progress file**
- Write a small `.bootstrap-progress` file after each chunk succeeds
- On restart with resume flag, load progress and skip completed chunks
- Pros: granular resume
- Cons: extra I/O per chunk

**Option B3 — Accept that bootstrap runs once, skip incompletely (current)**
- Sentinel blocks re-runs. If bootstrap dies mid-way, user must `rm .bootstrap-done` and re-run manually
- Pros: simple
- Cons: user has to intervene; wasted tokens on failed chunks
- **Acceptable if rate-limit handling is correct (B is fine, fix C instead)**

---

### Issue C: Rate limit handling

**Current gateway behavior:** Returns `⚠️ API rate limit reached. Please try again later.` as HTTP 200 body.

**Problem:** This is not retried — the chunk is simply counted as failed and bootstrap continues to the next chunk. With 1079 chunks firing at concurrency=3, if rate limit hits at chunk 50, chunks 51–1079 all fail immediately (consuming ~0 tokens each after the error, but the initial prompt tokens are still burned per call).

**Option C1 — Exponential backoff + retry on rate limit (recommended)**
- When LLM call returns rate-limit error, wait and retry (e.g. 30s, 60s, 120s, give up)
- Apply at the `LlmClient` level so it works for both bootstrap and agent_end
- Pros: bootstrap eventually completes even under load; no tokens wasted on empty retries
- Cons: bootstrap takes longer; need to cap retries to avoid infinite wait

**Option C2 — Pause entire bootstrap on first rate limit**
- When any chunk hits rate limit, pause all workers for N minutes, then resume
- Pros: simple, predictable
- Cons: blunt — pauses even workers that might succeed

**Option C3 — Stop bootstrap on rate limit, mark sentinel as partial**
- On rate limit, write sentinel with `status: "partial"`, stop
- On next `force` run, skip chunks that already succeeded (requires B1/B2)
- Pros: clean shutdown, no wasted calls
- Cons: requires resumable bootstrap

**Recommended: C1 (retry with backoff) at LlmClient level** — fixes both bootstrap and agent_end rate limit handling with one change.

---

### Issue D: Remove OpenAI fallback entirely

**Current state:** Fallback only triggers on network connectivity errors. Rate limits re-throw. This is better but still wrong architecturally.

**Recommendation:** Remove the fallback chain entirely. The plugin is designed for the OpenClaw gateway. If the gateway is unreachable, fail loudly. Direct API keys (Anthropic/OpenAI) are a development convenience that creates confusion in production (wrong model, wrong routing, burns user's personal API quota).

**Migration path:**
1. Remove `resolveDirectFallbackFn()` and the entire fallback wrapper
2. `resolveGenerateFn()` returns just `gatewayFn` directly
3. All errors propagate to callers (bootstrap logs and skips; agent_end logs and preserves state for retry)
4. Add a clear startup log if gateway endpoint is unreachable

---

## Recommended Action Plan (Priority Order)

1. **[IMMEDIATE] Fix A1** — Snapshot node index once at bootstrap start. 1-line change in `processChunk` signature. Reduces token cost by ~97%.

2. **[IMMEDIATE] Fix C1** — Add retry with exponential backoff on rate-limit errors in `LlmClient`. Prevents wasted calls and allows bootstrap to complete even under load.

3. **[SHORT TERM] Fix D** — Remove OpenAI fallback. Fail loudly when gateway unreachable instead of routing to wrong API.

4. **[SHORT TERM] Fix A2 or A3** — Evaluate whether sending node index during bootstrap is necessary at all. If source chunks are sufficiently distinct, skip the index entirely during bootstrap (A2).

5. **[LATER] Fix B1 or B3** — Decide on resume strategy. B3 (manual rm + re-run) is acceptable once C1 is in place (bootstrap won't waste tokens on rate-limited calls).

---

## Current State After Incident

- Secretary sentinel: exists (bootstrap blocked)
- Secretary nodes written: 436 (from agent_end sessions, not bootstrap)
- Bootstrap progress: ~15/38 md chunks completed, 0/1041 sqlite chunks completed
- Token budget: partially consumed (exact amount unknown)
- Gateway: running, agents working normally
- Bootstrap: blocked by sentinel — will not re-run until sentinel deleted + gateway restarted
