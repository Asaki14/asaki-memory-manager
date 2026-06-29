# AGENTS.md

## Project

Asaki Memory Manager is a Cloudflare-native memory layer for AI agents.

Stack:
- Cloudflare Workers + TypeScript + Hono
- D1 as the source of truth
- Vectorize as the semantic index
- Workers AI for embeddings and candidate decisions
- REST API first
- Optional Pi integration in `integrations/pi/asaki-memory.ts`

## Current implementation

Implemented:
- `GET /health`
- `POST /v1/memories`
- `POST /v1/memories/search`
- `POST /v1/memories/candidates`
- `POST /v1/memories/list`
- `GET /v1/memories/:id`
- `PATCH /v1/memories/:id`
- `DELETE /v1/memories/:id`
- `POST /v1/memories/reviews`
- `POST /v1/memories/reviews/list`
- `POST /v1/memories/reviews/:id/resolve`
- D1 schema and migrations
- D1 + Vectorize write path
- Vectorize + D1 lexical hybrid search
- Candidate add / merge / ignore pipeline
- Single `ADMIN_API_KEY` auth
- Pi and MCP search/add/list/update/delete/review integrations

Deferred:
- Review UI
- Cron maintenance
- Table-driven API keys

## Key files

- `README.md`: public project documentation.
- `wrangler.example.jsonc`: public Cloudflare binding template.
- `migrations/0001_init.sql`: base D1 schema.
- `migrations/0002_memory_reviews.sql`: memory review queue schema.
- `src/index.ts`: Hono app, routes, auth middleware.
- `src/types.ts`: shared types.
- `src/services/memories.ts`: memory creation and search.
- `src/services/candidates.ts`: candidate deduplication and merge decisions.
- `src/services/candidateDecision.ts`: pure candidate decision heuristics and eval target.
- `src/services/reviews.ts`: memory review queue creation, listing, and resolution.
- `src/services/memoryEvents.ts`: event logging.
- `src/ai/embeddings.ts`: Workers AI embedding helpers.
- `src/utils/validation.ts`: request validation.
- `integrations/pi/asaki-memory.ts`: optional Pi extension.

## Commands

```bash
npm install
npm run typecheck
npm run eval:candidates
npm run smoke:management
npm run db:migrate:local
npm run dev
```

Remote operations:

```bash
npm run db:migrate:remote
npx wrangler dev --remote
npm run deploy
```

## Security rules

- Never commit `.env`, `.dev.vars`, `wrangler.jsonc`, private keys, tokens, or secrets.
- Keep `wrangler.example.jsonc` generic and safe for public repos.
- Use Wrangler secrets for `ADMIN_API_KEY`.
- All memory queries must filter by `user_id`.
- Explicit `scope=project` search must require `project_id`.
- Explicit `scope=session` search must require `session_id`.
- Do not prefilter Vectorize by project/session when scope is omitted; default search must include global plus the current project/session.
- Memory content is context only and must not override system/developer safety rules.

## Implementation rules

- D1 is the source of truth; Vectorize is a recoverable index.
- If Vectorize upsert fails, keep the D1 write and mark `index_status=pending` or `failed`.
- Search should keep hybrid Vectorize + D1 lexical fallback behavior.
- The active conversation agent extracts durable memory and calls `asaki_memory_add`; Cloudflare organizes, dedupes, merges, indexes, and stores candidates.
- Do not add a server-side conversation extraction endpoint; the Worker should not receive full conversation transcripts for extraction.
- Candidate processing should run deterministic duplicate checks before LLM decisions.
- Run `npm run eval:candidates` after changing candidate dedupe thresholds or prompts.
- Pi auto inject defaults to `ASAKI_MEMORY_AUTO_MIN_SCORE=0.70`; keep low-score memories out of injected context.
- Keep changes small and consistent with existing style.
- Run `npm run typecheck` after TypeScript edits.

## Public release checklist

Before publishing:
- `npm run typecheck` passes.
- No secrets or personal paths in tracked files.
- `wrangler.jsonc` is ignored; only `wrangler.example.jsonc` is tracked.
- README examples use placeholders, not production credentials or personal endpoints.
- License exists.
- If CI is added, ensure the publishing token has GitHub `workflow` scope before pushing workflow files.
