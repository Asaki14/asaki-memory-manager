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

Both the Claude Code plugin and the Pi extension are consumed straight from this repo — no separate build/publish step. After changing anything under `integrations/`, `commands/memory.md`, or `.claude-plugin/`, push to `main` and re-sync however each side expects (do NOT hand-copy files into either agent's install dir — that's what caused both to drift stale before this was set up):

- **Claude Code**: `.claude-plugin/plugin.json` intentionally has no `version` field — with a git-backed marketplace source, Claude Code derives the plugin version from the commit SHA, so every push is a new version. This only works because the marketplace source is registered as `{"source": "github", "repo": "Asaki14/asaki-memory-manager"}` (see `~/.claude/settings.json`'s `extraKnownMarketplaces.asaki-memory`), not `directory` — a `directory` source has no commit SHA and never re-syncs on its own. `autoUpdate: true` on that marketplace entry refreshes it on every Claude Code startup; to sync without restarting, run `claude plugin marketplace update asaki-memory && claude plugin update asaki-memory@asaki-memory` (restart still required for an already-running session to pick it up).
- **Pi**: `package.json`'s `"pi": { "extensions": [...] }` field is Pi's own package manifest, declaring `integrations/pi/asaki-memory.ts` as the extension entry point (Pi looks for a `pi` key in `package.json`, same convention as an npm package). Locally it's installed via `pi install <this-repo-path>` — a `local`-type source, which Pi resolves live from the directory every session, so local edits need no re-sync at all. A machine that isn't this working copy should install from `git:github.com/Asaki14/asaki-memory-manager` instead and run `pi update <source>` after upstream pushes.

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
- `scripts/shadow-run-extraction.ts`: shadow-run calibration tool — runs `/v1/memories/extract` in `dry_run` mode against a transcript and diffs cloud candidates against real agent-added memories, without writing anything.
- `scripts/backfill-index.ts`: manual Vectorize backfill trigger — calls `POST /v1/memories/backfill-index` (`backfillPendingIndex()` in `src/services/memories.ts`) in a loop to re-embed and re-upsert memories stuck at `index_status` `pending`/`failed`.
- `scripts/prune-stale.ts`: manual stale-memory cleanup — calls `POST /v1/memories/prune-stale` (`pruneStaleMemories()` in `src/services/memories.ts`) to soft-delete memories not accessed in N days. Defaults to dry-run; `--apply` is required to actually delete.
- `scripts/eval-classifier.sh`: regression eval for the local Stop-hook memory-candidate classifier (the `AUTO_EXTRACT=0` branch of `integrations/claude-code/stop-extract.sh`) — hits `claude -p --safe-mode` for real against `test/fixtures/classifier-cases.json`, no Worker/API key needed since nothing gets written.
- The "Global scope discipline" text lives in four places that must stay in sync: `commands/memory.md`, `integrations/pi/asaki-memory.ts`'s `/memory` command, (condensed) `src/services/extraction.ts`'s `SYSTEM_PROMPT`, and (condensed) `integrations/claude-code/stop-extract.sh`'s `CLASSIFIER_SYSTEM_PROMPT` — the first two apply it at audit time, the latter two apply it at extraction/classification time.

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
- The active conversation agent can call `asaki_memory_add` directly with a pre-distilled memory, or hand raw text to `POST /v1/memories/extract` (`asaki_memory_extract` MCP tool) for server-side LLM extraction; Cloudflare organizes, dedupes, merges, indexes, and stores candidates either way. The Claude Code Stop hook (`integrations/claude-code/stop-extract.sh`) uses the raw-text path when `ASAKI_MEMORY_AUTO_EXTRACT=1`, sending new plain-text conversation deltas off-machine for background extraction — this is a deliberate reversal of an earlier no-transcripts-off-machine stance. Cloud auto-extract is permanently off by default (`AUTO_EXTRACT=0`); that branch instead runs a local, no-write-access classifier (`claude -p --safe-mode`) that judges the delta against the 6-criteria checklist and, if it qualifies, pre-distills it into ready-to-write fields (one-sentence `text`, `type`, `scope`). On the next Stop event this forces one more agent turn (`decision:"block"`) whose only job is to execute `asaki_memory_add` with those fields — not to re-review the checklist, since the classifier already did — the conversation agent remains the sole writer, just no longer the one doing the review. (An earlier design gave the classifier direct MCP write access for a fully async flow; reverted after testing showed MCP tool registration isn't reliably ready inside a single-shot `claude -p` call, and in one run the classifier fabricated a false "added" report for a write that never happened — see `stop-extract.sh`'s header comment.)
- Candidate processing should run deterministic duplicate checks before LLM decisions.
- Run `npm run eval:candidates` after changing candidate dedupe thresholds or prompts.
- Run `npm run eval:extraction` after changing the extraction prompt (`src/services/extraction.ts`); it hits a live Worker (defaults to production) since `env.AI.run()` needs a real Worker runtime. Add a new case to `test/fixtures/extraction-cases.json` whenever a production false positive/negative turns up.
- Run `npm run eval:classifier` after changing the classifier prompt (`CLASSIFIER_SYSTEM_PROMPT` in `integrations/claude-code/stop-extract.sh`). Add a new case to `test/fixtures/classifier-cases.json` whenever a production false positive/negative turns up.
- Pi auto inject defaults to `ASAKI_MEMORY_AUTO_MIN_SCORE=0.67` (calibrated via `npm run eval:search`); keep low-score memories out of injected context.
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
