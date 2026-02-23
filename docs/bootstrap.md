# Bootstrap Phase — Detailed Description

## Purpose

Bootstrap is a one-time cold-start ingestion pipeline that populates the OMG graph from existing memory sources (workspace markdown files, OpenClaw session logs, SQLite memory databases). It runs once per workspace at gateway startup when no sentinel exists, converting historical memory into structured graph nodes so the observer has context from day one rather than starting empty.

---

## Trigger Conditions

Bootstrap fires from two places in `plugin.ts`:

### 1. `gateway_start` hook
Runs when the gateway process starts. Checks sentinel presence and fires bootstrap fire-and-forget if missing:
```
gateway_start → scaffoldGraphIfNeeded() → readSentinel() → if null → runBootstrap() [fire-and-forget]
```
**Important:** The gateway restarts frequently — every 5–15 minutes when agents connect, because each agent session calls `register()` which triggers `gateway_start`. The sentinel check prevents re-runs.

### 2. `before_prompt_build` hook (fallback)
Fires on the first agent message per workspace per gateway lifetime. Used as a fallback in case `gateway_start` did not trigger bootstrap (e.g. when `workspaceDir` was not yet known at gateway_start time):
```
before_prompt_build → scaffoldGraphIfNeeded() → listAllNodes() → if empty → runBootstrap() [fire-and-forget]
```
**Note:** This path uses node-count check (`nodes.length === 0`), not sentinel. Subject to the scaffold false-positive issue — scaffold creates `index.md` so nodes are never empty after scaffold. Currently a known issue.

---

## Sentinel File

**Path:** `{workspaceDir}/memory/omg/.bootstrap-done`

**Purpose:** Prevents bootstrap from running more than once per workspace. Written at bootstrap START (not end) so gateway restarts during a long bootstrap run don't re-trigger a duplicate run.

**Format:**
```json
{
  "completedAt": "2026-02-23T07:35:32.241Z",
  "chunksProcessed": 1079,
  "chunksSucceeded": 0
}
```

**Lifecycle:**
- Written immediately when bootstrap starts (before any LLM calls)
- Updated at the end with final `chunksSucceeded` count
- Scoped per workspace — each workspace gets its own sentinel
- To force re-run: `rm {omgRoot}/.bootstrap-done` then restart gateway

**Known issue:** `chunksSucceeded` in the initial write is always `0` (written before processing). The final write updates it, but if the process dies mid-run, the sentinel has `0` forever, giving no indication of partial completion.

---

## Sources

Controlled by `config.bootstrap.sources` in `openclaw.json`:
```json
{
  "bootstrap": {
    "sources": {
      "workspaceMemory": true,
      "openclawSessions": true,
      "openclawLogs": false
    }
  }
}
```

### Source 1: Workspace Memory (`workspaceMemory`)
- **Reader:** `readWorkspaceMemory(workspaceDir, storagePath)` in `sources.ts`
- **Location:** `{workspaceDir}/memory/**/*.md`
- **Exclusion:** Files inside the OMG storage path (`{workspaceDir}/memory/omg/`) are skipped to avoid re-ingesting already-processed graph nodes
- **Filtering:** Only `.md` files; empty files skipped
- **Typical count:** 38 files for Secretary workspace (Jan 25 – Feb 22 daily logs)

### Source 2: OpenClaw Session SQLite (`openclawSessions`)
- **Reader:** `readSqliteChunks(workspaceDir)` in `sources.ts`
- **Location:** `~/.openclaw/memory/{agentId}.sqlite`, table `chunks`, column `text`
- **Agent filtering:** Reads `~/.openclaw/openclaw.json` to find agent IDs whose `workspace` matches `workspaceDir`. Falls back to reading all `.sqlite` files if config unreadable.
- **SQLite engine:** `node:sqlite` built-in (Node 22.5+ experimental, stable Node 25+). No native addon — no ABI issues.
- **Typical counts (Secretary workspace):**
  - `pati.sqlite`: 226 chunks, avg 1454 chars
  - `email-triage.sqlite`: 180 chunks, avg 1419 chars
  - `whatsapp-triage.sqlite`: 635 chunks, avg 1405 chars
  - **Total: 1041 SQLite chunks**

### Source 3: OpenClaw Logs (`openclawLogs`)
- **Reader:** `readOpenclawLogs()` in `sources.ts`
- **Location:** `~/.openclaw/logs/**`
- **Filtering:** `.txt`, `.log`, `.jsonl`, `.md` extensions only
- **Default:** Disabled (`openclawLogs: false`) — gateway logs are noisy and low-signal for graph extraction
- **Warning:** Enabling this caused bootstrap to ingest `gateway.err.log` itself (1MB+ file) into hundreds of chunks — highly undesirable

---

## Chunking

**Module:** `src/bootstrap/chunker.ts`

**Budget:** `CHUNK_TOKEN_BUDGET = 6000` tokens = 24,000 characters per chunk (4 chars/token heuristic)

**Algorithm:** Simple fixed-size character slicing. No semantic splitting (no paragraph/sentence awareness). Each source entry is split into as many chunks as needed:
```
entry.text.length / 24000 = number of chunks
```

**Chunk format sent to LLM:**
```
[BOOTSTRAP SOURCE: memory/2026-01-28.md]

{chunk text content}
```
Multi-part chunks are labelled: `memory/2026-01-28.md (part 2)`

**Total chunks for Secretary:** 38 md + 1041 sqlite = **1079 chunks**

---

## Processing Pipeline

Concurrency: `DEFAULT_CONCURRENCY = 3` (3 chunks processed in parallel)

For each chunk, `processChunk()` runs 4 phases:

### Phase 1: LLM Observation
```typescript
const allNodes = await listAllNodes(omgRoot)           // BUG: called per chunk
const existingNodeIndex = allNodes.map(n => ({          // grows with each chunk
  id: n.frontmatter.id,
  description: n.frontmatter.description,
}))
const nowContent = await readFileOrNull(path.join(omgRoot, 'now.md'))

observerOutput = await runObservation({
  unobservedMessages: chunkToMessages(chunk),
  existingNodeIndex,
  nowNode: nowContent,
  config,
  llmClient,
  sessionContext: { source: 'bootstrap', label: chunk.source },
})
```

**What the LLM receives per call:**
- System prompt: ~2000 tokens (observer instructions + node index format)
- Node index: all existing nodes (id + description) — grows from 0 to 400+ as bootstrap runs
- Chunk content: ~1500 tokens (6000 token budget = 1 chunk)
- **Total input: 2000 + nodeCount×~40 tokens + 1500 tokens**

**What the LLM returns:** `ObserverOutput` — list of operations (create/update/delete nodes), MOC updates, now-node update flag

On failure: logs error, returns `{ nodesWritten: 0 }` — chunk is skipped, processing continues

### Phase 2: Write Nodes
```typescript
const writeResults = await Promise.allSettled(
  observerOutput.operations.map(op => writeObservationNode(op, writeContext))
)
```
Each operation writes a markdown file to `{omgRoot}/nodes/{type}/{id}.md`. Failed writes are logged but don't stop processing.

### Phase 3: Update MOCs
Nodes belong to a MOC domain if they have `[[omg/moc-{domain}]]` in their `frontmatter.links` (NOT via tags — see MOC backlink bug fix in commit `dbfd903`).

If domain nodes exist: `regenerateMoc()` rewrites the entire MOC file.
If not yet: `applyMocUpdate()` appends backlink entries incrementally.

### Phase 4: Update now.md
If the LLM flagged a now-node update and nodes were written, `writeNowNode()` updates `{omgRoot}/now.md` with a summary of recent activity.

---

## Token Cost Analysis (Incident 2026-02-23)

### Per-call cost breakdown
| Component | Tokens |
|-----------|--------|
| System prompt | ~2,000 |
| Node index (at chunk 500, ~283 nodes) | ~11,300 |
| Chunk content | ~1,500 |
| **Total input per call** | **~14,800** |
| Output per call | ~500 |

### Per-run cost (1079 chunks, Secretary workspace)
| Item | Tokens |
|------|--------|
| Total input (growing index) | ~12–18M |
| Total output | ~540K |
| **Estimated cost @ Sonnet 4.6** | **~$55–70 per run** |

### What actually happened
- Bootstrap started **4 times** across the session (gateway restarted repeatedly before sentinel-at-start fix)
- Each run hit rate limits partway through
- Before fix: rate limit body `⚠️ API rate limit reached` returned as HTTP 200 → silently treated as success (0 nodes, 0 tokens for that call but initial tokens already spent)
- **Total estimated burn: ~$200–280**

---

## Error Handling

| Error type | Current behavior | Problem |
|------------|-----------------|---------|
| LLM call fails (throws) | Chunk logged as failed, skipped | Correct — chunk failure doesn't stop bootstrap |
| Rate limit as HTTP 200 body (`⚠️`) | **Was:** treated as success (0 nodes). **Now:** detected by `⚠️` prefix, re-thrown | Fixed in commit `bedc456` — but fragile, depends on exact gateway string |
| Gateway network error (ECONNREFUSED etc.) | Falls back to direct API (OpenAI/Anthropic) | Wrong: fallback to OpenAI burns user's personal quota; fallback to Anthropic direct requires auth token |
| SQLite not available | Logs warning, returns `[]` | Correct graceful degradation |
| Source file unreadable | Silently skipped | Correct |
| Node write fails | Logged, processing continues | Correct |
| MOC update fails | Logged, processing continues | Correct |
| Sentinel write fails | Logged, bootstrap re-runs next start | Acceptable |

---

## Known Design Issues

### 1. Node index rebuilt per chunk (CRITICAL — token cost)
`listAllNodes()` is called inside `processChunk()` — once per chunk, reading all node files from disk and sending the full list to every LLM call. With 1079 chunks and a growing index, this is the primary cost driver.

**Fix:** Snapshot index once before the chunk loop, pass as parameter to `processChunk()`.

### 2. No retry on rate limits
When a chunk hits a rate limit, it is simply skipped. With concurrency=3 and 1079 chunks, if rate limit hits at chunk 50, the remaining ~1020 chunks all fire simultaneously and fail immediately — wasting the initial token cost of each call.

**Fix:** Exponential backoff retry in `LlmClient` on rate-limit errors.

### 3. OpenAI fallback is wrong for bootstrap
The LLM client falls back to OpenAI when gateway is unreachable. Bootstrap via OpenAI: wrong model (gpt-4o-mini vs claude-sonnet), wrong auth, burns user's personal OpenAI quota.

**Fix:** Remove OpenAI fallback. Fail loudly on gateway unreachable.

### 4. No resume capability
If bootstrap dies mid-run (crash, kill, rate limit exhaustion), there is no way to resume from where it left off. The sentinel blocks re-runs, so remaining chunks are permanently skipped.

**Fix:** Track completed chunk hashes in sentinel; skip on re-run with `--resume` flag.

### 5. `before_prompt_build` uses node count, not sentinel
The fallback bootstrap trigger in `before_prompt_build` checks `nodes.length === 0`, but scaffold creates `index.md` which is counted as a node. This trigger effectively never fires.

**Fix:** Use `readSentinel()` in `before_prompt_build` instead of node count (same as `gateway_start`).

### 6. SQLite chunks are session summaries — high redundancy
OpenClaw session memory chunks are summaries of individual agent conversations. Many sessions discuss the same topics. The observer will extract the same facts repeatedly across similar chunks, creating duplicate or near-duplicate nodes.

**Fix:** Consider hash-based dedup pre-filter before LLM call; or reduce SQLite chunk count by merging short chunks from the same agent.

---

## Files

| File | Role |
|------|------|
| `src/bootstrap/bootstrap.ts` | Main orchestrator, `runBootstrap()`, `processChunk()` |
| `src/bootstrap/sources.ts` | Source readers: `readWorkspaceMemory()`, `readOpenclawLogs()`, `readSqliteChunks()` |
| `src/bootstrap/chunker.ts` | `chunkText()`, `chunkToMessages()`, `CHUNK_TOKEN_BUDGET` |
| `src/bootstrap/sentinel.ts` | `readSentinel()`, `writeSentinel()`, `SentinelData` |
| `src/plugin.ts` | Bootstrap trigger in `gateway_start` and `before_prompt_build` hooks |

---

## Recommended Redesign (Priority Order)

1. **Snapshot node index once** — pass to all `processChunk()` calls. 1 line change, ~97% token reduction.
2. **Retry with exponential backoff** — in `LlmClient`, on rate-limit errors: wait 30s→60s→120s, then give up.
3. **Remove OpenAI fallback** — bootstrap must use gateway only. Fail loudly if unreachable.
4. **Evaluate skipping index during bootstrap** — sources are distinct enough that full dedup is not critical. Sending no index saves ~11K tokens per call.
5. **Resume capability** — store completed chunk hashes in sentinel; add `--resume` CLI flag.
6. **Fix `before_prompt_build` trigger** — use sentinel check, not node count.

See `docs/bootstrap-design-issues.md` for full analysis and option breakdown.
