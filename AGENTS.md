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
- **Pi**: `package.json`'s `"pi": { "extensions": [...] }` field is Pi's own package manifest, declaring `integrations/pi/asaki-memory.ts` as the extension entry point (Pi looks for a `pi` key in `package.json`, same convention as an npm package). ALL machines — including this working copy — consume it as the published npm package `npm:@asaki14/pi-memory` (verified 2026-07-11: `~/.pi/agent/settings.json` packages list + `~/.pi/agent/npm/package.json`; an earlier local-path install was replaced at some point, so local edits do NOT take effect until published). Do NOT install from the git monorepo (Pi git sources clone the whole repo — no subpath support). Release flow: bump the root `package.json` version (the pi package inherits it), `npm run build:pi` (stages `dist/pi-package/` with just the single extension file + a minimal `pi`-key `package.json`), `npm publish` from `dist/pi-package/`, then on each machine `pi update npm:@asaki14/pi-memory`. Caveat: `pi update` honors `~/.pi/agent/npm/package-lock.json`, so it will NOT pull a newer patch that still satisfies the existing `^` range (it reports "up to date" and stays put, even after `npm cache clean`); to actually bump within-range, run `npm update @asaki14/pi-memory` inside `~/.pi/agent/npm`. Also note the npm read cache can lag right after publish — verify the new version landed with `npm view @asaki14/pi-memory version --prefer-online` (or curl the registry) rather than a plain `npm view`. Source of truth stays at `integrations/pi/asaki-memory.ts` — the build is a one-way sync, not a fork; never edit `dist/pi-package/` by hand.

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
- `src/services/extraction.ts`: deprecated server-extraction compatibility path; not an active/default memory source.
- `integrations/pi/asaki-memory.ts`: optional Pi extension.
- `commands/memory.md`: Claude Code plugin `/memory` slash command (audit workflow; mirrors the Pi extension's `registerCommand("memory", ...)`).
- `scripts/shadow-run-extraction.ts`: legacy server-extraction calibration tool; retained for compatibility investigations, not routine learning.
- `scripts/backfill-index.ts`: manual Vectorize backfill trigger — calls `POST /v1/memories/backfill-index` (`backfillPendingIndex()` in `src/services/memories.ts`) in a loop to re-embed and re-upsert memories stuck at `index_status` `pending`/`failed`.
- `scripts/prune-stale.ts`: manual stale-memory cleanup — calls `POST /v1/memories/prune-stale` (`pruneStaleMemories()` in `src/services/memories.ts`) to soft-delete memories not accessed in N days. Defaults to dry-run; `--apply` is required to actually delete.
- `scripts/eval-classifier.sh`: regression eval for the Claude Code local Stop-hook memory-candidate classifier (the `AUTO_EXTRACT=0` branch of `integrations/claude-code/stop-extract.sh`) — hits `claude -p --safe-mode` for real against `test/fixtures/classifier-cases.json`, no Worker/API key needed since nothing gets written.
- The active "Global scope discipline" text lives in four places that must stay in sync: `commands/memory.md`, `integrations/pi/asaki-memory.ts`'s `/memory` command, and `CLASSIFIER_SYSTEM_PROMPT` in both `integrations/claude-code/stop-extract.sh` and `integrations/pi/asaki-memory.ts`; `scripts/eval-classifier.sh` carries the eval copy. `src/services/extraction.ts` keeps a legacy compatibility copy only.

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
- Active writes use two paths: the conversation agent submits pre-distilled memories through `asaki_memory_add`, while the default background classifier (`pi:agent-end-classifier` or `claude-code:stop-classifier`) pre-distills at most one candidate and sends it to `POST /v1/memories/candidates`. Classifier candidates always enter the review queue and never auto-add/merge/update/delete. Production history is predominantly classifier-sourced, so audit misses normally belong to the classifier eval/prompt surface. Server extraction (`POST /v1/memories/extract`, `asaki_memory_extract`, `*:auto-extract`) is deprecated and retained only for backward compatibility/manual investigation; do not enable it or send full transcripts through it.
- Candidate processing should run deterministic duplicate checks before LLM decisions.
- Run `npm run eval:candidates` after changing candidate dedupe thresholds or prompts.
- `npm run eval:extraction` covers the deprecated compatibility path. Run it only when that path changes or an audited memory explicitly has a legacy extraction source.
- Run `npm run eval:classifier` after changing the classifier prompt (`CLASSIFIER_SYSTEM_PROMPT` in `integrations/claude-code/stop-extract.sh`). Add a new case to `test/fixtures/classifier-cases.json` whenever a production false positive/negative turns up (a memory audit is the routine trigger — see "Few-shot self-iteration").
- Pi auto inject defaults to `ASAKI_MEMORY_AUTO_MIN_SCORE=0.67` (calibrated via `npm run eval:search`); keep low-score memories out of injected context.
- Service-layer validation failures meant for API callers must throw `UserFacingError` (`src/utils/errors.ts`); route handlers only forward those messages — never raw `Error` messages.
- Keep changes small and consistent with existing style.
- Run `npm run typecheck` after TypeScript edits.

## Few-shot self-iteration

Every audit that rejects, rescopes, or compresses a classifier-produced memory must fix the root cause, not just the symptom. Classifier is the active/default background path and the source of most production memories. Memory/review list output includes `source` and `created_at`; route explicit legacy extraction sources separately:

| Rejected memory `source` | Pipeline at fault | Add regression case to | Update few-shot in (all copies stay identical) | Verify |
|---|---|---|---|---|
| `claude-code:stop-classifier`, `pi:agent-end-classifier` | local classifier | `test/fixtures/classifier-cases.json` | `CLASSIFIER_SYSTEM_PROMPT` in `integrations/claude-code/stop-extract.sh`, `integrations/pi/asaki-memory.ts`, and `scripts/eval-classifier.sh` | `npm run eval:classifier` |
| `*:auto-extract`, `asaki_memory_extract` | deprecated server extraction | `test/fixtures/extraction-cases.json` | `SYSTEM_PROMPT` in `src/services/extraction.ts` | `npm run eval:extraction` (legacy path; needs a live Worker + `ASAKI_MEMORY_BASE_URL`) |
| manual agent add (`claude-code`, `pi`, `mcp`, null) or `*:review` | primary agent / human — no prompt to few-shot | — | refine the audit discipline text if it's a recurring gap | — |

Case shape:
- Recorded something that should have been skipped → **negative** case (`expectEmpty: true` / `expectFlag: false`) carrying the offending text verbatim.
- Recorded a real fact but mis-scoped / over-long / multi-fact → **positive** case pinning the correct outcome (`expectScope`, `expectCount`, distilled `content`).

Do it TDD-style so the improvement is provable: add the failing fixture case first, then update the few-shot copies, then run the eval to green. Unless `source` explicitly names the deprecated extraction path, add the case to `classifier-cases.json` and update the matching `-> flag=...` example in all three classifier prompt copies.

Because audits run from any working directory but these files live only in this repo: when the audit is NOT running inside the `asaki-memory-manager` checkout, do not edit them — emit the distilled cases (offending text + expected verdict + target surface) as a copy-pasteable block for later application here. When it IS running here, apply the edits under the same approval as the memory writes and run the eval — never in `report` mode.

## Public release checklist

Before publishing:
- `npm run typecheck` passes.
- No secrets or personal paths in tracked files.
- `wrangler.jsonc` is ignored; only `wrangler.example.jsonc` is tracked.
- README examples use placeholders, not production credentials or personal endpoints.
- License exists.
- If CI is added, ensure the publishing token has GitHub `workflow` scope before pushing workflow files.
