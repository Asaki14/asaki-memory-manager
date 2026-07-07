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

## Documentation roles

- `README.md`: public overview, setup, API, integration docs.
- `ROADMAP.md`: planning source of truth, priorities, deferred work.
- `AGENTS.md`: agent-only project context, commands, rules, workflows.
- Do not recreate `PLAN.md`; keep docs concise and non-overlapping.

## Key files

- `ROADMAP.md`: project priorities and future work.
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
- `src/services/extraction.ts`: LLM extraction prompt (`SYSTEM_PROMPT`) + deterministic noise pre-filter.
- `integrations/pi/asaki-memory.ts`: optional Pi extension.
- `commands/memory.md`: Claude Code plugin `/memory` slash command (audit workflow; mirrors the Pi extension's `registerCommand("memory", ...)`).
- The "Global scope discipline" text lives in three places that must stay in sync: `commands/memory.md`, `integrations/pi/asaki-memory.ts`'s `/memory` command, and (condensed) `src/services/extraction.ts`'s `SYSTEM_PROMPT` — the first two apply it at audit time, the third applies it at extraction time.

## Commands

```bash
npm install
npm run typecheck
npm run eval:candidates
npm run eval:extraction
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
- The active conversation agent can call `asaki_memory_add` directly with a pre-distilled memory, or hand raw text to `POST /v1/memories/extract` (`asaki_memory_extract` MCP tool) for server-side LLM extraction; Cloudflare organizes, dedupes, merges, indexes, and stores candidates either way. The Claude Code Stop hook (`integrations/claude-code/stop-extract.sh`) uses the raw-text path, sending new plain-text conversation deltas off-machine for background extraction — this is a deliberate reversal of an earlier no-transcripts-off-machine stance.
- Candidate processing should run deterministic duplicate checks before LLM decisions.
- Run `npm run eval:candidates` after changing candidate dedupe thresholds or prompts.
- Run `npm run eval:extraction` after changing the extraction prompt (`src/services/extraction.ts`); it hits a live Worker (defaults to production) since `env.AI.run()` needs a real Worker runtime. Add a new case to `test/fixtures/extraction-cases.json` whenever a production false positive/negative turns up.
- Pi auto inject defaults to `ASAKI_MEMORY_AUTO_MIN_SCORE=0.50`; keep low-score memories out of injected context.
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
