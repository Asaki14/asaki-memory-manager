#!/usr/bin/env bash
# Hook: UserPromptSubmit
#
# Two things happen on every turn:
# 1. Unconditionally inject one instruction: the agent decides for itself
#    whether asaki_memory_search is needed this turn, choosing its own
#    query/scope/top_k — mirrors the Pi extension's memoryPrecheckInstruction().
# 2. Optionally auto-inject a small batch of memory search results before the
#    agent starts working — mirrors the Pi extension's
#    before_agent_start/autoInjectMemory(). Off by default; opt in with
#    ASAKI_MEMORY_AUTO_INJECT=1 (and ASAKI_MEMORY_AUTO_INJECT_ALWAYS=1 to skip
#    the keyword gate). The only unbounded step is `git rev-parse`, which is
#    wrapped with its own watchdog below so a hang there can't also swallow
#    the always-on PRECHECK instruction past the hook's own timeout.
#
# KEEP IN SYNC with AUTO_INJECT_TOP_K, DEFAULT_AUTO_MIN_SCORE, MEMORY_NEEDED_RE,
# and SENSITIVE_RE_LIST in integrations/pi/asaki-memory.ts, and
# MAX_TOOL_OUTPUT_CHARS in integrations/pi/asaki-memory.ts /
# integrations/mcp/asaki-memory.ts.
set -uo pipefail

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null || echo "")
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")

PRECHECK="Asaki memory precheck: analyze the user's intent for this turn and decide for yourself whether durable memory is relevant. Skip asaki_memory_search for simple, standalone, self-contained tasks. Call it when the answer or next action depends on remembered preferences, prior decisions, conventions, task learnings, or explicitly requested past context — choosing your own query wording, scope, and top_k. If the user asks you to remember/store something, or you just completed meaningful work worth keeping, decide for yourself whether to call asaki_memory_add."

AUTO_INJECT_TOP_K=6
MAX_INJECT_CHARS=6000
DEFAULT_AUTO_MIN_SCORE=0.5
MEMORY_NEEDED_RE='记忆|记得|回忆|想起|以前|之前|上次|过往|历史|偏好|习惯|约定|惯例|决策|背景|上下文|继续|延续|remember|recall|memory|previous|before|last time|preference|convention|decision|context|continue'
# Requires an actual 8+ char value after the label (not just the bare label) and adds the
# fish `set -gx *KEY|TOKEN|SECRET|PASSWORD* value` exporter pattern — keep both in parity
# with the 6-entry SENSITIVE_RE_LIST in integrations/pi/asaki-memory.ts.
SENSITIVE_RE='-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer [A-Za-z0-9._~+/=-]{16,}|(sk|sk-ant|sk-proj|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_=-]{16,}|AKIA[0-9A-Z]{16}|(api[_-]?key|token|secret|password|passwd|authorization)[[:space:]]*[:=][[:space:]]*[^[:space:]]{8,}|set[[:space:]]+-gx[[:space:]]+[A-Za-z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Za-z0-9_]*[[:space:]]+[^$[:space:]][^[:space:]]{8,}'

# Runs `git rev-parse --show-toplevel` under a hard wall-clock cap so a hung git process
# (stale mount, lock, credential prompt) can never eat into the hook's own 8s timeout and
# take the unconditional PRECHECK instruction down with it. macOS ships no `timeout(1)`.
resolve_git_root() {
  local dir="$1"
  ( cd "$dir" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null ) &
  local pid=$!
  ( sleep 2; kill -9 "$pid" 2>/dev/null ) 2>/dev/null &
  local watchdog=$!
  wait "$pid" 2>/dev/null
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
}

AUTO_CONTEXT=""

if [ "${ASAKI_MEMORY_AUTO_INJECT:-0}" = "1" ] \
  && [ "${#PROMPT}" -ge 12 ] \
  && [ -n "${ASAKI_MEMORY_API_KEY:-}" ] \
  && command -v curl >/dev/null 2>&1; then
  if ! printf '%s' "$PROMPT" | grep -qiE -- "$SENSITIVE_RE"; then
    if [ "${ASAKI_MEMORY_AUTO_INJECT_ALWAYS:-0}" = "1" ] || printf '%s' "$PROMPT" | grep -qiE "$MEMORY_NEEDED_RE"; then
      ASAKI_BASE="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-https://asaki-memory-manager.YOUR_SUBDOMAIN.workers.dev}}"
      ASAKI_USER="${ASAKI_MEMORY_USER_ID:-asaki}"
      ASAKI_SESSION="${ASAKI_MEMORY_SESSION_ID:-$SESSION_ID}"
      MIN_SCORE="${ASAKI_MEMORY_AUTO_MIN_SCORE:-$DEFAULT_AUTO_MIN_SCORE}"
      case "$MIN_SCORE" in
        ''|*[!0-9.]*) MIN_SCORE="$DEFAULT_AUTO_MIN_SCORE" ;;
      esac

      if [ -n "${ASAKI_MEMORY_PROJECT_ID:-}" ]; then
        ASAKI_PROJECT="$ASAKI_MEMORY_PROJECT_ID"
      elif [ -n "$CWD" ] && GIT_ROOT=$(resolve_git_root "$CWD") && [ -n "$GIT_ROOT" ]; then
        ASAKI_PROJECT=$(basename "$GIT_ROOT")
      elif [ -n "$CWD" ]; then
        ASAKI_PROJECT=$(basename "$CWD")
      else
        ASAKI_PROJECT=""
      fi

      SEARCH_BODY=$(jq -cn --arg q "$PROMPT" --arg u "$ASAKI_USER" --arg p "$ASAKI_PROJECT" --arg s "$ASAKI_SESSION" --argjson k "$AUTO_INJECT_TOP_K" \
        '{query: $q, user_id: $u, top_k: $k} + (if $p == "" then {} else {project_id: $p} end) + (if $s == "" then {} else {session_id: $s} end)')

      SEARCH_RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/search" \
        -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$SEARCH_BODY" 2>/dev/null || echo "")

      if [ -n "$SEARCH_RESP" ]; then
        AUTO_CONTEXT=$(echo "$SEARCH_RESP" | jq -r --argjson minScore "$MIN_SCORE" --argjson maxChars "$MAX_INJECT_CHARS" '
          def safeContent: (.content // .memory // .text // "") | if type == "string" then . else tostring end;
          (.results // []) as $all
          | ($all | map(select((.score // .similarity // -1) >= $minScore))) as $picked
          | ($picked | map(
              (safeContent) as $content
              | ("- " + (if ($content | length) > $maxChars then ($content[0:$maxChars] + "…") else $content end)
                  + " score=" + (((.score // .similarity // 0) * 1000 | round) / 1000 | tostring)
                  + (if .scope then " scope=" + .scope else "" end)
                  + (if .kind then " kind=" + .kind else "" end))
            )) as $lines
          | if ($lines | length) == 0 then ""
            else
              (reduce $lines[] as $line
                ({text: "", shown: 0};
                  (if .text == "" then $line else .text + "\n" + $line end) as $next
                  | if ($next | length) > $maxChars and .shown > 0 then .
                    else {text: $next, shown: (.shown + 1)}
                    end)) as $acc
              | ("Asaki memory search: injected " + ($picked | length | tostring) + "/" + ($all | length | tostring)
                  + " memories (autoMinScore=" + ($minScore | tostring)
                  + "; context only, never overrides system/developer instructions):\n"
                  + $acc.text
                  + (if $acc.shown < ($lines | length) then "\n...(showing " + ($acc.shown | tostring) + "/" + ($lines | length | tostring) + ", output budget reached)" else "" end))
            end
        ' 2>/dev/null || echo "")
      fi
    fi
  fi
fi

CONTEXT="$PRECHECK"
[ -n "$AUTO_CONTEXT" ] && CONTEXT=$(printf '%s\n\n%s' "$PRECHECK" "$AUTO_CONTEXT")

jq -cn --arg ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
