#!/usr/bin/env bash
# Hook: SessionStart
#
# Injects a compact Asaki Memory status banner (counts only, no memory
# content) into Claude Code's session context. Fires on startup, resume, and
# compact — a content-bearing digest would re-inject its full text on every
# compact within the same session and pile up in the transcript, so this
# intentionally mirrors the Pi extension's buildSessionBanner(): numbers
# only, the agent decides for itself when to actually search/read memories.
#
# Also injects the top ASAKI_MEMORY_STARTUP_TOP_K (default 6) highest-
# importance active memories from each of the global and project scopes
# once at session start (startup/resume, not compact) — a one-shot seed so
# the agent doesn't need to search for well-known context immediately.
# Scopes are seeded independently (not pooled-then-sorted) so a scope with
# many high-importance memories can't crowd the other one out entirely.
# Later turns still rely on on-demand search rather than per-turn
# auto-inject. Default on; set ASAKI_MEMORY_STARTUP_INJECT=0 to disable.
#
# Output: plain text injected into the system context.
set -uo pipefail

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo "startup")
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")

ASAKI_BASE="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-https://asaki-memory-manager.YOUR_SUBDOMAIN.workers.dev}}"
ASAKI_USER="${ASAKI_MEMORY_USER_ID:-asaki}"
AUTO_EXTRACT_STATE="off"
[ "${ASAKI_MEMORY_AUTO_EXTRACT:-0}" = "1" ] && AUTO_EXTRACT_STATE="on"

if [ -n "${ASAKI_MEMORY_PROJECT_ID:-}" ]; then
  ASAKI_PROJECT="$ASAKI_MEMORY_PROJECT_ID"
elif [ -n "$CWD" ] && GIT_ROOT=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) && [ -n "$GIT_ROOT" ]; then
  ASAKI_PROJECT=$(basename "$GIT_ROOT")
elif [ -n "$CWD" ]; then
  ASAKI_PROJECT=$(basename "$CWD")
else
  ASAKI_PROJECT="unknown"
fi

if [ -z "${ASAKI_MEMORY_API_KEY:-}" ]; then
  cat <<BANNER
## Asaki Memory — Setup Required

\`user=${ASAKI_USER} | project=${ASAKI_PROJECT} | auth=none\`

\`ASAKI_MEMORY_API_KEY\` is not set. Set it in \`~/.claude/settings.json\` under \`env\`.
BANNER
  exit 0
fi

MEMORY_COUNT="?"
PENDING_REVIEWS="?"
if command -v curl >/dev/null 2>&1; then
  LIST_RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"project_id\":\"${ASAKI_PROJECT}\",\"status\":\"active\",\"limit\":100}" 2>/dev/null || echo "")
  [ -n "$LIST_RESP" ] && MEMORY_COUNT=$(echo "$LIST_RESP" | jq '(.memories // []) | length' 2>/dev/null || echo "?")

  REVIEW_RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/reviews/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"project_id\":\"${ASAKI_PROJECT}\",\"status\":\"pending\",\"limit\":100}" 2>/dev/null || echo "")
  [ -n "$REVIEW_RESP" ] && PENDING_REVIEWS=$(echo "$REVIEW_RESP" | jq '(.reviews // []) | length' 2>/dev/null || echo "?")
fi

TOP_MEMORIES_SECTION=""
if [ "${ASAKI_MEMORY_STARTUP_INJECT:-1}" = "1" ] && [ "$SOURCE" != "compact" ]; then
  TOP_K="${ASAKI_MEMORY_STARTUP_TOP_K:-6}"

  GLOBAL_RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"scope\":\"global\",\"status\":\"active\",\"limit\":100}" 2>/dev/null || echo "")
  PROJECT_RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"scope\":\"project\",\"project_id\":\"${ASAKI_PROJECT}\",\"status\":\"active\",\"limit\":100}" 2>/dev/null || echo "")

  TOP_FILTER='(.memories // []) | sort_by(-(.importance // 0)) | .[0:$k] | map("- [\(.scope)/\(.kind), importance=\(.importance)] \(.content)") | .[]'
  TOP_GLOBAL=$([ -n "$GLOBAL_RESP" ] && echo "$GLOBAL_RESP" | jq -r --argjson k "$TOP_K" "$TOP_FILTER" 2>/dev/null || echo "")
  TOP_PROJECT=$([ -n "$PROJECT_RESP" ] && echo "$PROJECT_RESP" | jq -r --argjson k "$TOP_K" "$TOP_FILTER" 2>/dev/null || echo "")
  TOP_MEMORIES=$(printf '%s\n%s' "$TOP_GLOBAL" "$TOP_PROJECT" | sed '/^$/d')

  if [ -n "$TOP_MEMORIES" ]; then
    TOP_MEMORIES_SECTION="
### Top ${TOP_K} global + top ${TOP_K} project memories (highest importance, one-shot seed)

${TOP_MEMORIES}
"
  fi
fi

cat <<BANNER
## Asaki Memory Active

\`user=${ASAKI_USER} | project=${ASAKI_PROJECT} | memories=${MEMORY_COUNT} | pendingReviews=${PENDING_REVIEWS} | autoExtract=${AUTO_EXTRACT_STATE}\`
${TOP_MEMORIES_SECTION}
IMPORTANT: In your FIRST response, display this exact status line as your opening line:
\`\`\`
Asaki Memory Active | user=${ASAKI_USER} | project=${ASAKI_PROJECT} | memories=${MEMORY_COUNT} | pendingReviews=${PENDING_REVIEWS} | autoExtract=${AUTO_EXTRACT_STATE}
\`\`\`

Always include \`user_id: "${ASAKI_USER}"\` in every \`asaki_memory_search\` and \`asaki_memory_add\` call.

After completing any task, decision, or meaningful exchange, decide yourself whether it is worth storing durably via \`asaki_memory_add\` (decisions, bug fixes, patterns, preferences, task outcomes). Keep each memory to 1-3 sentences summarizing the durable takeaway only — never paste multi-paragraph implementation logs, changelogs, or step-by-step narratives.
BANNER

exit 0
