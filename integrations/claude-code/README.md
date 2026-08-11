# Claude Code setup

Distributed as a Claude Code plugin (`.claude-plugin/plugin.json` at repo root)
bundling the MCP server + hooks together. No manual settings.json/mcpServers
editing, no absolute paths to this repo — everything resolves via
`${CLAUDE_PLUGIN_ROOT}`.

## Install

```bash
claude plugin marketplace add /path/to/asaki-memory-manager
claude plugin install asaki-memory@asaki-memory
```

Note: `hooks/hooks.json` and `.mcp.json` live at the plugin's default
discovery paths (repo root) — the installed Claude Code CLI doesn't resolve
custom `"hooks"`/`"mcpServers"` path fields in `plugin.json`, only the
default locations. Their `command` entries still point into
`integrations/claude-code/` and `integrations/mcp/` via `${CLAUDE_PLUGIN_ROOT}`.

## Secret

The bundled `.mcp.json` (remote MCP `url` + bearer header) and `session-start.sh`
read `ASAKI_MEMORY_API_KEY` (and `ASAKI_MEMORY_BASE_URL`) from the process
environment (never hardcoded / never committed). Set them once in
`~/.claude/settings.json`:

```json
{
  "env": {
    "ASAKI_MEMORY_API_KEY": "your-admin-api-key",
    "ASAKI_MEMORY_BASE_URL": "https://your-worker-subdomain.workers.dev"
  }
}
```

## What's bundled

- `session-start.sh` — SessionStart hook, fires on startup/resume/compact.
  Injects a compact counts-only status banner (`memories=N | pendingReviews=N
  | autoExtract=on|off`) — no memory content. Pi additionally shows its
  local classifier state in the native extension banner. Mirrors the Pi extension's
  `buildSessionBanner()`: the agent decides for itself when to actually
  search/read memories instead of receiving a startup memory dump. The one
  content-bearing exception is the standing-rule block (see below).
- `standing-rules.jq` — selection and rendering for the standing-rule block
  `session-start.sh` emits ahead of the banner: ACTIVE `rule`/`preference`
  memories (global always, project only on match, session never), capped at
  `ASAKI_MEMORY_STANDING_RULES_MAX` (default 20) and 4000 characters, ordered
  importance desc → recency desc → id, with a truncation marker when more
  exist. It reuses the list response the banner already fetches, so it costs
  no extra request. Unlike the banner it IS re-emitted on compact — standing
  rules have to survive compaction. Set `ASAKI_MEMORY_STANDING_RULES=0` to
  disable, `ASAKI_MEMORY_STANDING_RULES_KINDS=rule` to drop preferences.
  KEEP IN SYNC with `src/services/standingRules.ts` (canonical) and its
  verbatim copy in `../pi/asaki-memory.ts`; `npm run eval:standing-rules`
  enforces it.
- `user-prompt.sh` — UserPromptSubmit hook. Unconditionally injects one fixed
  instruction every turn: the agent itself reads user intent and decides
  whether `asaki_memory_search` is needed, and if so picks its own
  query/scope/top_k — same as the Pi extension's
  `memoryPrecheckInstruction()` (`../pi/asaki-memory.ts`). Additionally, when
  `ASAKI_MEMORY_AUTO_INJECT=1` (default off), it mirrors the Pi extension's
  `before_agent_start`/`autoInjectMemory()`: on turns whose prompt matches a
  memory-related keyword regex (or unconditionally with
  `ASAKI_MEMORY_AUTO_INJECT_ALWAYS=1`) and isn't flagged as containing
  secrets, it runs one `/v1/memories/search` call (top_k=6), keeps only
  results scoring at or above `ASAKI_MEMORY_AUTO_MIN_SCORE` (default 0.67),
  and injects those into context before the agent starts — so memory recall
  doesn't depend solely on the agent proactively calling the tool. Output is
  capped at a fixed character budget regardless of result count.
- `stop-extract.sh` — Stop hook, runs after every assistant turn. There are two
  modes:
  - `ASAKI_MEMORY_AUTO_EXTRACT=1`: sends the plain-text user/assistant lines
    appended since the last processed transcript offset to
    `/v1/memories/extract` for server-side LLM-based background extraction.
    This intentionally sends conversation text off-machine to the Worker.
  - default `ASAKI_MEMORY_AUTO_EXTRACT=0`: deprecated cloud auto-extract stays off; the
    active hook path runs a local classifier via `claude -p --safe-mode` (no tools) in the
    background. This still sends the conversation delta to the Claude
    CLI/model provider for judgment only. It judges the delta against the
    6-criteria checklist and, if it qualifies, pre-distills it into
    ready-to-write fields (one-sentence `text`, `type`, `scope`). The same
    background job then executes the write itself over plain HTTP — `POST
    /v1/memories/candidates`, the same endpoint the `asaki_memory_add` MCP
    tool calls under the hood, so it gets the same server-side dedup/merge
    pipeline — with no Claude/MCP involved in that step. The main
    conversation agent is never forced into an extra turn for this path; the
    next Stop event just reports the real outcome as a one-line
    `systemMessage`.


  Two flags extend this path, both **on by default** (set either to `0` to opt out):

  - `ASAKI_MEMORY_CORRECTION_MODE` (default `1`) — runs the classifier on the correction
    prompt/schema: it detects the user correcting the agent, records the
    contrast pair (`agent_did` / `captain_verdict` / `redirect_target`), infers
    a durable rule, and sends the extra evidence fields on the candidate. It
    also replays the last ~8 lines of the previous processed delta as a
    labelled `Prior context (ALREADY PROCESSED ...)` block, and lets one
    correction-signalled turn per throttle window fire an extra classifier call
    (a hard ceiling of 2 calls per window, never more).
  - `ASAKI_MEMORY_ACTION_TRACE` (default `1`) — adds one `Tool: <name> <arg>`
    line per assistant tool call to the delta, so a terse verdict ("别再自动
    commit 了") has a recoverable antecedent. **Read the exposure notice below
    and decide whether to leave it on.** Tool *results* and thinking blocks are
    never sent.

  With correction mode off, the prompt, the JSON schema, the POST body and the
  call frequency are exactly what they were before this feature existed — but
  the delta text is byte-for-byte identical only when action trace is off as
  well, since trace adds its `Tool:` lines to the delta regardless of correction
  mode. Byte-identical input therefore requires **both** flags off.

  **What action trace sends off-machine.** Per tool call, one line leaves this
  machine: the tool name plus **one** argument, capped at 120 characters.
  Absolute paths, URIs and `user@host` targets are replaced by `<path>` /
  `<uri:scheme>` / `<host>`, so filesystem layout outside the current repo,
  customer directory names, private bucket names and internal hostnames do not
  leave. What is **not** bounded and leaves verbatim: repo-relative paths inside
  the current repo, command binaries and their flags, and any free-text
  argument that is not a path — commit messages, branch/PR titles, and
  `grep`/`find` patterns. Those are gated only by credential patterns, which
  look for secrets, not for confidentiality: `git commit -m "fix Acme pricing
  before the layoff announcement"` will be sent as written. If your working
  style routinely puts confidential material in commit messages or search
  patterns, set `ASAKI_MEMORY_ACTION_TRACE=0` — correction mode still works on
  prose antecedents without it, at lower recall. The flag is per-machine and
  takes effect on the next Stop event.

  **What the project context block sends off-machine.** Every classifier call is
  now prefixed with a short, client-computed block naming the host repository,
  the repositories currently in play, and the one the work is attributed to.
  Those are **repository names only** — no paths, no branches, no contents — but
  on an orchestrator host they include the names of repositories other than the
  one this session is about. It is what lets a memory be filed under the repo the
  work is about instead of the repo the session runs in; when nothing is uniquely
  attributable the candidate is dropped before any request is made. Set
  `ASAKI_MEMORY_PROJECT_ID` to pin one project explicitly, which both narrows the
  block to that single name and overrides the classifier's answer.

  Correction evidence written into `memory_reviews.candidate_json` persists in
  D1 indefinitely, including after a review is resolved or ignored.

  Both modes are throttled to at most once per
  `ASAKI_MEMORY_EXTRACT_MIN_INTERVAL_SECONDS` (default 300) — a throttled
  turn's text is not dropped, it's carried into the next Stop event's (larger)
  increment. A delta matching a private-key/bearer-token/API-key/AWS-key/
  secret-assignment pattern is never sent to either the Worker or classifier
  (offset is consumed instead, matching the Pi extension's
  `containsSensitiveText()` gate — see `SENSITIVE_RE_LIST` in
  `../pi/asaki-memory.ts`). In Worker extraction mode, extracted candidates are
  capped at 2 per call; project-scope candidates with importance ≥ 0.6 are
  auto-added (same dedup pipeline as `asaki_memory_add`), and everything else
  (global scope, or importance < 0.6) is queued to `/v1/memories/reviews` for
  human review instead of being written directly. Tool calls, tool results, and
  thinking blocks are never sent — only plain text turns. Fire-and-forget:
  extraction/classifier requests background themselves so Stop does not block.
  Per-session offset/log/throttle files live under
  `${TMPDIR:-/tmp}/asaki-memory-stop-extract/`.
- `tool-visibility.sh` — PostToolUse hook, surfaces memory tool calls in the TUI
- `.mcp.json` — **remote** MCP server reference (`type: http`, `url:
  ${ASAKI_MEMORY_BASE_URL}/mcp`, bearer auth). The MCP server runs inside the
  Worker (`src/mcp.ts`), so Claude Code spawns **no local node process** and the
  same `asaki_memory_search`/`asaki_memory_add`/etc. tools are served over HTTP.
  Because the Worker has no local git checkout, `project_id` is not auto-derived
  from a git root as it was in the stdio server — the agent passes it explicitly
  (the session-start banner already reports `project=<name>`). `user_id`
  defaults to the Worker's `ASAKI_MCP_DEFAULT_USER_ID` (or `asaki`). The
  standalone stdio server `../mcp/asaki-memory.ts` / `dist/mcp-server.mjs` is
  still available for other MCP clients (e.g. Codex) that need a local process.
- `../../commands/memory.md` — `/memory` slash command. `/memory status` checks
  backend connectivity only; any other args (or none) run a full audit:
  list pending reviews + global/project memories, propose
  REVIEW_RESOLVE/DELETE/UPDATE/MERGE/ADD/KEEP changes, confirm with the user,
  then execute. Same workflow as the Pi extension's `/memory` command
  (`registerCommand("memory", ...)` in `../pi/asaki-memory.ts`).

Restart Claude Code (new session) after install/update for hooks + MCP tools +
commands to load.
