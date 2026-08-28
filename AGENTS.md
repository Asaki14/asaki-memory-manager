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
- `migrations/0006_memory_metadata.sql`: `memories.metadata_json` — the one free-form JSON column holding lifecycle state (reinforcement counters, correction provenance); its header comment is the canonical shape doc.
- `src/index.ts`: Hono app, routes, auth middleware.
- `src/types.ts`: shared types.
- `src/services/memories.ts`: memory creation and search.
- `src/services/candidates.ts`: candidate deduplication and merge decisions.
- `src/services/candidateDecision.ts`: pure candidate decision heuristics and eval target; also owns `importanceForSignal()` / `confidenceForAntecedent()`, which return `number | null` where `null` means "no derivation, keep today's default".
- `src/services/reviews.ts`: memory review queue creation, listing, and resolution. Also owns the two display-time suggestion lookups (`findSupersedeCandidates` = opposite-direction, queried with `supersedes_query`; `findPromotionCandidates` = same-direction cross-project, queried with the candidate's own content) and the `promote_to_global` resolve option. `createMemoryReviews()` returns `{ reviews, reinforcements, parked }`, not a bare array — `parked` holds candidates written straight to `status=resolved`/`resolved_action=ignore` as near-duplicates of an ACTIVE memory (`NEAR_DUPLICATE_PARK_THRESHOLD` in `candidateDecision.ts`, corrections exempt); they surface as `parked_duplicates` on the two review-creating routes.
- `src/services/memoryLifecycle.ts`: **canonical** lifecycle logic — reinforcement/recurrence (`reinforceMemory`, bounded importance bump, `metadata_json` counters), correction provenance on activation (`recordCorrectionOrigin`, 120-char quotes), and the read-only `lifecycleReport()` behind `POST /v1/memories/lifecycle`. Nothing here deletes, archives, or demotes: long-idle standing rules are reported for a human keep/retire verdict only, which is also why `pruneStaleMemories()` excludes `rule`/`preference`.
- `src/services/memoryEvents.ts`: event logging.
- `src/ai/embeddings.ts`: Workers AI embedding helpers.
- `src/utils/validation.ts`: request validation. `validateCreateMemory` also threads the correction-classifier evidence fields (`signal`, `signal_subtype`, `rule_form`, `antecedent_source`, `correction`, `supersedes_query`, `supersedes_pending_review_id`, `project_context`) — enum coercion is total (unknown → the inert member, never a 400), evidence strings are truncated rather than rejected, and the only 400 they can cause is the sensitive gate.
- `src/utils/errors.ts`: `UserFacingError` — the only service-thrown error class whose message route handlers forward to API clients; any other exception falls through to the sanitized generic 500.
- `src/utils/sensitiveContent.ts`: server-side secret/credential detection gate, applied in `validateCreateMemory`/`validateUpdateMemory`/`validateExtractMemories` before any Workers AI call or D1/Vectorize write. `SENSITIVE_PATTERN` in `integrations/claude-code/stop-extract.sh` and `SENSITIVE_RE_LIST` in `integrations/pi/asaki-memory.ts` and `integrations/claude-code/build-delta.mjs` now mirror this corrected list (identifier-prefixed `FOO_PASSWORD=…` and every fish `set -x` spelling included); `integrations/claude-code/user-prompt.sh` and `scripts/shadow-run-extraction.ts` still carry the older pattern set. `npm run eval:sensitive-pattern` exercises this canonical gate plus the mirrored shell pattern inside `scripts/eval-sensitive-pattern.sh`; `npm run eval:trace-sensitive` exercises the trace-specific gate in both clients.
- `src/services/standingRules.ts`: **canonical** selection/rendering for the session-start standing-rule block (ACTIVE `rule`/`preference` memories injected as directives). The Worker does not serve it; the clients build it from the `/v1/memories/list` response they already fetch. The region between the `standing-rules:begin`/`standing-rules:end` markers is copied VERBATIM into `integrations/pi/asaki-memory.ts` and re-implemented in `integrations/claude-code/standing-rules.jq` — run `npm run eval:standing-rules` after touching any of the three; it fails on byte-level drift.
- `src/services/projectDigest.ts`: **canonical** selection/rendering for the session-start project-memory digest — the non-directive complement of the standing-rule block (every known kind MINUS the configured standing kinds, so the two blocks can never share a memory). Same three-copy discipline as standing rules: the `project-digest:begin`/`project-digest:end` region is copied VERBATIM into `integrations/pi/asaki-memory.ts` and re-implemented in `integrations/claude-code/project-digest.jq`; `npm run eval:project-digest` fails on byte-level drift and also asserts the standing/digest ID sets are disjoint and jointly cover all 7 kinds.
- `scripts/eval-session-inject.sh` + `scripts/eval-pi-inject.mjs`: wiring smoke for the whole session-start surface on BOTH clients — one list + one reviews call per session start (Pi's shared loader merges the in-flight promise when `session_start` and `before_agent_start` overlap), the injected order (Claude: standing → digest → banner; Pi: base → precheck → standing → digest inside the `before_agent_start` systemPrompt, which is the only Pi path that reaches the model), the switches, the banner omission matrix compared byte for byte across clients, and the auto-inject request/display boundaries. `scripts/pi-host-stubs*.mjs` are the Pi host-module stubs that let the eval import the real extension file.
- `scripts/eval-inject-env.sh` + `scripts/eval-inject-env.mjs`: the one parameterized table for the numeric injection env contract, run against all three copies (both Claude hooks' library regions plus the Pi `// #region asaki-env-parse`).
- `src/services/extraction.ts`: deprecated server-extraction compatibility path; not an active/default memory source.
- `integrations/pi/asaki-memory.ts`: optional Pi extension.
- `commands/memory.md`: Claude Code plugin `/memory` slash command (audit workflow; mirrors the Pi extension's `registerCommand("memory", ...)`).
- `scripts/shadow-run-extraction.ts`: legacy server-extraction calibration tool; retained for compatibility investigations, not routine learning.
- `scripts/backfill-index.ts`: manual Vectorize backfill trigger — calls `POST /v1/memories/backfill-index` (`backfillPendingIndex()` in `src/services/memories.ts`) in a loop to re-embed and re-upsert memories stuck at `index_status` `pending`/`failed`.
- `scripts/eval-purge-scrub.ts`: offline unit coverage for `purgeMemory()`'s destruction paths (memories blanking including `metadata_json`, `memory_events` wipe, `memory_reviews.candidate_json` scrub) against a fake D1. Review rows are retained PERMANENTLY — the purge-time scrub is the only destruction path; there is deliberately no review prune endpoint or script.
- `scripts/prune-stale.ts`: manual stale-memory cleanup — calls `POST /v1/memories/prune-stale` (`pruneStaleMemories()` in `src/services/memories.ts`) to soft-delete memories not accessed in N days. Defaults to dry-run; `--apply` is required to actually delete. It never touches `rule`/`preference` memories — long-idle standing rules go to the human via `lifecycleReport()` instead (captain decision 4).
- `scripts/eval-candidate-fields.ts`: offline unit coverage for the candidate evidence fields — coercion table, caps, the sensitive gate on all four evidence strings, and the two derivations. Run it after touching `validateCreateMemory` or the derivation tables.
- `scripts/eval-review-park.ts`: offline unit coverage for capture-time near-duplicate parking in `createMemoryReviews()` against a fake D1 — the park band, the resolved/ignore audit row, the `review_park_duplicate` event, the correction exemption, and the untouched exact-duplicate skip. Run `npm run eval:review-park` after touching that path or the threshold.
- `scripts/eval-audit-read-api.ts`: offline coverage for audit reads — the `include_suggestions` page-size bound, project enumeration/counts, global `pending_count`, and both MCP descriptions. Run `npm run eval:audit-read-api` after changing these surfaces.
- `scripts/eval-lifecycle.ts`: offline unit coverage for the lifecycle logic against a fake D1 — bounded importance bump, recurrence counters, the 120-char provenance cap, the cross-project promotion lookup's SQL guards, the report's repeat-rate/idle-day arithmetic, and the invariant that no lifecycle path issues an UPDATE/DELETE against a standing rule. Run it after touching `src/services/memoryLifecycle.ts` or the promotion lookup.
- `scripts/build-mcp.mjs` + `.githooks/pre-commit`: the MCP bundle guard. `dist/mcp-server.mjs` (stdio clients only — Claude Code uses the remote endpoint) is a COMMITTED build artifact, so it can drift from its source; CI's `mcp-build-drift` job is the final catch and stays. The build script is the determinism half: it pins `absWorkingDir` to the repo root and hard-fails on the two things that change the bytes with no source change — a nested `node_modules` under `integrations/mcp/` shadowing the root install (the 2026-07-21 CI #86–#88 root cause) and an installed esbuild that does not match the lockfile pin. `--check` (`npm run check:mcp-bundle`) diffs without writing. The pre-commit hook is the local half: when a commit stages a bundle input (`integrations/mcp/**`, `package.json`, `package-lock.json`, the build script, the hook itself) it rebuilds and `git add`s the bundle into that same commit — but refuses when those inputs have unstaged changes, since the rebuild reads the working tree, not the index. Bypass with `ASAKI_SKIP_BUNDLE_GUARD=1` or `--no-verify`. `scripts/install-git-hooks.mjs` (npm `prepare`, also `npm run hooks:install`) wires `core.hooksPath` to `.githooks`; it deliberately no-ops in CI and **in a linked worktree**, where that config write would hit the shared config and silently disable hooks for the primary checkout. From a worktree, run `git -c core.hooksPath=.githooks commit ...`. `npm run eval:bundle-guard` covers the input/non-input boundary (sourced out of the hook via its `ASAKI_BUNDLE_GUARD_LIB` library guard) plus both build preflights.
- `scripts/node-ts-resolver.mjs`: `registerTsResolver()` — resolve hook letting a `node --experimental-strip-types` eval import a `src/**` module that has *runtime* (not type-only) extensionless sibling imports. Register it before the value `import()`s, not as a static import.
- `integrations/claude-code/build-delta.mjs`: the Claude Code transcript → classifier delta builder (extracted from the hook so it is testable). Owns the action-trace tool whitelist, the `TRACE_SENSITIVE_PATTERNS` per-line gate and the R1–R5 path/URI/host redaction; the gate always runs on the ORIGINAL argument, redaction second, truncation to 120 chars last. Also owns the user-explicit `<private>…</private>` exclusion (`stripPrivate`, mirrored behaviourally by `stripPrivateText` in the Pi `// #region asaki-trace-builder`): private text is removed from every user/assistant segment before any gate/prompt/request, and `buildDeltaResult().privateOnly` (CLI exit code 3) marks the ONE skip that must ADVANCE `STATE_FILE` — every other skip in `stop-extract.sh` carries the delta forward, which here would fold the excluded text into the next delta. Pi has no offset, so it returns `""` instead. Covered by `npm run eval:trace-builder`.
- `integrations/claude-code/project-context.mjs`: **canonical** project attribution for both background classifiers — builds the deterministic "Project context" block the classifier sees, and validates the `project_id` it answers with against a client-computed allowlist. Identity of a repository is the basename of its REAL git root (never a registry alias or a worktree directory name); on an orchestrator host (a checkout whose `state/*.meta` task files name other repos' roots) there is deliberately NO default project, so an unattributable project-scope candidate is skipped before any HTTP request instead of being filed under the host. Mirrored semantically in the Pi `// #region asaki-project-context` block; `npm run eval:project-context` runs one table against the canonical module, the Pi copy and the hook's `resolve_candidate_project` wrapper. Explicit `ASAKI_MEMORY_PROJECT_ID` still wins over everything.
- `integrations/claude-code/session-start.sh`: the SessionStart hook. Emits the standing-rule block, then the project digest, then the status banner, all from one memory-list response. Its top "library region" (the numeric env parser plus the banner-line builder) sits above the `ASAKI_MEMORY_SESSION_START_LIB` guard so evals can `source` it without running a hook — same convention as `stop-extract.sh`; `integrations/claude-code/user-prompt.sh` has the same guard (`ASAKI_MEMORY_USER_PROMPT_LIB`) for its parser copies.
- `integrations/claude-code/stop-extract.sh`: the Stop hook. Its top "library region" (patterns plus `throttle_decision` / `outcome_for_status`) sits above the `ASAKI_MEMORY_STOP_EXTRACT_LIB` guard so evals can `source` it without running a hook — keep new hook side effects below that guard.
- `tsconfig.pi.json` + `integrations/pi/pi-host-modules.d.ts`: `npm run typecheck:pi`. The root `tsconfig.json` only includes `src/**`, so the Pi extension is otherwise never compiled anywhere; the Pi host modules are ambient stubs because they are peer deps resolved by Pi, not repo deps.
- `scripts/pi-trace-region.mjs`: loads marked regions of `integrations/pi/asaki-memory.ts` as real modules — `loadPiTraceBuilder()` for `// #region asaki-trace-builder`, `loadPiReviewFormatter()` for `// #region asaki-review-format`. The Pi extension must stay a single file (see "Integration install/update"), so an eval cannot import it directly; keep those region markers intact or the trace/signal/review-format evals fail loudly.
- `scripts/eval-review-format.ts`: offline coverage for the two review-line formatters — `formatReviewLine` in `src/mcp.ts` and the Pi copy. It pins the correction block character-for-character in BOTH copies, the pre-change golden line for non-correction rows, and the deliberate asymmetry that only the Pi fallback line prints `importance`/`confidence`. It also pins `formatLifecycleReport` (same region, same byte-identity requirement) and the `⤷ promote:` suggestion lines. Run `npm run eval:review-format` after touching either formatter. `integrations/mcp/asaki-memory.ts` (stdio, Codex) deliberately stays on the plain line — it exposes neither `include_suggestions` nor `signal`, so it has no supersession data to render.
- `scripts/eval-prompt-sync.mjs`: byte-level drift guard for the six classifier prompt copies (`CLASSIFIER_SYSTEM_PROMPT` / `CORRECTION_SYSTEM_PROMPT` in `stop-extract.sh`, `integrations/pi/asaki-memory.ts`, `scripts/eval-classifier.sh`) plus the two JSON schemas. Host-language escaping is normalised; only the prompts' first line (which names the executing client) may differ. Run `npm run eval:prompt-sync` after touching any prompt copy — CI runs it too.
- `scripts/eval-classifier.sh`: regression eval for the Claude Code local Stop-hook memory-candidate classifier (the `AUTO_EXTRACT=0` branch of `integrations/claude-code/stop-extract.sh`) — hits `claude -p --safe-mode` for real against `test/fixtures/classifier-cases.json`, no Worker/API key needed since nothing gets written.
- Correction mode (`ASAKI_MEMORY_CORRECTION_MODE`) and action trace (`ASAKI_MEMORY_ACTION_TRACE`) are both **on by default** in both clients (set either to `0` to opt out; Pi also reads `~/.pi/agent/asaki-memory.json`). The two are independent, so the fallback is not one claim but two: with correction mode off the prompt, JSON schema, POST body and call frequency are what they were before the feature existed, but the classifier input is **byte-identical only when action trace is ALSO off** — trace adds `Tool:` lines to the delta regardless of correction mode. Action trace sends one redacted `Tool: <name> <arg>` line per tool call off-machine: paths/URIs/hosts are rewritten, non-path free text (commit messages, `grep` patterns) is not — the exposure notice in `integrations/claude-code/README.md` covers both clients. `CORRECTION_SYSTEM_PROMPT` is a **byte-identical** third copy set alongside `CLASSIFIER_SYSTEM_PROMPT` (`stop-extract.sh`, `integrations/pi/asaki-memory.ts`, `scripts/eval-classifier.sh`); `CORRECTION_SIGNAL_PATTERN`/`_RE` and the two per-client trace whitelists are sync sets too.
- Two more sync sets on the human surface: the `/memory` audit workflow steps are mirrored between `commands/memory.md` and `registerCommand("memory", …)` in `integrations/pi/asaki-memory.ts` (corrections first via `signal: "correction"` + `include_suggestions: true`, the supersession resolution guidance, the `asaki_memory_lifecycle` step with its keep/retire verdicts, the `promote_to_global` option, the 14-day stale clock), and the correction block of `formatReviewLine` plus `formatLifecycleReport` must stay character-identical between `src/mcp.ts` and the Pi copy (`npm run eval:review-format`).
- The active "Global scope discipline" text lives in four places that must stay in sync: `commands/memory.md`, `integrations/pi/asaki-memory.ts`'s `/memory` command, and `CLASSIFIER_SYSTEM_PROMPT` in both `integrations/claude-code/stop-extract.sh` and `integrations/pi/asaki-memory.ts`; `scripts/eval-classifier.sh` carries the eval copy. `src/services/extraction.ts` keeps a legacy compatibility copy only.

## Commands

```bash
npm install
npm run typecheck
npm run eval:candidates
npm run eval:candidate-fields
npm run eval:purge-scrub
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
npm run typecheck:pi
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
npm run eval:review-dedup
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
- Active writes use two paths: the conversation agent submits pre-distilled memories through `asaki_memory_add`, while the default background classifier (`pi:agent-end-classifier` or `claude-code:stop-classifier`) pre-distills at most one candidate and sends it to `POST /v1/memories/candidates`. Classifier candidates always enter the review queue and never auto-add/merge/update/delete — that invariant is unchanged by correction mode and by near-duplicate parking (a parked candidate is auto-resolved as `ignore`, which mutates no memory). With correction mode on (the default), a classifier candidate can additionally carry correction evidence (`signal`, `signal_subtype`, `rule_form`, `antecedent_source`, `correction`, `supersedes_query`, `project_context`); `importance` and `confidence` are then **derived server-side** from that evidence (`importanceForSignal()` / `confidenceForAntecedent()`, 0.7–0.9 for corrections vs 0.4 otherwise vs the 0.5 default when nothing is derivable) rather than emitted by the model. Corrections sort first in every review page, render as a block with a supersession suggestion, and retire the memory they contradict only when a human resolves the review — so a contradicted memory can stay active for the full 14-day audit cadence. Production history is predominantly classifier-sourced, so audit misses normally belong to the classifier eval/prompt surface. Server extraction (`POST /v1/memories/extract`, `asaki_memory_extract`, `*:auto-extract`) is deprecated and retained only for backward compatibility/manual investigation; do not enable it or send full transcripts through it.
- Session start injects TWO bounded blocks, not a memory dump. Both are built from the one `/v1/memories/list` response the clients already fetch, both are re-emitted on compact, and their kind sets partition the visible memories so nothing appears twice: (1) standing rules — ACTIVE `rule`/`preference` framed as directives to obey, `src/services/standingRules.ts`; (2) the project digest — the ACTIVE memories of every OTHER known kind (the DYNAMIC complement of the configured standing kinds), framed as context, not directives, `src/services/projectDigest.ts`. Both are scope-disciplined the same way (global always, project on match, session never) and ordered importance desc → recency desc → id desc. Only what neither block selected stays retrieval-only. Each block has its own switch (`ASAKI_MEMORY_STANDING_RULES`, `ASAKI_MEMORY_PROJECT_DIGEST`, both default on) and the complement boundary is independent of both switches. Run `npm run eval:standing-rules` after touching the standing canonical module/Pi copy/jq, `npm run eval:project-digest` after touching the digest ones, and `npm run eval:session-inject` after touching either client's wiring or the banner.
- Numeric injection env vars (`ASAKI_MEMORY_AUTO_INJECT_TOP_K` 6/cap 20, `ASAKI_MEMORY_PROJECT_DIGEST_MAX` 10/50, `..._MAX_CHARS` 3000/20000, `..._CONTENT_CHARS` 240/2000) share ONE contract in three copies (`parsePositiveIntEnv` in the Pi extension, `asaki_parse_positive_int` in both Claude hooks): pure decimal-string clamp, so an over-long digit run yields the cap instead of collapsing to the default, and bash never compares a big integer numerically. `ASAKI_MEMORY_AUTO_MIN_SCORE` uses the sibling `[0,1]`-only parser (`parseUnitScoreEnv` / `asaki_parse_unit_score`) — an out-of-range value would 400 the search and kill the whole auto-inject. Both clients send the validated `min_score` to the search API so un-injected low-score results don't bump `last_accessed_at`. `npm run eval:inject-env` runs one table against all copies.
- The session-start status banner is a fixed field sequence — `user → project → auth? → memories? → pendingReviews? → classifier? → standingRules? → projectDigest?` — with no-information fields omitted WHOLE (disabled classifier, disabled/empty/unfetchable blocks) rather than printed as `off`/`0/0`/`?`. `autoExtract` is deliberately absent from both clients' banners; the still-switchable deprecated path is diagnosed in `/memory status` instead. The two builders (`buildSessionBannerLine` in the Pi `// #region asaki-banner`, `asaki_banner_line` in `integrations/claude-code/session-start.sh`) are a sync set enforced by `npm run eval:session-inject`.
- Project attribution for classifier candidates is a model answer plus a client veto: the classifier emits `project_id`, and the client accepts it only when it matches the allowlist `integrations/claude-code/project-context.mjs` computed (`resolve_candidate_project` in the hook, `resolveCandidateProjectId` in Pi). Unresolvable means skip — never fall back to the hosting repository. Global candidates carry no `project_id`; they may still carry the resolved repo as `project_context`.
- Candidate processing should run deterministic duplicate checks before LLM decisions.
- Run `npm run eval:candidates` after changing candidate dedupe thresholds or prompts.
- `npm run eval:extraction` covers the deprecated compatibility path. Run it only when that path changes or an audited memory explicitly has a legacy extraction source.
- Run `npm run eval:classifier` after changing either classifier prompt (`CLASSIFIER_SYSTEM_PROMPT` / `CORRECTION_SYSTEM_PROMPT` in `integrations/claude-code/stop-extract.sh`); it runs with correction mode ON by default (`ASAKI_MEMORY_CORRECTION_MODE=0` selects the legacy prompt) and enforces the rollout gates. It is the one eval that spends real model time, so it is TIERED: during prompt/fixture iteration run the changed family plus the smoke subset (`ASAKI_CLASSIFIER_FIXTURES=test/fixtures/classifier-smoke.json npm run eval:classifier` — a subset file may list case NAMES out of `classifier-cases.json`, not just whole case objects), and run ONE full green pass before opening the PR; a subset pass never substitutes for that. The calls run concurrently (`ASAKI_CLASSIFIER_CONCURRENCY`, default 8) with a per-call timeout and one retry (`ASAKI_CLASSIFIER_TIMEOUT`, default 120s); only the calls are parallel — assertions, counters and gates still run sequentially in fixture order, so verdicts and output are concurrency-independent. Run `npm run typecheck:pi` after touching the Pi extension, and the offline `eval:correction-signal` / `eval:trace-sensitive` / `eval:trace-builder` / `eval:throttle-state` after touching the signal pattern, the trace gate/redaction, the delta builders or the throttle/HTTP decision functions. Add a new case to `test/fixtures/classifier-cases.json` whenever a production false positive/negative turns up (a memory audit is the routine trigger — see "Few-shot self-iteration").
- Pi auto inject defaults to `ASAKI_MEMORY_AUTO_MIN_SCORE=0.67` (calibrated via `npm run eval:search`); keep low-score memories out of injected context.
- Correction evidence written into `memory_reviews.candidate_json` persists in D1 indefinitely, including after a review is resolved or ignored. The only removal paths are an explicit `purgeMemory()` on the produced memory (which scrubs the row to `{"purged":true}`) and manual SQL; there is no review prune endpoint or script, and retention policy is a deferred captain decision, not an implementation gap.
- Memory lifecycle (captain decisions 4/8/9, 2026-07-31; reaches production at the NEXT release): a correction candidate that duplicates an ALREADY-ACTIVE `rule`/`preference` is a RECURRENCE, not noise — it reinforces that memory (bounded +0.05 importance, cap 0.95, never lowering a hand-set value) and increments `metadata_json.reinforcement.count` instead of queueing a review. Direction is decided by which lookup matched: the candidate's own content matching = same direction (reinforce/promote), `supersedes_query` matching = opposite (supersede). `repeat_rate` and the long-idle standing rules come from `POST /v1/memories/lifecycle`; idle rules are a human keep/retire prompt and are never auto-deleted or demoted out of injection. Cross-project matches only ever attach a `promote_to_global` suggestion — scope changes require an explicit human `promote_to_global` on resolve (valid with `action: "add"` only) or `asaki_memory_update`.
- Run `npm run eval:review-format` after touching either `formatReviewLine` copy (`src/mcp.ts`, the Pi `// #region asaki-review-format` block) or the audit-flow text they feed.
- Service-layer validation failures meant for API callers must throw `UserFacingError` (`src/utils/errors.ts`); route handlers only forward those messages — never raw `Error` messages.
- Keep changes small and consistent with existing style.
- Run `npm run typecheck` after TypeScript edits.

## Few-shot self-iteration

Every audit that rejects, rescopes, or compresses a classifier-produced memory must fix the root cause, not just the symptom. Classifier is the active/default background path and the source of most production memories. Memory/review list output includes `source` and `created_at`; route explicit legacy extraction sources separately:

| Rejected memory `source` | Pipeline at fault | Add regression case to | Update few-shot in (all copies stay identical) | Verify |
|---|---|---|---|---|
| `claude-code:stop-classifier`, `pi:agent-end-classifier` | local classifier | `test/fixtures/classifier-cases.json` | `CLASSIFIER_SYSTEM_PROMPT` in `integrations/claude-code/stop-extract.sh`, `integrations/pi/asaki-memory.ts`, and `scripts/eval-classifier.sh` | `npm run eval:classifier` |
| same two sources, but the review rendered as `[correction · … · …]` | local classifier, correction path | `test/fixtures/classifier-cases.json` **with the correction block**: the delta that produced it plus `expectSignal` / `expectSignalSubtype` / `expectRuleForm` / `expectAntecedentSource`, and either the corrected rule text (`expectRuleIncludes`) or `expectFlag: false` | `CORRECTION_SYSTEM_PROMPT` in the same three files (byte-identical copies) | `npm run eval:classifier` |
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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
