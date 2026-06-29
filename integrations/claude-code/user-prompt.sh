#!/usr/bin/env bash
# Hook: UserPromptSubmit
#
# Injects a memory precheck instruction into Claude Code's context on each
# user message. Tells the model when to call asaki_memory_search vs skip it.
# Output: JSON with hookSpecificOutput.additionalContext
set -uo pipefail

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""' 2>/dev/null || echo "")

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


jq -cn --arg ctx "$_CTX" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'

exit 0
