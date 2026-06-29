<div align="center">

# Asaki Memory Manager

**A Cloudflare-native memory layer for AI agents.**

Self-host long-term memory with Workers, D1, Vectorize, Workers AI, REST APIs, and optional Pi agent integration.

[![CI](https://img.shields.io/badge/CI-typecheck-blue)](#development)
[![Runtime](https://img.shields.io/badge/runtime-Cloudflare%20Workers-f38020)](https://workers.cloudflare.com/)
[![Framework](https://img.shields.io/badge/framework-Hono-e36002)](https://hono.dev/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

</div>

## Why

AI coding agents are better when they remember durable facts: user preferences, project conventions, architectural decisions, bug fixes, and workflows. Asaki Memory Manager provides a small self-hosted memory service designed for personal and team agents without running a Docker stack or external vector database.

## Features

- **Cloudflare-native**: Workers + D1 + Vectorize + Workers AI.
- **REST-first API**: simple endpoints for write, search, candidate processing, and extraction.
- **Scoped memory**: `global`, `project`, and `session` memories with project/session isolation.
- **Hybrid retrieval**: Vectorize semantic search fused with D1 lexical fallback.
- **mem0-like pipeline**: extract durable memories from messages, then add / merge / ignore candidates.
- **Deterministic duplicate guards**: exact, subset, and technical-token paraphrase checks before LLM decisions.
- **Safe extraction defaults**: ignores temporary chat, command output, reload/self-test markers, diagnostics, and secrets.
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
        +--> Workers AI chat model: extraction / candidate decisions
        +--> D1: source of truth for memories, events, projects, API keys
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

All `/v1/*` endpoints require this header when `ADMIN_API_KEY` is configured:

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

Search defaults to `global + current project + current session` when `project_id` / `session_id` are provided. Explicit `scope=project` requires `project_id`; explicit `scope=session` requires `session_id`.

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

### Extract memories from messages

```bash
curl -X POST http://127.0.0.1:8787/v1/memories/extract \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -d '{
    "user_id": "alice",
    "project_id": "demo-app",
    "source": "chat",
    "messages": [
      {
        "role": "user",
        "content": "For this project, always use Cloudflare Workers + D1 + Vectorize. Do not introduce Postgres."
      },
      {
        "role": "assistant",
        "content": "Understood."
      }
    ]
  }'
```

## Pi integration

A Pi extension is included at:

```text
integrations/pi/asaki-memory.ts
```

Install it into your Pi agent extensions directory, then set environment variables or a local config file according to your Pi setup.

Common environment variables:

```bash
export ASAKI_MEMORY_API_URL="https://your-worker.your-subdomain.workers.dev"
export ASAKI_MEMORY_API_KEY="your-admin-api-key"
export ASAKI_MEMORY_USER_ID="alice"
export ASAKI_MEMORY_PROJECT_ID="demo-app"
export ASAKI_MEMORY_AUTO_INJECT="1"
export ASAKI_MEMORY_AUTO_EXTRACT="1"
export ASAKI_MEMORY_AUTO_MIN_SCORE="0.70"
```

The extension exposes:

- `asaki_memory_search`
- `asaki_memory_add`
- `asaki_memory_list`
- `asaki_memory_update`
- `asaki_memory_delete`

## MCP integration

A shared MCP server is included at:

```text
integrations/mcp/asaki-memory.ts
```

Provider setup notes live in:

```text
integrations/claude-code/README.md
integrations/codex/README.md
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `EMBEDDING_MODEL` | `@cf/baai/bge-m3` | Workers AI embedding model |
| `MEMORY_LLM_MODEL` | `@cf/meta/llama-3.1-8b-instruct-fp8` | Workers AI chat model for extraction and candidate decisions |
| `ADMIN_API_KEY` | unset | Optional bearer-token auth for `/v1/*`; set as Wrangler secret |

## Data model

Core tables:

- `memories`: memory body, scope, project/session metadata, kind, importance, confidence, status, index state.
- `memory_events`: append-only operational events.
- `memory_sources`: optional source references.
- `projects`: project metadata.
- `api_keys`: reserved for table-driven auth.

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

## Development

```bash
npm run typecheck
npm run db:migrate:local
npm run dev
```

## Roadmap

- Table-driven API keys.
- Memory list / update / delete / review APIs.
- Pending embedding retry cron.
- Expiring session memory cleanup.
- Optional MCP server for cross-client integrations.
- Import/export and lightweight management UI.

## License

MIT
