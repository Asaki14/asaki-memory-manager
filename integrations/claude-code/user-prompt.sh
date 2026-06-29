#!/usr/bin/env bash
# Hook: UserPromptSubmit
#
# Injects a memory precheck instruction into Claude Code's context on each
# user message. Tells the model when to call asaki_memory_search vs skip it.
# Also triggers auto-extract after significant conversation exchanges.
#
# Output: JSON with hookSpecificOutput.additionalContext
set -uo pipefail

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null || echo "")

# Skip for very short messages
if [ ${#PROMPT} -lt 20 ]; then
  exit 0
fi

MEMORY_NEEDED_RE='(记忆|记得|回忆|以前|之前|上次|历史|偏好|习惯|约定|决策|背景|上下文|继续|延续|remember|recall|memory|previous|before|last time|preference|convention|decision|context|continue)'
RESUME_RE='(where.*(leave|left) off|continue.*where|what.*working|pick up where|resume|catch me up|where are we)'
REMEMBER_RE='(remember this|save this|store this|记住|保存记忆|帮我记)'

_CTX=""

if echo "$PROMPT" | grep -qiE "$RESUME_RE"; then
  _CTX="Session resume detected. Search Asaki memory for recent session state and decisions to pick up where you left off. Call asaki_memory_search with queries like 'recent session state' and 'decisions this project'."
elif echo "$PROMPT" | grep -qiE "$REMEMBER_RE"; then
  _CTX="Remember intent detected. Use asaki_memory_add to store what the user wants remembered."
elif echo "$PROMPT" | grep -qiE "$MEMORY_NEEDED_RE"; then
  _CTX="This turn may need durable memory. Call asaki_memory_search only if the answer or next action depends on remembered preferences, prior decisions, conventions, or past project facts."
else
  _CTX="This turn appears standalone. Skip asaki_memory_search; proceed directly unless the task truly depends on prior durable memory."
fi

# Background auto-extract: every 6th substantial message, run extraction
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
MSG_COUNT_FILE="/tmp/asaki_msg_count_${USER:-default}${SESSION_ID:+_$SESSION_ID}"
MSG_COUNT=0
[ -f "$MSG_COUNT_FILE" ] && MSG_COUNT=$(cat "$MSG_COUNT_FILE" 2>/dev/null || echo "0")
MSG_COUNT=$((MSG_COUNT + 1))
printf '%s' "$MSG_COUNT" > "$MSG_COUNT_FILE" 2>/dev/null || true

TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // ""' 2>/dev/null || echo "")
if [ $((MSG_COUNT % 6)) -eq 0 ] && [ -n "${ASAKI_MEMORY_API_KEY:-}" ] && [ -n "$TRANSCRIPT_PATH" ]; then
  _EXTRACT_SCRIPT="$(dirname "$0")/extract-from-transcript.sh"
  if [ -x "$_EXTRACT_SCRIPT" ]; then
    echo "$INPUT" | "$_EXTRACT_SCRIPT" 2>/dev/null &
  fi
fi

jq -cn --arg ctx "$_CTX" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'

exit 0
