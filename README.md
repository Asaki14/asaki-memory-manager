<div align="center">

# Asaki Memory Manager

**A Cloudflare-native memory layer for AI agents.**

Self-host long-term memory with Workers, D1, Vectorize, REST APIs, Workers AI assistance, and optional Pi agent integration.

[![CI](https://img.shields.io/badge/CI-typecheck-blue)](#development)
[![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-f38020)](https://workers.cloudflare.com/)
[![Framework](https://img.shields.io/badge/framework-Hono-e36002)](https://hono.dev/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

## Why

AI coding agents are better when they remember durable facts: user preferences, project conventions, architectural decisions, bug fixes, and workflows. Asaki Memory Manager provides a small self-hosted personal memory service — a single-operator agent memory layer without running a Docker stack or external vector database.

## Features

- **Cloudflare-native**: Workers + D1 + Vectorize + Workers AI.
- **REST-first API**: simple endpoints for write, search, candidate processing, and management.
- **Scoped memory**: `global`, `project`, and `session` memories with project/session isolation.
- **Hybrid retrieval**: Vectorize semantic search fused with D1 lexical fallback.
- **Agent-side extraction**: the active agent decides what is worth remembering, then submits concise candidates.
- **Cloudflare-side organization**: validate, dedupe, add / merge / ignore, and index memories.
- **Deterministic duplicate guards**: exact, subset, and technical-token paraphrase checks before LLM decisions.
- **Graceful local fallback**: when AI or Vectorize are unavailable locally, D1 write/search still works.
- **Optional Pi integration**: a global Pi extension is included under `integrations/pi/asaki-memory.ts`.

## Architecture

```text
Agent / App / Pi Extension
        |
        v
Cloudflare Worker (Hono + REST)
        |
        +--> Workers AI embedding: @cf/baai/bge-m3
        +--> Workers AI chat model: candidate decisions
        +--> D1: source of truth for memories, events, reviews
        +--> Vectorize: semantic index with metadata filters
```

D1 is the source of truth. Vectorize is an index. If vector upsert fails, the memory remains stored with `index_status=pending`.

## Quickstart

### 1. Install

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
npx wrangler login
npx wrangler d1 create asaki-memory-manager
npx wrangler vectorize create asaki-memory-manager --dimensions 1024 --metric cosine
npx wrangler vectorize create-metadata-index asaki-memory-manager --propertyName user_id --type string
npx wrangler vectorize create-metadata-index asaki-memory-manager --propertyName scope --type string
npx wrangler vectorize create-metadata-index asaki-memory-manager --propertyName project_id --type string
npx wrangler vectorize create-metadata-index asaki-memory-manager --propertyName session_id --type string
npx wrangler vectorize create-metadata-index asaki-memory-manager --propertyName kind --type string
```

### 3. Configure Wrangler

```bash
cp wrangler.example.jsonc wrangler.jsonc
```

Edit `wrangler.jsonc` and replace:

```json
"database_id": "replace-with-your-d1-database-id"
```

### 4. Apply migrations

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

### 5. Set production API auth

```bash
npx wrangler secret put ADMIN_API_KEY
```

### 6. Run locally

```bash
npm run dev
curl http://127.0.0.1:8787/health
```

### 7. Deploy

```bash
npm run deploy
```

## API

`ADMIN_API_KEY` must be configured — all `/v1/*` endpoints return `503` if it is unset, and require this header otherwise:

```http
Authorization: Bearer <ADMIN_API_KEY>
```

### Create memory

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

### Search memories

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

Search defaults to `global + current project + current session` when `project_id` / `session_id` are provided. Explicit `scope=project` requires `project_id`; explicit `scope=session` requires `session_id`. Optional `min_score` (0-1) drops results below that score.

### List memories

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

### Get memory

```bash
curl "http://127.0.0.1:8787/v1/memories/<memory-id>?user_id=alice" \
  -H "Authorization: Bearer $ADMIN_API_KEY"
```

### Update memory

```bash
curl -X PATCH http://127.0.0.1:8787/v1/memories/<memory-id> \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{
    "user_id": "alice",
    "content": "Use Cloudflare Workers, D1, Vectorize, and Workers AI for this project.",
    "importance": 0.85
  }'
```

### Delete memory

```bash
curl -X DELETE http://127.0.0.1:8787/v1/memories/<memory-id> \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"user_id":"alice"}'
```

Delete is soft delete: the row is marked `status=deleted`, content is retained and recoverable.

### Purge memory

```bash
curl -X POST http://127.0.0.1:8787/v1/memories/<memory-id>/purge \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"user_id":"alice","reason":"accidentally stored a credential"}'
```

Unlike delete, purge is irreversible: it wipes the memory's `content` (replaced with `[purged]`), removes its Vectorize entry, and deletes every prior `memory_events` row for it, then logs a single content-free `purge` event. Use this — not delete — for content that should never have been stored.

### Process candidates

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

Agents should extract durable memories from their own conversation context and submit concise candidates to `/v1/memories/candidates`. The Worker does not accept full conversation transcripts for extraction. Candidates from an unsupervised background classifier (`source: "pi:agent-end-classifier"` or `"claude-code:stop-classifier"`) always land in `reviews`, never `decisions` — only a human-in-the-loop write can auto-add/merge/update/delete.

### Review queue

```bash
curl -X POST http://127.0.0.1:8787/v1/memories/reviews \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{
    "user_id": "alice",
    "project_id": "demo-app",
    "candidates": [
      {
        "content": "Use review queue for high-risk global rules.",
        "scope": "project",
        "kind": "workflow",
        "importance": 0.6,
        "confidence": 0.8
      }
    ]
  }'
```

```bash
curl -X POST http://127.0.0.1:8787/v1/memories/reviews/list \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"user_id":"alice","project_id":"demo-app","status":"pending"}'
```

```bash
curl -X POST http://127.0.0.1:8787/v1/memories/reviews/<review-id>/resolve \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{"user_id":"alice","action":"add","reason":"approved"}'
```

Resolve actions: `add`, `merge`, `update`, `delete`, `ignore`. `merge`/`update`/`delete` require `memory_id`. Pass `include_suggestions: true` to `/v1/memories/reviews/list` to attach a `potential_duplicate` hint (matched memory + heuristic-suggested action) to each pending review.

## Claude Code integration

Distributed as a self-contained Claude Code plugin — no manual `settings.json`
hook/MCP editing, no absolute paths baked in (everything resolves via
`${CLAUDE_PLUGIN_ROOT}`).

```bash
claude plugin marketplace add /path/to/asaki-memory-manager
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

What it does: injects a real project-history digest at session start (no
"go search yourself" nudge), a memory-precheck instruction on every turn so
the agent decides for itself whether to call `asaki_memory_search`, a
visible `🧠 Asaki memory ...` line whenever a memory tool actually runs, and a
`/memory` slash command (`/memory status` checks backend connectivity; any
other args run a full audit) — same audit workflow as the Pi extension. A
Stop hook also runs a local classifier in the background on every turn: with
cloud auto-extract off (the default), it judges the conversation delta
against a 6-criteria checklist and, for a qualifying candidate, writes it
itself over plain HTTP (same server-side dedup/merge pipeline as
`asaki_memory_add`) — no forced extra turn for the main agent, just a
one-line `🧠 Asaki-memory: add "..."` report on the next turn. Set
`ASAKI_MEMORY_AUTO_INJECT=1` to also mirror the Pi extension's deterministic
keyword-triggered auto-inject before the agent starts (same
`ASAKI_MEMORY_AUTO_INJECT_ALWAYS`/`ASAKI_MEMORY_AUTO_MIN_SCORE` knobs as
above). Full details: [`integrations/claude-code/README.md`](integrations/claude-code/README.md).

## Pi integration

Pi doesn't support remote MCP, so the Pi side ships as a self-contained
extension (single file, no backend source). It's published as a standalone npm
package so you don't need this repo checked out locally:

```bash
pi install npm:@asaki14/pi-memory
```

The source of truth is `integrations/pi/asaki-memory.ts` in this monorepo; the
publishable package is generated by `npm run build:pi` (stages `dist/pi-package/`)
and published with `npm publish` from there. For local development against this
working copy, `pi install /path/to/asaki-memory-manager` still works (Pi resolves
a local source live from the directory).

Then set environment variables or a local config file according to your Pi
setup.

Common environment variables:

```bash
export ASAKI_MEMORY_API_URL="https://your-worker.your-subdomain.workers.dev"
export ASAKI_MEMORY_API_KEY="your-admin-api-key"
export ASAKI_MEMORY_USER_ID="alice"
export ASAKI_MEMORY_PROJECT_ID="demo-app"
export ASAKI_MEMORY_AUTO_INJECT="1"
export ASAKI_MEMORY_AUTO_MIN_SCORE="0.67"
export ASAKI_MEMORY_AUTO_EXTRACT="0"
export ASAKI_MEMORY_AUTO_CLASSIFIER="1"
export ASAKI_MEMORY_CLASSIFIER_MODEL="opencode/deepseek-v4-flash-free"
export ASAKI_MEMORY_EXTRACT_MIN_INTERVAL_SECONDS="300"
export ASAKI_MEMORY_STARTUP_INJECT="1"
export ASAKI_MEMORY_STARTUP_TOP_K="6"
```

On every `session_start` (new/resume/fork, not plain extension `reload`), the
next turn's `before_agent_start` injects a compact status banner with user,
project, memory count, pending review count, auto-extract state, and classifier state. It also injects (default on; set `ASAKI_MEMORY_STARTUP_INJECT=0` or `startupInject: false` in the local config file to disable) the top `ASAKI_MEMORY_STARTUP_TOP_K` (default 6) highest-importance active memories as hidden startup context; the Pi TUI renderer displays only the compact first line. A fixed memory-precheck instruction also fires every turn so the
agent decides for itself whether to call `asaki_memory_search`/`asaki_memory_add`.
`ASAKI_MEMORY_AUTO_INJECT` (default off) additionally does a deterministic
keyword-triggered search on top of that judgment call.

`ASAKI_MEMORY_AUTO_EXTRACT` (default off) enables Pi-native background
server extraction on `agent_end`: the extension sends only text user/assistant
messages from that prompt to `/v1/memories/extract`, excluding tool results,
tool calls, and thinking blocks. It intentionally sends conversation text
off-machine to the Worker. The extraction endpoint caps candidates at 2 per
call and only auto-adds project-scope candidates with importance ≥ 0.6 —
global-scope or lower-importance candidates are queued to
`/v1/memories/reviews` for human review instead of being written directly.

When `ASAKI_MEMORY_AUTO_EXTRACT=0` and `ASAKI_MEMORY_AUTO_CLASSIFIER` is not
disabled, Pi instead runs an `agent_end` classifier in the background using the
same headless Pi model-call pattern as the local `atomic-commit` extension.
Default model: `opencode/deepseek-v4-flash-free`; override with
`ASAKI_MEMORY_CLASSIFIER_MODEL` or `classifierModel` in
`~/.pi/agent/asaki-memory.json`. The classifier judges the delta locally via
Pi, pre-distills one `text`/`type`/`scope` candidate, then the extension writes
it over plain HTTP to `/v1/memories/candidates` so the normal server-side
dedup/merge pipeline decides the real action. No extra agent turn is forced.
Both modes are throttled to at most once per
`ASAKI_MEMORY_EXTRACT_MIN_INTERVAL_SECONDS` (default 300 seconds), and both
skip deltas matching the sensitive-text gate.

The extension exposes:

- `asaki_memory_search`
- `asaki_memory_add`
- `asaki_memory_list`
- `asaki_memory_update`
- `asaki_memory_delete`
- `asaki_memory_review_create`
- `asaki_memory_review_list`
- `asaki_memory_review_resolve`
- `/memory` command (`/memory status` checks backend connectivity; no args runs a full audit)

## MCP integration

The MCP tools are served two ways from the same tool surface:

- **Remote (recommended)** — `src/mcp.ts` serves the MCP protocol over HTTP at
  `POST /mcp` inside the Worker, guarded by the same `ADMIN_API_KEY` bearer as
  `/v1/*`. Clients that support remote HTTP MCP (e.g. Claude Code, which the
  plugin above now configures this way) need **no local process or repo
  checkout** — just the Worker URL + bearer. Because the Worker has no git
  checkout, `project_id` is passed explicitly by the agent rather than derived
  from a git root, and `user_id` defaults to `ASAKI_MCP_DEFAULT_USER_ID` (or
  `asaki`).
- **Local stdio** — `integrations/mcp/asaki-memory.ts` (bundled to
  `dist/mcp-server.mjs`) is a standalone stdio MCP server for clients that need
  a local process (e.g. Codex). See
  [`integrations/claude-code/README.md`](integrations/claude-code/README.md) and
  [`integrations/codex/README.md`](integrations/codex/README.md) for
  provider-specific setup notes.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Workers AI embedding model |
| `MEMORY_LLM_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fp8` | Workers AI chat model for candidate merge/ignore decisions |
| `ADMIN_API_KEY` | unset | **Required** bearer-token auth for `/v1/*`; unset returns `503`. Set as Wrangler secret |

## Data model

Core tables:

- `memories`: memory body, scope, project/session metadata, kind, importance, confidence, status, index state.
- `memory_events`: append-only operational events.
- `memory_reviews`: pending and resolved candidate review queue.

Memory kinds:

```text
preference | rule | fact | decision | task_learning | bug_fix | workflow
```

## Security notes

- Do not commit `.env`, `.dev.vars`, private keys, tokens, or generated `wrangler.jsonc` files.
- Use `wrangler.example.jsonc` as the public template.
- Store `ADMIN_API_KEY` with `npx wrangler secret put ADMIN_API_KEY`.
- Every query is filtered by `user_id`.
- Project/session memories are only visible when the matching `project_id` / `session_id` is provided.
- Memory content is user/project context only. It should never override system or developer safety instructions.
- The server rejects (`400`) any `content`/`text` that looks like a secret or credential (API keys, Bearer tokens, private keys, credential URLs, etc.) before it reaches Workers AI or D1/Vectorize — see `src/utils/sensitiveContent.ts`. If one slips through anyway, purge it (see above) rather than deleting it.
- `/v1/memories/search`, `/v1/memories/candidates`, and `/v1/memories/extract` (the routes that trigger Workers AI embeddings/LLM calls and Vectorize queries) are protected by a Cloudflare Rate Limiting binding, keyed per `user_id`. Requests over the limit get `429`. Default is 30 requests/minute per user; adjust `ratelimits[].simple.limit`/`simple.period` in `wrangler.jsonc`.

## Development

```bash
npm run typecheck
npm run eval:candidates
npm run eval:extraction
npm run eval:classifier
npm run smoke:management
npm run db:migrate:local
npm run dev
```

Other maintenance scripts: `shadow-run:extraction`, `backfill:index`,
`prune:stale` — see [`AGENTS.md`](AGENTS.md#commands) for full command
reference and when to run each.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md) for current priorities and deferred work.

## License

MIT
