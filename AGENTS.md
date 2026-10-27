# AGENTS.md

## Project

Asaki Memory Manager is a Cloudflare-native personal memory layer for AI agents — single-operator, not a multi-tenant/team product.

Stack:
- Cloudflare Workers + TypeScript + Hono
- D1 as the source of truth
- Vectorize as the semantic index
- Workers AI for embeddings and candidate decisions
- REST API first
- Native OMP extension in `integrations/omp/asaki-memory.ts`

## Integration install/update

The OMP extension is the repository's native OMP agent integration; Claude Code and MCP remain separate integrations. The OMP entry point uses `ExtensionAPI` from `@oh-my-pi/pi-coding-agent` and calls the existing Asaki Worker REST API, not OMP's local/Hindsight/Mnemopi memory backends.

Install the extension by linking `integrations/omp/asaki-memory.ts` into OMP's configured local extension directory. The extension uses OMP's native renderer, tool, command, event, and subprocess APIs. Claude Code remains git-marketplace managed; the stdio MCP server remains committed at `dist/mcp-server.mjs`.

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
- `migrations/0006_memory_metadata.sql`: `memories.metadata_json` — the one free-form JSON column holding lifecycle state (reinforcement counters, correction provenance); its header comment is the canonical shape doc.
- `src/index.ts`: Hono app, routes, auth middleware.
- `src/types.ts`: shared types.
- `src/services/memories.ts`: memory creation and search. `getMemoriesByIds()` backs `POST /v1/memories/get` — the batch read-by-id behind `asaki_memory_get` in all three clients: full content, no truncation, at most 20 ids, foreign ids reported as `missing` rather than returned, and it refreshes `last_accessed_at` because a read by id IS a retrieval (captain decision a, 2026-08-28).
- `src/services/candidates.ts`: candidate deduplication and merge decisions.
- `src/services/candidateDecision.ts`: pure candidate decision heuristics and eval target; also owns `importanceForSignal()` / `confidenceForAntecedent()`, which return `number | null` where `null` means "no derivation, keep today's default".
- `src/services/reviews.ts`: memory review queue creation, listing, and resolution. Also owns the two display-time suggestion lookups (`findSupersedeCandidates` = opposite-direction, queried with `supersedes_query`; `findPromotionCandidates` = same-direction cross-project, queried with the candidate's own content) and the `promote_to_global` resolve option. `createMemoryReviews()` returns `{ reviews, reinforcements, parked }`, not a bare array — `parked` holds candidates written straight to `status=resolved`/`resolved_action=ignore` as near-duplicates of an ACTIVE memory (`NEAR_DUPLICATE_PARK_THRESHOLD` in `candidateDecision.ts`, corrections exempt); they surface as `parked_duplicates` on the two review-creating routes.
- `src/services/memoryLifecycle.ts`: **canonical** lifecycle logic — reinforcement/recurrence (`reinforceMemory`, bounded importance bump, `metadata_json` counters), correction provenance on activation (`recordCorrectionOrigin`, 120-char quotes), and the read-only `lifecycleReport()` behind `POST /v1/memories/lifecycle`. Nothing here deletes, archives, or demotes: long-idle standing rules are reported for a human keep/retire verdict only, which is also why `pruneStaleMemories()` excludes `rule`/`preference`.
- `src/services/memoryEvents.ts`: event logging.
- `src/ai/embeddings.ts`: Workers AI embedding helpers.
- `src/utils/validation.ts`: request validation. `validateCreateMemory` also threads the correction-classifier evidence fields (`signal`, `signal_subtype`, `rule_form`, `antecedent_source`, `correction`, `supersedes_query`, `supersedes_pending_review_id`, `project_context`) — enum coercion is total (unknown → the inert member, never a 400), evidence strings are truncated rather than rejected, and the only 400 they can cause is the sensitive gate.
- `src/utils/errors.ts`: `UserFacingError` — the only service-thrown error class whose message route handlers forward to API clients; any other exception falls through to the sanitized generic 500.
- `src/utils/sensitiveContent.ts`: canonical server secret gate; the OMP and Claude Code copies are checked by `eval:sensitive-pattern` and `eval:trace-sensitive`.
- `src/services/standingRules.ts`: canonical standing-rule selection/rendering; its OMP region and Claude Code jq copy are checked by `eval:standing-rules`.
- `src/services/projectDigest.ts`: canonical project-digest selection/rendering; its OMP region and Claude Code jq copy are checked by `eval:project-digest`.
- `scripts/eval-session-inject.sh` and `scripts/eval-omp-inject.mjs`: verify Claude hook wiring and the real OMP source under a native `ExtensionAPI`, including prompt injection, backend failure, tools, and classifier child-command contract.
- `scripts/eval-inject-env.sh` and `scripts/eval-inject-env.mjs`: check numeric injection settings across the OMP source region and both Claude Code hook copies.
- `src/services/extraction.ts`: deprecated server-extraction compatibility path; not an active/default memory source.
- `integrations/omp/asaki-memory.ts`: sole native OMP extension entry point besides the Claude Code integration and MCP; it uses OMP's `ExtensionAPI` and the existing Asaki Worker REST API.
- `commands/memory.md`: Claude Code plugin `/memory` slash command; the OMP extension registers the matching native command.
- `scripts/shadow-run-extraction.ts`: legacy server-extraction calibration tool; retained for compatibility investigations, not routine learning.
- `scripts/backfill-index.ts`: manual Vectorize backfill trigger — calls `POST /v1/memories/backfill-index` (`backfillPendingIndex()` in `src/services/memories.ts`) in a loop to re-embed and re-upsert memories stuck at `index_status` `pending`/`failed`.
- `scripts/eval-memory-get.ts`: offline unit coverage for `POST /v1/memories/get` against a fake D1 — the validation bounds (20-id cap, trimming/de-duplication), user scoping, request-order preservation, the `last_accessed_at` write and the `get` audit event. Run `npm run eval:memory-get` after touching that path.
- `scripts/eval-purge-scrub.ts`: offline unit coverage for `purgeMemory()`'s destruction paths (memories blanking including `metadata_json`, `memory_events` wipe, `memory_reviews.candidate_json` scrub) against a fake D1. Review rows are retained PERMANENTLY — the purge-time scrub is the only destruction path; there is deliberately no review prune endpoint or script.
- `scripts/prune-stale.ts`: manual stale-memory cleanup — calls `POST /v1/memories/prune-stale` (`pruneStaleMemories()` in `src/services/memories.ts`) to soft-delete memories not accessed in N days. Defaults to dry-run; `--apply` is required to actually delete. It never touches `rule`/`preference` memories — long-idle standing rules go to the human via `lifecycleReport()` instead (captain decision 4).
- `integrations/local/weekly-consolidation-report.sh` + `install-weekly-launchagent.sh`: the weekly memory-consolidation report, a LOCAL macOS scheduled job (`com.asaki.memory.weekly-report`, Monday 09:30) that replaced the cloud routine `trig_01TySBjA96EWNeUJnmV63DcY` (disabled 2026-09-01 — the cloud sandbox's egress proxy rejected the Worker host and its credential store is UI-only). Read-only by construction: the script curls `/v1/memories/reviews/list` + global `/v1/memories/list` itself and hands ONLY those two payloads to a headless `claude -p` that has no tools and no credentials, so no write endpoint is reachable from the model. The bearer is read from the env, falling back to `fish -l` because launchd starts with an empty environment, and is passed to curl through a `--config` file so it never reaches argv. Report lands in `~/.local/state/asaki-memory/weekly-reports/YYYY-MM-DD.md`. TCC: launchd cannot execute from `~/Desktop`, so the installer copies the runner to `~/.local/share/asaki-memory/weekly-runner/` and the plist (machine-local, untracked) points there — re-run the installer after every change to the repo copy, which stays the source of truth. Single machine by design; no copy on asaki.
- `scripts/eval-candidate-fields.ts`: offline unit coverage for the candidate evidence fields — coercion table, caps, the sensitive gate on all four evidence strings, and the two derivations. Run it after touching `validateCreateMemory` or the derivation tables.
- `scripts/eval-review-park.ts`: offline unit coverage for capture-time near-duplicate parking in `createMemoryReviews()` against a fake D1 — the park band, the resolved/ignore audit row, the `review_park_duplicate` event, the correction exemption, and the untouched exact-duplicate skip. Run `npm run eval:review-park` after touching that path or the threshold.
- `scripts/eval-audit-read-api.ts`: offline coverage for audit reads — the `include_suggestions` page-size bound, project enumeration/counts, global `pending_count`, and both MCP descriptions. Run `npm run eval:audit-read-api` after changing these surfaces.
- `scripts/eval-lifecycle.ts`: offline unit coverage for the lifecycle logic against a fake D1 — bounded importance bump, recurrence counters, the 120-char provenance cap, the cross-project promotion lookup's SQL guards, the report's repeat-rate/idle-day arithmetic, and the invariant that no lifecycle path issues an UPDATE/DELETE against a standing rule. Run it after touching `src/services/memoryLifecycle.ts` or the promotion lookup.
- `scripts/build-mcp.mjs` + `.githooks/pre-commit`: the MCP bundle guard. `dist/mcp-server.mjs` (stdio clients only — Claude Code uses the remote endpoint) is a COMMITTED build artifact, so it can drift from its source; CI's `mcp-build-drift` job is the final catch and stays. The build script is the determinism half: it pins `absWorkingDir` to the repo root and hard-fails on the two things that change the bytes with no source change — a nested `node_modules` under `integrations/mcp/` shadowing the root install (the 2026-07-21 CI #86–#88 root cause) and an installed esbuild that does not match the lockfile pin. `--check` (`npm run check:mcp-bundle`) diffs without writing. The pre-commit hook is the local half: when a commit stages a bundle input (`integrations/mcp/**`, `package.json`, `package-lock.json`, the build script, the hook itself) it rebuilds and `git add`s the bundle into that same commit — but refuses when those inputs have unstaged changes, since the rebuild reads the working tree, not the index. Bypass with `ASAKI_SKIP_BUNDLE_GUARD=1` or `--no-verify`. `scripts/install-git-hooks.mjs` (npm `prepare`, also `npm run hooks:install`) wires `core.hooksPath` to `.githooks`; it deliberately no-ops in CI and **in a linked worktree**, where that config write would hit the shared config and silently disable hooks for the primary checkout. From a worktree, run `git -c core.hooksPath=.githooks commit ...`. `npm run eval:bundle-guard` covers the input/non-input boundary (sourced out of the hook via its `ASAKI_BUNDLE_GUARD_LIB` library guard) plus both build preflights.
- `scripts/node-ts-resolver.mjs`: `registerTsResolver()` — resolve hook letting a `node --experimental-strip-types` eval import a `src/**` module that has *runtime* (not type-only) extensionless sibling imports. Register it before the value `import()`s, not as a static import.
- `integrations/claude-code/build-delta.mjs`: Claude Code transcript-to-classifier delta builder. Its gates, redaction, private-text exclusion, and tool whitelist are covered alongside the OMP trace region by `npm run eval:trace-builder` and `npm run eval:trace-sensitive`.
- `integrations/claude-code/project-context.mjs`: canonical project attribution for both background classifiers. The OMP region mirrors it semantically; `npm run eval:project-context` checks both implementations and the Claude hook wrapper.
- `integrations/claude-code/session-start.sh`: the SessionStart hook. Emits the standing-rule block, then the project digest, then the status banner, all from one memory-list response. Its top "library region" (the numeric env parser, the banner-line builder, and the two READ-side renderers for the classifier health ledger — `asaki_health_failing_field` / `asaki_health_idle_field`) sits above the `ASAKI_MEMORY_SESSION_START_LIB` guard so evals can `source` it without running a hook — same convention as `stop-extract.sh`; `integrations/claude-code/user-prompt.sh` has the same guard (`ASAKI_MEMORY_USER_PROMPT_LIB`) for its parser copies.
- `integrations/claude-code/stop-extract.sh`: the Stop hook. Its top "library region" (patterns plus `throttle_decision` / `outcome_for_status` / the `asaki_health_*` ledger writers) sits above the `ASAKI_MEMORY_STOP_EXTRACT_LIB` guard so evals can `source` it without running a hook — keep new hook side effects below that guard.
- Classifier health ledger: `$TMPDIR/asaki-memory-stop-extract/health.json`; Claude Code writes and renders its health fields, and OMP keeps the same banner field contract. `eval:health-ledger` checks the write side; `eval:session-inject` checks banner rendering.
- `tsconfig.omp.json` + `integrations/omp/omp-host-modules.d.ts`: `npm run typecheck:omp` typechecks the native extension against minimal host declarations.
- `scripts/omp-trace-region.mjs`: loads marked regions from the real OMP source for env, trace, review-format, banner, and project-context evals. Keep region markers intact; the loader fails if a region is missing.
- `scripts/eval-review-format.ts`: checks OMP formatter behavior and byte identity with `src/mcp.ts`; run `npm run eval:review-format` after touching either formatter.
- `scripts/eval-prompt-sync.mjs`: checks the Claude Code, OMP, and eval copies of classifier prompts and schemas; run `npm run eval:prompt-sync` after prompt edits.
- `scripts/eval-classifier.sh`: regression eval for the Claude Code local Stop-hook classifier; it calls `claude -p --safe-mode` against `test/fixtures/classifier-cases.json`.
- Correction mode and action trace are on by default in both clients. Action trace sends redacted paths/URIs/hosts but preserves non-path free text; see `integrations/claude-code/README.md`.
- The `/memory` audit workflow is mirrored between `commands/memory.md` and the OMP `registerCommand("memory", …)` implementation. Review-format output remains synchronized with `src/mcp.ts`.
- The active global-scope discipline is synchronized across `commands/memory.md`, the OMP `/memory` command, both classifier prompt copies, and `scripts/eval-classifier.sh`; `src/services/extraction.ts` is legacy compatibility only.

## Commands

```bash
npm install
npm run typecheck
npm run eval:candidates
npm run eval:candidate-fields
npm run eval:purge-scrub
npm run eval:memory-get
npm run eval:lifecycle
npm run eval:review-park
npm run eval:review-resolve
npm run eval:audit-read-api
npm run eval:bundle-guard
npm run check:mcp-bundle
npm run hooks:install
npm run eval:sensitive-pattern
npm run eval:extraction
npm run eval:classifier                      # full pass; subset: ASAKI_CLASSIFIER_FIXTURES=test/fixtures/classifier-smoke.json
npm run eval:project-context
npm run eval:prompt-sync
npm run eval:standing-rules
npm run eval:project-digest
npm run eval:inject-env
npm run eval:session-inject
npm run eval:review-format
npm run eval:correction-signal
npm run eval:trace-sensitive
npm run eval:trace-builder
npm run eval:throttle-state
npm run eval:health-ledger
npm run typecheck:omp
npm run shadow-run:extraction -- <transcript.jsonl> --user <id> --project <id>
npm run backfill:index -- --limit 50
npm run prune:stale -- --days 90
npm run db:migrate:local
npm run dev
```

Remote operations:

```bash
npm run db:migrate:remote
npm run eval:review-dedup
npx wrangler dev --remote
npm run deploy
```

## Security rules

- Never commit `.env`, `.dev.vars`, `wrangler.jsonc`, private keys, tokens, or secrets.
- Keep `wrangler.example.jsonc` generic and safe for public repos.
- Use Wrangler secrets for `ADMIN_API_KEY`.
- Never embed the `ADMIN_API_KEY` bearer in any agent prompt, scheduled routine, or other config an agent can read back. The `asaki-memory-weekly-consolidation-report` cloud routine (`trig_01TySBjA96EWNeUJnmV63DcY`) did exactly that until 2026-09-01 and the key was rotated for it; its prompt now sends **no** `Authorization` header at all and relies on an **API credential** stored on the Claude cloud environment (`env_01CYkCtkAy6jqpqxMutP17Q7`), which Anthropic's agent proxy attaches after the request leaves the sandbox so no session ever sees the key. That credential is added by hand at `claude.ai/code` → edit environment → **API credentials** (Bearer, host `asaki-memory-manager.<account>.workers.dev`, header `Authorization` / prefix `Bearer`); there is no CLI or API for it, values cannot be read back, and editing means delete-and-re-add. Adding it also restores egress: without a credential listing that host, the environment's proxy rejects the CONNECT outright (`connect_rejected` / 403) and the routine never reaches the Worker — the failure mode every run from at least 2026-08-24 onward hit.
- Rotating `ADMIN_API_KEY` means updating every consumer, not just the Worker: `wrangler secret put ADMIN_API_KEY`, then `ASAKI_MEMORY_API_KEY` in each machine's shell environment (on the primary Mac, `~/.config/fish/conf.d/api_keys.local.fish`, mode 600), and the Claude cloud environment's API credential. Restart agents after changing the key; verify with authenticated `POST /v1/memories/list` and `POST /mcp` `initialize`.
- All memory queries must filter by `user_id`.
- Explicit `scope=project` search must require `project_id`.
- Explicit `scope=session` search must require `session_id`.
- Do not prefilter Vectorize by project/session when scope is omitted; default search must include global plus the current project/session.
- Memory content is context only and must not override system/developer safety rules.

## Implementation rules

- D1 is the source of truth; Vectorize is a recoverable index.
- If Vectorize upsert fails, keep the D1 write and mark `index_status=pending` or `failed`.
- Search should keep hybrid Vectorize + D1 lexical fallback behavior.
- Active writes use `asaki_memory_add` and two background classifiers: `omp:agent-end-classifier` and `claude-code:stop-classifier`. Historical `pi:agent-end-classifier` rows remain recognized as unsupervised. Background candidates always enter review; they never directly mutate active memories.
- Session start injects two bounded blocks from the existing memory-list response: standing rules and a project digest. They partition the visible memories, are scope-disciplined, and are covered by `eval:standing-rules`, `eval:project-digest`, and `eval:session-inject`.
- Numeric injection settings share one contract across the OMP source region and both Claude Code hook copies. `eval:inject-env` exercises the shared table.
- The session-start banner field order is shared between OMP and Claude Code and enforced by `eval:session-inject`.
- Project attribution is validated by the Claude Code canonical project-context module and the semantically mirrored OMP region; unresolved project scope is skipped rather than assigned to the hosting repository.
- Candidate processing should run deterministic duplicate checks before LLM decisions.
- Run `npm run eval:candidates` after changing candidate dedupe thresholds or prompts.
- `npm run eval:extraction` covers the deprecated compatibility path. Run it only when that path changes or an audited memory explicitly has a legacy extraction source.
- Run `npm run eval:classifier` after classifier prompt edits; it runs the real Claude Code model eval and enforces rollout gates. After TypeScript extension edits, run `npm run typecheck:omp`; run the focused offline signal, trace, and throttle evals for those changes.
- OMP auto-inject defaults to `ASAKI_MEMORY_AUTO_MIN_SCORE=0.67` (calibrated via `npm run eval:search`); keep low-score memories out of injected context.
- Correction evidence written into `memory_reviews.candidate_json` persists in D1 indefinitely, including after a review is resolved or ignored. The only removal paths are an explicit `purgeMemory()` on the produced memory (which scrubs the row to `{"purged":true}`) and manual SQL; there is no review prune endpoint or script, and retention policy is a deferred captain decision, not an implementation gap.
- Memory lifecycle (captain decisions 4/8/9, 2026-07-31; reaches production at the NEXT release): a correction candidate that duplicates an ALREADY-ACTIVE `rule`/`preference` is a RECURRENCE, not noise — it reinforces that memory (bounded +0.05 importance, cap 0.95, never lowering a hand-set value) and increments `metadata_json.reinforcement.count` instead of queueing a review. Direction is decided by which lookup matched: the candidate's own content matching = same direction (reinforce/promote), `supersedes_query` matching = opposite (supersede). `repeat_rate` and the long-idle standing rules come from `POST /v1/memories/lifecycle`; idle rules are a human keep/retire prompt and are never auto-deleted or demoted out of injection. Cross-project matches only ever attach a `promote_to_global` suggestion — scope changes require an explicit human `promote_to_global` on resolve (valid with `action: "add"` only) or `asaki_memory_update`.
- Run `npm run eval:review-format` after touching `formatReviewLine` in `src/mcp.ts`, the OMP `// #region asaki-review-format`, or the audit-flow text they feed.
- Service-layer validation failures meant for API callers must throw `UserFacingError` (`src/utils/errors.ts`); route handlers only forward those messages — never raw `Error` messages.
- Keep changes small and consistent with existing style.
- Run `npm run typecheck` after TypeScript edits.

## Few-shot self-iteration

Every audit that rejects, rescopes, or compresses a classifier-produced memory must fix the root cause, not just the symptom. Classifier is the active/default background path and the source of most production memories. Memory/review list output includes `source` and `created_at`; route explicit legacy extraction sources separately:

| Rejected memory `source` | Pipeline at fault | Add regression case to | Update few-shot in (all copies stay identical) | Verify |
|---|---|---|---|---|
| `omp:agent-end-classifier`; historical rows may contain `pi:agent-end-classifier`; `claude-code:stop-classifier` | local classifier | `test/fixtures/classifier-cases.json` | `CLASSIFIER_SYSTEM_PROMPT` in `integrations/claude-code/stop-extract.sh`, `integrations/omp/asaki-memory.ts`, and `scripts/eval-classifier.sh` | `npm run eval:classifier` |
| same classifier sources, with a correction review | local classifier, correction path | `test/fixtures/classifier-cases.json` with correction evidence | `CORRECTION_SYSTEM_PROMPT` in those three files | `npm run eval:classifier` |
| `*:auto-extract`, `asaki_memory_extract` | deprecated server extraction | `test/fixtures/extraction-cases.json` | `SYSTEM_PROMPT` in `src/services/extraction.ts` | `npm run eval:extraction` (legacy path; needs a live Worker + `ASAKI_MEMORY_BASE_URL`) |
| manual agent add (`claude-code`, `omp`, `mcp`, null) or `*:review` | primary agent / human — no prompt to few-shot | — | refine the audit discipline text if it recurs | — |

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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
