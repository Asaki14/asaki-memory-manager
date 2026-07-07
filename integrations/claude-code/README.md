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

- `session-start.sh` — SessionStart hook. Always shows the status banner; if
  the cwd is inside a project (git repo), it also calls `/v1/memories/list`
  itself (global + this project's scope) and injects a **real digest** of the
  top `ASAKI_MEMORY_DIGEST_TOP_K` (default 8) memories ranked by
  `importance * confidence` — actual project history up front, not a "go
  search yourself" nudge.
- `user-prompt.sh` — UserPromptSubmit hook. Unconditionally injects one fixed
  instruction every turn (no keyword regex, no scripted API call): the agent
  itself reads user intent and decides whether `asaki_memory_search` is
  needed, and if so picks its own query/scope/top_k — same as the Pi
  extension's `memoryPrecheckInstruction()` (`../pi/asaki-memory.ts`). What's
  "stable" here is the instruction always firing, not a deterministic search;
  the actual search/add decision is the agent's judgment call.
- `stop-extract.sh` — Stop hook, runs after every assistant turn but only
  actually fires when `ASAKI_MEMORY_AUTO_EXTRACT=1` is set (default off,
  matching the Pi extension). When enabled, sends the plain-text user/assistant
  lines appended since the last processed transcript offset to
  `/v1/memories/extract` for server-side LLM-based background extraction,
  throttled to at most once per `ASAKI_MEMORY_EXTRACT_MIN_INTERVAL_SECONDS`
  (default 300) — a throttled turn's text is not dropped, it's carried into
  the next Stop event's (larger) increment. Extracted candidates are capped at
  2 per call; within that, project-scope candidates with importance ≥ 0.6 are
  auto-added (same dedup pipeline as `asaki_memory_add`), and everything else
  (global scope, or importance < 0.6) is queued to `/v1/memories/reviews`
  for human review instead of being written directly. Tool calls, tool
  results, and thinking blocks are never sent — only plain text turns.
  Fire-and-forget: the extraction request backgrounds itself so it never
  blocks the Stop event. This intentionally sends conversation text
  off-machine to the Worker. Per-session offset/log/throttle files live under
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
