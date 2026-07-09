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

The bundled `.mcp.json` and `session-start.sh` read `ASAKI_MEMORY_API_KEY` (and
`ASAKI_MEMORY_BASE_URL`) from the process environment (never hardcoded / never
committed). Set them once in `~/.claude/settings.json`:

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
  | autoExtract=on|off`) — no memory content. Mirrors the Pi extension's
  `buildSessionBanner()`: a content-bearing digest would re-inject its full
  text on every `compact` within the same session and pile up in the
  transcript, so the agent decides for itself when to actually search/read
  memories instead. It also seeds the banner once at startup/resume (not on
  `compact`) with the top `ASAKI_MEMORY_STARTUP_TOP_K` (default 6)
  highest-importance active memories — a one-shot list, not a per-turn
  injection. Default on; set `ASAKI_MEMORY_STARTUP_INJECT=0` to disable.
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
  - default `ASAKI_MEMORY_AUTO_EXTRACT=0`: cloud auto-extract stays off, but the
    hook runs a local classifier via `claude -p --safe-mode` (no tools) in the
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
- `../mcp/asaki-memory.ts` — MCP server exposing `asaki_memory_search`/`asaki_memory_add`/etc.
- `../../commands/memory.md` — `/memory` slash command. `/memory status` checks
  backend connectivity only; any other args (or none) run a full audit:
  list pending reviews + global/project memories, propose
  REVIEW_RESOLVE/DELETE/UPDATE/MERGE/ADD/KEEP changes, confirm with the user,
  then execute. Same workflow as the Pi extension's `/memory` command
  (`registerCommand("memory", ...)` in `../pi/asaki-memory.ts`).

Restart Claude Code (new session) after install/update for hooks + MCP tools +
commands to load.
