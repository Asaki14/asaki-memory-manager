# AGENTS.md

## Project

Asaki Memory Manager is a Cloudflare-native personal memory layer for AI agents — single-operator, not a multi-tenant/team product.

Stack:
- Cloudflare Workers + TypeScript + Hono
- D1 as the source of truth
- Vectorize as the semantic index
- Workers AI for embeddings and candidate decisions
- REST API first
- Optional Pi integration in `integrations/pi/asaki-memory.ts`

## Integration install/update

The Claude Code plugin is consumed straight from this repo; the Pi extension is consumed as a published npm package. After changing anything under `integrations/`, `commands/memory.md`, or `.claude-plugin/`, push to `main` and re-sync however each side expects (do NOT hand-copy files into either agent's install dir — that's what caused both to drift stale before this was set up):

- **Claude Code**: the plugin's `.mcp.json` now references the **remote** MCP endpoint (`type: http`, `${ASAKI_MEMORY_BASE_URL}/mcp`, bearer auth) served by the Worker (`src/mcp.ts`) — no local node process, no `dist/mcp-server.mjs` needed by Claude Code (that bundle stays for other stdio clients like Codex). Hooks stay local shell scripts under `integrations/claude-code/`. `.claude-plugin/plugin.json` intentionally has no `version` field — with a git-backed marketplace source, Claude Code derives the plugin version from the commit SHA, so every push is a new version. This only works because the marketplace source is registered as `{"source": "github", "repo": "Asaki14/asaki-memory-manager"}` (see `~/.claude/settings.json`'s `extraKnownMarketplaces.asaki-memory`), not `directory` — a `directory` source has no commit SHA and never re-syncs on its own. `autoUpdate: true` on that marketplace entry refreshes it on every Claude Code startup; to sync without restarting, run `claude plugin marketplace update asaki-memory && claude plugin update asaki-memory@asaki-memory` (restart still required for an already-running session to pick it up).
- **Pi**: `package.json`'s `"pi": { "extensions": [...] }` field is Pi's own package manifest, declaring `integrations/pi/asaki-memory.ts` as the extension entry point (Pi looks for a `pi` key in `package.json`, same convention as an npm package). ALL machines — including this working copy — consume it as the published npm package `npm:@asaki14/pi-memory` (verified 2026-07-11: `~/.pi/agent/settings.json` packages list + `~/.pi/agent/npm/package.json`; an earlier local-path install was replaced at some point, so local edits do NOT take effect until published). Do NOT install from the git monorepo (Pi git sources clone the whole repo — no subpath support). Release flow: bump the root `package.json` version (the pi package inherits it), `npm run build:pi` (stages `dist/pi-package/` with just the single extension file + a minimal `pi`-key `package.json`), `npm publish` from `dist/pi-package/`, then on each machine `pi update npm:@asaki14/pi-memory`. Source of truth stays at `integrations/pi/asaki-memory.ts` — the build is a one-way sync, not a fork; never edit `dist/pi-package/` by hand.

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
- `src/utils/errors.ts`: `UserFacingError` — the only service-thrown error class whose message route handlers forward to API clients; any other exception falls through to the sanitized generic 500.
- `src/utils/sensitiveContent.ts`: server-side secret/credential detection gate, applied in `validateCreateMemory`/`validateUpdateMemory`/`validateExtractMemories` before any Workers AI call or D1/Vectorize write. Client-side copies in `integrations/pi/asaki-memory.ts`, `integrations/claude-code/stop-extract.sh`, and `scripts/shadow-run-extraction.ts` are a separate, known-stale pattern set — not kept in sync with this file.
- `src/services/extraction.ts`: LLM extraction prompt (`SYSTEM_PROMPT`) + deterministic noise pre-filter.
- `integrations/pi/asaki-memory.ts`: optional Pi extension.
- `commands/memory.md`: Claude Code plugin `/memory` slash command (audit workflow; mirrors the Pi extension's `registerCommand("memory", ...)`).
- `scripts/shadow-run-extraction.ts`: shadow-run calibration tool — runs `/v1/memories/extract` in `dry_run` mode against a transcript and diffs cloud candidates against real agent-added memories, without writing anything.
- `scripts/backfill-index.ts`: manual Vectorize backfill trigger — calls `POST /v1/memories/backfill-index` (`backfillPendingIndex()` in `src/services/memories.ts`) in a loop to re-embed and re-upsert memories stuck at `index_status` `pending`/`failed`.
- `scripts/prune-stale.ts`: manual stale-memory cleanup — calls `POST /v1/memories/prune-stale` (`pruneStaleMemories()` in `src/services/memories.ts`) to soft-delete memories not accessed in N days. Defaults to dry-run; `--apply` is required to actually delete.
- `scripts/eval-classifier.sh`: regression eval for the Claude Code local Stop-hook memory-candidate classifier (the `AUTO_EXTRACT=0` branch of `integrations/claude-code/stop-extract.sh`) — hits `claude -p --safe-mode` for real against `test/fixtures/classifier-cases.json`, no Worker/API key needed since nothing gets written.
- The "Global scope discipline" text lives in five places that must stay in sync: `commands/memory.md`, `integrations/pi/asaki-memory.ts`'s `/memory` command, (condensed) `src/services/extraction.ts`'s `SYSTEM_PROMPT`, (condensed) `integrations/claude-code/stop-extract.sh`'s `CLASSIFIER_SYSTEM_PROMPT`, and (condensed) `integrations/pi/asaki-memory.ts`'s `CLASSIFIER_SYSTEM_PROMPT` — the first two apply it at audit time, the latter three apply it at extraction/classification time.

## Commands

```bash
npm install
npm run typecheck
npm run eval:candidates
npm run eval:extraction
npm run eval:classifier
npm run shadow-run:extraction -- <transcript.jsonl> --user <id> --project <id>
npm run backfill:index -- --limit 50
npm run prune:stale -- --days 90
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
- The active conversation agent can call `asaki_memory_add` directly with a pre-distilled memory, or hand raw text to `POST /v1/memories/extract` (`asaki_memory_extract` MCP tool) for server-side LLM extraction; Cloudflare organizes, dedupes, merges, indexes, and stores candidates either way. The Pi extension mirrors the Claude Code default classifier branch natively on `agent_end`: when `ASAKI_MEMORY_AUTO_EXTRACT=0`, `ASAKI_MEMORY_AUTO_CLASSIFIER` defaults on, runs a headless Pi classifier with the atomic-commit model-call pattern (`opencode/deepseek-v4-flash-free` by default), and writes qualifying candidates via `POST /v1/memories/candidates` without forcing an extra agent turn — the server (`isUnsupervisedSource()` in `src/services/candidateDecision.ts`) always routes this `source: "pi:agent-end-classifier"` into the review queue rather than auto-add/merge/update/delete, since nothing reviewed the write before it happened. The Claude Code Stop hook (`integrations/claude-code/stop-extract.sh`) uses the raw-text path when `ASAKI_MEMORY_AUTO_EXTRACT=1`, sending new plain-text conversation deltas off-machine for background extraction — this is a deliberate reversal of an earlier no-transcripts-off-machine stance. Cloud auto-extract is permanently off by default (`AUTO_EXTRACT=0`); that branch instead runs a local classifier (`claude -p --safe-mode`, no tools) that judges the delta against the 6-criteria checklist and, if it qualifies, pre-distills it into ready-to-write fields (one-sentence `text`, `type`, `scope`). The same background job then executes the write itself over plain HTTP (`POST /v1/memories/candidates` with `source: "claude-code:stop-classifier"` — the identical endpoint `asaki_memory_add` calls under the hood, so it gets the same server-side dedup/merge pipeline, except the server always routes this source into the review queue instead of auto-add/merge/update/delete), with no Claude/MCP/`claude -p` involved in that step, and no forced continuation of the conversation agent — the next Stop event just reports the real outcome (including "queued for review") as a one-line systemMessage. (Two earlier designs were tried and reverted: giving the classifier direct MCP `asaki_memory_add` access for a fully async flow — reverted after testing showed MCP tool registration isn't reliably ready inside a single-shot `claude -p` call, and in one run the classifier fabricated a false "added" report for a write that never happened; and forcing a `decision:"block"` continuation so the main agent executes the write — worked, but cost one forced extra turn per candidate and Claude Code's CLI renders any `decision:block` as "Stop hook error/feedback" with no way to change that label. See `stop-extract.sh`'s header comment.)
- Candidate processing should run deterministic duplicate checks before LLM decisions.
- Run `npm run eval:candidates` after changing candidate dedupe thresholds or prompts.
- Run `npm run eval:extraction` after changing the extraction prompt (`src/services/extraction.ts`); it hits a live Worker since `env.AI.run()` needs a real Worker runtime — set `ASAKI_MEMORY_BASE_URL` explicitly, there is no default. Add a new case to `test/fixtures/extraction-cases.json` whenever a production false positive/negative turns up.
- Run `npm run eval:classifier` after changing the classifier prompt (`CLASSIFIER_SYSTEM_PROMPT` in `integrations/claude-code/stop-extract.sh`). Add a new case to `test/fixtures/classifier-cases.json` whenever a production false positive/negative turns up.
- Pi auto inject defaults to `ASAKI_MEMORY_AUTO_MIN_SCORE=0.67` (calibrated via `npm run eval:search`); keep low-score memories out of injected context.
- Service-layer validation failures meant for API callers must throw `UserFacingError` (`src/utils/errors.ts`); route handlers only forward those messages — never raw `Error` messages.
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
