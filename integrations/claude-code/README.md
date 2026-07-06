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
- `stop-extract.sh` — Stop hook, fires after every assistant turn. Sends the
  plain-text user/assistant lines appended since the last processed transcript
  offset to `/v1/memories/extract` for server-side LLM-based background
  extraction (add/merge/ignore, same dedup pipeline as `asaki_memory_add`).
  Tool calls, tool results, and thinking blocks are never sent — only plain
  text turns. Fire-and-forget: the extraction request backgrounds itself so it
  never blocks the Stop event. This intentionally sends conversation text
  off-machine to the Worker. The Pi extension can make the same tradeoff when
  `ASAKI_MEMORY_AUTO_EXTRACT=1`, but uses Pi's `agent_end` event directly
  instead of transcript offset files. Per-session offset/log files live under
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
