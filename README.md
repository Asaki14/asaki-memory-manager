<div align="center">

# 🧠 Asaki Memory Manager

**A Cloudflare-native long-term memory layer for AI agents.**

Give your coding agents durable memory — preferences, project conventions, decisions, bug fixes, and workflows — without a Docker stack or an external vector database. Just Workers, D1, and Vectorize.

[![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-f38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Framework](https://img.shields.io/badge/framework-Hono-e36002?logo=hono&logoColor=white)](https://hono.dev/)
[![Language](https://img.shields.io/badge/TypeScript-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[Quick start](#quick-start) · [Architecture](#architecture) · [Integrations](#integrations) · [API](#api-reference) · [Configuration](#configuration) · [Security](#security)

</div>

---

## Why

AI coding agents are far more useful when they remember. But most memory stacks mean standing up a vector DB, a queue, and a service to babysit. Asaki Memory Manager is a **single-operator, self-hosted** alternative that runs entirely on your Cloudflare account: the Worker is the API, D1 is the source of truth, and Vectorize is a recoverable semantic index. No servers to run, no data leaving your account.

> **Single-operator by design** — this is a personal memory layer, not a multi-tenant/team product. Every query is scoped to one `user_id`.

## Features

- **Cloudflare-native** — Workers + D1 + Vectorize + Workers AI. Nothing else to host.
- **REST-first, MCP-ready** — a small HTTP API, plus the same tool surface served over remote MCP straight from the Worker.
- **Scoped memory** — `global` / `project` / `session` with strict project & session isolation.
- **Hybrid retrieval** — Vectorize semantic search fused with a D1 lexical fallback, so search still works when AI/Vectorize are down.
- **Classifier-first capture** — agents submit pre-distilled candidates directly; local background classifiers queue unsupervised candidates for human review. Server-side raw-text extraction is deprecated compatibility only.
- **Human-in-the-loop** — unsupervised background classifiers never auto-write; their candidates land in a review queue you approve via a `/memory` audit.
- **Deterministic dedup guards** — exact, subset, and technical-token paraphrase checks run *before* any LLM decision.
- **Self-improving** — classifier regression eval turns audit misses into permanent few-shot cases; the extraction eval remains only for the deprecated compatibility path.
- **First-class agent integrations** — a Claude Code plugin, a Pi extension, and a stdio MCP server for Codex.

## Architecture

```mermaid
flowchart TD
    A["AI Agent · App · Pi · Claude Code"] -->|"REST / MCP (bearer auth)"| W["Cloudflare Worker<br/>Hono router + auth + rate limit"]
    W --> AI["Workers AI<br/>bge-m3 embeddings · LLM merge/ignore decisions"]
    W --> D1[("D1<br/>source of truth<br/>memories · events · reviews")]
    W --> V[("Vectorize<br/>semantic index + metadata filters")]
    V -. "rebuildable from D1<br/>(index_status=pending on failure)" .-> D1
```

**D1 is the source of truth; Vectorize is an index.** If a vector upsert fails, the memory is still stored and marked `index_status=pending` for later backfill — no write is ever lost to an indexing hiccup.

## Quick start

<details open>
<summary><b>Prerequisites</b></summary>

- A Cloudflare account with Workers, D1, Vectorize, and Workers AI enabled
- Node.js 20+ and the `wrangler` CLI (installed via `npm install`)

</details>

```bash
# 1. Install
npm install

# 2. Create Cloudflare resources
npx wrangler login
npx wrangler d1 create asaki-memory-manager
npx wrangler vectorize create asaki-memory-manager --dimensions 1024 --metric cosine
for p in user_id scope project_id session_id kind; do
  npx wrangler vectorize create-metadata-index asaki-memory-manager --propertyName "$p" --type string
done

# 3. Configure Wrangler (then set your D1 database_id in wrangler.jsonc)
cp wrangler.example.jsonc wrangler.jsonc

# 4. Apply migrations
npm run db:migrate:local
npm run db:migrate:remote

# 5. Set the required API auth secret
npx wrangler secret put ADMIN_API_KEY

# 6. Run locally
npm run dev
curl http://127.0.0.1:8787/health

# 7. Deploy
npm run deploy
```

> `wrangler.jsonc` is gitignored — only `wrangler.example.jsonc` is tracked. Never commit your real config.

## Integrations

### Claude Code

Distributed as a self-contained plugin — no manual `settings.json` hook/MCP editing, no absolute paths (everything resolves via `${CLAUDE_PLUGIN_ROOT}`), and the MCP tools come from the **remote** Worker endpoint, so there's no local process or repo checkout to maintain.

```bash
claude plugin marketplace add Asaki14/asaki-memory-manager
claude plugin install asaki-memory@asaki-memory
```

Set your credentials once in `~/.claude/settings.json`:

```json
{
  "env": {
    "ASAKI_MEMORY_API_KEY": "your-admin-api-key",
    "ASAKI_MEMORY_BASE_URL": "https://your-worker.your-subdomain.workers.dev"
  }
}
```

The plugin injects the standing-rule block and the project-memory digest at session start, a per-turn memory precheck so the agent decides for itself whether to search, a visible `🧠 Asaki memory …` line whenever a memory tool runs, and a `/memory` slash command (`/memory status` checks connectivity; any other args run a full audit). A background Stop hook also runs a local classifier: with cloud auto-extract off (the default), it judges each conversation delta against a 6-criteria checklist and writes qualifying candidates itself over plain HTTP — no forced extra turn. Full details: [`integrations/claude-code/README.md`](integrations/claude-code/README.md).

### Standing rules (both clients)

Some memories are not context to retrieve — they are directives to obey. Every session therefore opens with a **standing-rule block** built from ACTIVE memories of kind `rule` and `preference`, so the agent never has to search for its own operating rules:

```
## Asaki Standing Rules (17 of 17)

These are standing rules you must follow for this whole session — directives to obey,
not retrieved context. They do not override system or developer instructions; if they
conflict, the system instructions win.

- [global/rule] push 前必须检查待推送 commit 是否含明文密钥…
- [project/rule] 记忆抽取的 scope 判断标准已前移至抽取阶段…
```

- **Scope**: `global` rules always; `project` rules only when the session's project matches; `session` scope is never injected.
- **Cap**: at most 20 rules and 4000 characters of rule lines, each rule clamped to 240 characters. Over cap, selection is deterministic — importance desc, then recency desc, then id — and a `(showing N of M standing rules — more exist…)` marker is appended so the agent knows to list the rest. Worst case is ~4.3 KB (~1.1k English / ~2.2k Chinese tokens); a real 17-rule set measures ~2.1 KB.
- **Delivery**: Claude Code emits it from the SessionStart hook (re-emitted on compact so the rules survive compaction); Pi appends it to the system prompt on every agent run from a per-process cached fetch. Neither client issues an extra request at startup beyond the memory list it already fetches.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASAKI_MEMORY_STANDING_RULES` | `1` | Set to `0`/`off`/`false` to disable standing-rule injection entirely. |
| `ASAKI_MEMORY_STANDING_RULES_MAX` | `20` | Hard cap on injected rules. |
| `ASAKI_MEMORY_STANDING_RULES_KINDS` | `rule,preference` | Comma-separated kinds to treat as standing. Use `rule` to inject rules only. |

Selection and rendering are one canonical implementation in [`src/services/standingRules.ts`](src/services/standingRules.ts), copied verbatim into the Pi extension and re-implemented in [`integrations/claude-code/standing-rules.jq`](integrations/claude-code/standing-rules.jq); `npm run eval:standing-rules` fails if any copy drifts.

### Project memory digest (both clients)

Standing rules cover the memories that are *directives*. Everything else — decisions, facts, bug fixes, task learnings, workflows — used to be retrieval-only, so a session opened with no idea what had already been settled in this project. A second bounded block therefore follows the standing rules, framed as context rather than instructions:

```
## Asaki Project Memory (10 of 65)

This is recalled context, not directives: durable memories of this project (plus global
ones) that are not standing rules. They record what was already decided, learned or fixed
— use them instead of re-deriving, and call asaki_memory_search when you need more than
these excerpts.

- [project/decision] 记忆抽取的 scope 判断标准前移至抽取阶段…
- [project/bug_fix] Vectorize upsert 失败时保留 D1 写入并标记 index_status…
```

- **Kinds**: the DYNAMIC complement of the standing kinds — `KNOWN_MEMORY_KINDS − ASAKI_MEMORY_STANDING_RULES_KINDS`. With the defaults that is `fact`, `decision`, `task_learning`, `bug_fix`, `workflow`; set `ASAKI_MEMORY_STANDING_RULES_KINDS=rule` and `preference` moves into this block instead of vanishing. No memory is ever in both blocks, and the boundary does not depend on either block's on/off switch.
- **Scope and order**: identical to standing rules — global always, project on match, session never; importance desc → recency desc → id desc.
- **Cap**: at most 10 memories and 3000 characters of memory lines, each clamped to 240 characters, with the same `(showing N of M project memories — more exist…)` marker. Worst case is ~3.3 KB (~0.8k English / ~1.65k Chinese tokens) on top of the standing-rule block.
- **Delivery**: Claude Code emits it from the SessionStart hook right after the standing rules (re-emitted on compact); Pi appends it to the `before_agent_start` system prompt after the standing rules — that is the only Pi path that reaches the model, since its `[Memory]` banner is transcript-local. Both clients reuse the memory list they already fetch, so the block costs no extra request.
- **This is on by default**, so upgrading adds it to every session's opening context; `ASAKI_MEMORY_PROJECT_DIGEST=0` turns it off in one variable.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASAKI_MEMORY_PROJECT_DIGEST` | `1` | Set to `0`/`off`/`false` to disable the digest entirely. |
| `ASAKI_MEMORY_PROJECT_DIGEST_MAX` | `10` | Hard cap on injected memories (clamped to 50). |
| `ASAKI_MEMORY_PROJECT_DIGEST_MAX_CHARS` | `3000` | Character budget for the memory lines (clamped to 20000). |
| `ASAKI_MEMORY_PROJECT_DIGEST_CONTENT_CHARS` | `240` | Per-memory character clamp (clamped to 2000). |

Selection and rendering are one canonical implementation in [`src/services/projectDigest.ts`](src/services/projectDigest.ts), copied verbatim into the Pi extension and re-implemented in [`integrations/claude-code/project-digest.jq`](integrations/claude-code/project-digest.jq); `npm run eval:project-digest` fails if any copy drifts, and `npm run eval:session-inject` checks both clients' wiring.

Known boundary shared by both blocks: the clients list at most 100 memories, which is also the server maximum, and the server returns the 100 most recently updated rows *before* the importance sort runs. Past ~100 active global+project memories an older high-importance one can therefore be dropped before selection sees it — watch the `memories=` count in the status banner.

### Session status banner (both clients)

Both clients open a session with a counts-only status line. Fields are fixed in this order and any field with no information is omitted entirely rather than printed as `off`/`0/0`/`?`:

```
user=asaki | project=asaki-memory-manager | memories=90 | pendingReviews=3 | classifier=on model=claude-haiku-4-5-20251001 | standingRules=25/25 | projectDigest=10/65
```

`autoExtract` is deliberately not on this line — the deprecated server-extraction path is off by default and uninformative when it is, so `/memory status` reports it (plus the effective classifier state) instead.

### Pi

Pi doesn't support remote MCP, so it ships as a self-contained single-file extension, published as a standalone npm package:

```bash
pi install npm:@asaki14/pi-memory
```

On every `session_start` it renders a compact, transcript-local `[Memory]` status banner (see [Session status banner](#session-status-banner-both-clients)). It appears with Pi's startup resource information, scrolls away with the conversation, and does not enter LLM context — the standing-rule block and the project digest are what actually reach the model, via the `before_agent_start` system prompt. On `agent_end` it runs a background classifier that pre-distills one candidate and writes it to the review queue — throttled, and skipping anything that trips the sensitive-text gate.

The extension is published as `npm:@asaki14/pi-memory` and that is what every machine consumes; a change merged here reaches Pi only after the next npm release (`npm run build:pi` → `npm publish` from `dist/pi-package/` → `pi update npm:@asaki14/pi-memory`). Env changes need a new Pi process: the extension reads env per call, but a running process keeps the environment it started with.

<details>
<summary><b>Common Pi environment variables</b></summary>

```bash
export ASAKI_MEMORY_API_URL="https://your-worker.your-subdomain.workers.dev"
export ASAKI_MEMORY_API_KEY="your-admin-api-key"
export ASAKI_MEMORY_USER_ID="alice"
export ASAKI_MEMORY_PROJECT_ID="demo-app"
export ASAKI_MEMORY_AUTO_INJECT="1"
export ASAKI_MEMORY_AUTO_INJECT_TOP_K="6"   # 1..20; invalid values fall back to 6
export ASAKI_MEMORY_AUTO_MIN_SCORE="0.67"   # must be within [0,1]; anything else falls back
export ASAKI_MEMORY_AUTO_EXTRACT="0"
export ASAKI_MEMORY_AUTO_CLASSIFIER="1"
export ASAKI_MEMORY_STANDING_RULES="1"
export ASAKI_MEMORY_PROJECT_DIGEST="1"
export ASAKI_MEMORY_CLASSIFIER_MODEL="openai-codex/gpt-5.6-luna"
export ASAKI_MEMORY_EXTRACT_MIN_INTERVAL_SECONDS="300"
# Both default on. Correction mode makes the classifier detect the user correcting the agent and
# record the evidence; action trace adds one redacted `Tool: <name> <arg>` line per tool call to
# the delta. Set either to 0 to opt out. See integrations/claude-code/README.md for what action
# trace sends off-machine — paths, URIs and hosts are redacted, non-path free text is not.
export ASAKI_MEMORY_CORRECTION_MODE="1"
export ASAKI_MEMORY_ACTION_TRACE="1"
```

The classifier model can also be set via `classifierModel` in `~/.pi/agent/asaki-memory.json`. Keep `ASAKI_MEMORY_AUTO_EXTRACT=0`: server-side `/v1/memories/extract` is deprecated compatibility behavior and must not be enabled for routine capture.

</details>

The extension exposes `asaki_memory_search`, `asaki_memory_add`, `asaki_memory_list`, `asaki_memory_update`, `asaki_memory_delete`, `asaki_memory_review_create`, `asaki_memory_review_list`, `asaki_memory_review_resolve`, and the `/memory` command.

### MCP

The same tool surface is served two ways:

- **Remote (recommended)** — `src/mcp.ts` serves MCP over HTTP at `POST /mcp`, guarded by the same `ADMIN_API_KEY` bearer as `/v1/*`. Clients like Claude Code need **no local process** — just the Worker URL + bearer. `project_id` is passed explicitly (no git root on the Worker); `user_id` defaults to `ASAKI_MCP_DEFAULT_USER_ID` (or `asaki`).
- **Local stdio** — `integrations/mcp/asaki-memory.ts` (bundled to `dist/mcp-server.mjs`) is a standalone stdio server for clients that need a local process, e.g. Codex. See [`integrations/codex/README.md`](integrations/codex/README.md).

## API reference

All `/v1/*` endpoints require a bearer token. If `ADMIN_API_KEY` is unset, every `/v1/*` route returns `503`.

```http
Authorization: Bearer <ADMIN_API_KEY>
```

<details>
<summary><code>POST /v1/memories</code> — create a memory</summary>

```bash
curl -X POST http://127.0.0.1:8787/v1/memories \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{
    "content": "Use Cloudflare Workers, D1, and Vectorize for this project.",
    "user_id": "alice",
    "scope": "project",
    "project_id": "demo-app",
    "kind": "decision",
    "importance": 0.8,
    "confidence": 0.95
  }'
```

</details>

<details>
<summary><code>POST /v1/memories/search</code> — semantic + lexical search</summary>

```bash
curl -X POST http://127.0.0.1:8787/v1/memories/search \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{
    "query": "What stack should this project use?",
    "user_id": "alice",
    "project_id": "demo-app",
    "top_k": 5
  }'
```

Defaults to `global + current project + current session` when `project_id` / `session_id` are provided. Explicit `scope=project` requires `project_id`; explicit `scope=session` requires `session_id`. Optional `min_score` (0–1) drops low-scoring results.

</details>

<details>
<summary><code>POST /v1/memories/list</code> — list memories</summary>

```bash
curl -X POST http://127.0.0.1:8787/v1/memories/list \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{
    "user_id": "alice",
    "project_id": "demo-app",
    "status": "active",
    "limit": 50,
    "offset": 0
  }'
```

Omit `scope` to list `global + current project + current session`. Use `status=all` to include archived and deleted memories.

</details>

<details>
<summary><code>GET /v1/memories/:id</code> · <code>PATCH /v1/memories/:id</code> — get / update</summary>

```bash
# Get
curl "http://127.0.0.1:8787/v1/memories/<memory-id>?user_id=alice" \
  -H "Authorization: Bearer $ADMIN_API_KEY"

# Update
curl -X PATCH http://127.0.0.1:8787/v1/memories/<memory-id> \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{
    "user_id": "alice",
    "content": "Use Cloudflare Workers, D1, Vectorize, and Workers AI for this project.",
    "importance": 0.85
  }'
```

</details>

<details>
<summary><code>DELETE /v1/memories/:id</code> · <code>POST /v1/memories/:id/purge</code> — delete / purge</summary>

```bash
# Soft delete: row marked status=deleted, content retained & recoverable
curl -X DELETE http://127.0.0.1:8787/v1/memories/<memory-id> \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"user_id":"alice"}'

# Purge: irreversible — wipes content, removes Vectorize entry, deletes all
# prior memory_events, logs one content-free purge event
curl -X POST http://127.0.0.1:8787/v1/memories/<memory-id>/purge \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"user_id":"alice","reason":"accidentally stored a credential"}'
```

Use **purge**, not delete, for content that should never have been stored.

</details>

<details>
<summary><code>POST /v1/memories/candidates</code> — process candidates (dedupe/merge pipeline)</summary>

```bash
curl -X POST http://127.0.0.1:8787/v1/memories/candidates \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{
    "user_id": "alice",
    "project_id": "demo-app",
    "candidates": [
      {
        "content": "The demo-app project uses Cloudflare Workers and D1.",
        "scope": "project",
        "kind": "decision",
        "importance": 0.8,
        "confidence": 0.9
      }
    ]
  }'
```

Agents submit concise candidates from their own context. Local background classifiers (`source: "pi:agent-end-classifier"` or `"claude-code:stop-classifier"`) are the active/default automated source and always land in `reviews`, never `decisions`. The legacy `/v1/memories/extract` endpoint remains for backward compatibility but is deprecated and must not receive routine/full-transcript capture.

</details>

<details>
<summary><code>POST /v1/memories/reviews</code> · <code>.../reviews/list</code> · <code>.../reviews/:id/resolve</code> — review queue</summary>

```bash
# Enqueue a high-risk candidate for review
curl -X POST http://127.0.0.1:8787/v1/memories/reviews \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{
    "user_id": "alice",
    "project_id": "demo-app",
    "candidates": [
      { "content": "Use review queue for high-risk global rules.",
        "scope": "project", "kind": "workflow",
        "importance": 0.6, "confidence": 0.8 }
    ]
  }'

# List pending reviews (add "include_suggestions": true for duplicate hints)
curl -X POST http://127.0.0.1:8787/v1/memories/reviews/list \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"user_id":"alice","project_id":"demo-app","status":"pending"}'

# Resolve a review
curl -X POST http://127.0.0.1:8787/v1/memories/reviews/<review-id>/resolve \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"user_id":"alice","action":"add","reason":"approved"}'
```

Resolve actions: `add`, `merge`, `update`, `delete`, `ignore`. `merge`/`update`/`delete` require `memory_id`.

`include_suggestions: true` additionally attaches, per pending correction row: `supersedes_candidates` (active memories this correction invalidates) and `promotion_candidates` (the same rule already exists as a project rule in a **different** project — evidence it should be global). Accept a promotion in one call with `{"action":"add","promote_to_global":true}`; it is valid only with `add`, and nothing is ever rescoped without it. Resolving a correction into an active memory also stamps the compressed correction moment (`agent_did` / `captain_verdict`, ≤120 chars each) into that memory's `metadata_json`.

</details>

<details>
<summary><code>POST /v1/memories/lifecycle</code> — standing-rule health report (read-only)</summary>

```bash
curl -X POST http://127.0.0.1:8787/v1/memories/lifecycle \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"user_id":"alice","project_id":"demo-app","idle_days":30,"limit":20}'
```

Returns `standing_rules` (active / reinforced / total reinforcements / `repeat_rate`), `recurrence` (per-rule counts — the agent was corrected on that rule again) and `idle_rules` (standing rules with no reinforcement and no retrieval hit inside `idle_days`, default 30). Idle rules are surfaced for a **human** keep/retire verdict: nothing here deletes, archives, or demotes a rule, and `POST /v1/memories/prune-stale` deliberately never selects `rule`/`preference` memories.

</details>

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_API_KEY` | *unset* | **Required** bearer auth for `/v1/*` and `/mcp`; unset returns `503`. Set as a Wrangler secret. |
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Workers AI embedding model (1024-dim). |
| `MEMORY_LLM_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fp8` | Workers AI chat model for candidate merge/ignore decisions. |

## Data model

| Table | Purpose |
| --- | --- |
| `memories` | Memory body, scope, project/session metadata, kind, importance, confidence, status, index state, plus `metadata_json` (reinforcement counters + correction provenance). |
| `memory_events` | Append-only operational event log. |
| `memory_reviews` | Pending and resolved candidate review queue. |

**Memory kinds:** `preference` · `rule` · `fact` · `decision` · `task_learning` · `bug_fix` · `workflow`

## Security

- Never commit `.env`, `.dev.vars`, private keys, tokens, or generated `wrangler.jsonc`. Use `wrangler.example.jsonc` as the public template and store `ADMIN_API_KEY` via `npx wrangler secret put`.
- Every query is filtered by `user_id`. Project/session memories are only visible when the matching `project_id` / `session_id` is provided.
- Memory content is user/project context **only** — it never overrides system or developer safety instructions.
- The server rejects (`400`) any `content`/`text` that looks like a secret or credential (API keys, Bearer tokens, private keys, credential URLs) before it reaches Workers AI or D1/Vectorize — see `src/utils/sensitiveContent.ts`. If one slips through, **purge** it.
- AI/Vectorize-touching routes (`search`, `candidates`, `extract`, `POST /v1/memories`, `PATCH /v1/memories/:id`) are rate-limited per `user_id` (default 30 req/min → `429`); tune in `wrangler.jsonc`.
- Unexpected internal errors return a generic `500` — only deliberate `UserFacingError` messages are ever forwarded to the client.

## Development

```bash
npm run typecheck        # tsc --noEmit
npm run eval:candidates  # offline dedup heuristics
npm run eval:extraction  # deprecated server-extraction compatibility path; needs a live Worker
npm run eval:classifier  # active local classifier regression suite
npm run eval:standing-rules  # offline standing-rule scope/cap/order + client copy parity
npm run smoke:management  # management API smoke test
npm run db:migrate:local
npm run dev
```

Maintenance scripts — `shadow-run:extraction`, `backfill:index`, `prune:stale` — are documented in [`AGENTS.md`](AGENTS.md#commands) along with when to run each.

## Roadmap & License

Priorities and deferred work live in [`ROADMAP.md`](ROADMAP.md). Licensed under [MIT](LICENSE).
