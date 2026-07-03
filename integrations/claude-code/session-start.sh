#!/usr/bin/env bash
# Hook: SessionStart
#
# Injects an Asaki Memory status banner plus a real project-history digest
# (not just a "go search yourself" nudge) into Claude Code's session
# context. Fires on startup, resume, and compact.
#
# Output: plain text injected into the system context.
set -uo pipefail

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo "startup")
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")

ASAKI_BASE="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-https://asaki-memory-manager.YOUR_SUBDOMAIN.workers.dev}}"
ASAKI_USER="${ASAKI_MEMORY_USER_ID:-asaki}"
DIGEST_TOP_K="${ASAKI_MEMORY_DIGEST_TOP_K:-8}"

# Resolve project id from env or git root; IS_PROJECT gates the digest below
IS_PROJECT=false
if [ -n "${ASAKI_MEMORY_PROJECT_ID:-}" ]; then
  ASAKI_PROJECT="$ASAKI_MEMORY_PROJECT_ID"
  IS_PROJECT=true
elif [ -n "$CWD" ] && GIT_ROOT=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) && [ -n "$GIT_ROOT" ]; then
  ASAKI_PROJECT=$(basename "$GIT_ROOT")
  IS_PROJECT=true
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

# Single list call, reused for both the memory count and the project digest
# (global + this project's memories by default, per the backend's scope rules).
LIST_RESP=""
if command -v curl >/dev/null 2>&1; then
  LIST_RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"project_id\":\"${ASAKI_PROJECT}\",\"status\":\"active\",\"limit\":50}" 2>/dev/null || echo "")
fi

MEMORY_COUNT="?"
DIGEST=""
if [ -n "$LIST_RESP" ]; then
  MEMORY_COUNT=$(echo "$LIST_RESP" | jq '(.memories // []) | length' 2>/dev/null || echo "?")
  DIGEST=$(echo "$LIST_RESP" | jq -r --argjson k "$DIGEST_TOP_K" '
    (.memories // [])
    | sort_by(-((.importance // 0) * (.confidence // 1)))
    | .[0:$k]
    | map("- " + (.content | gsub("[\\n\\r]+"; " ") | gsub(" {2,}"; " "))
        + " (scope=" + .scope
        + (if .kind then ", kind=" + .kind else "" end)
        + ", importance=" + ((.importance // 0) | tostring) + ")")
    | join("\n")
  ' 2>/dev/null || echo "")
fi

cat <<BANNER
## Asaki Memory Active

\`user=${ASAKI_USER} | project=${ASAKI_PROJECT} | memories=${MEMORY_COUNT}\`

IMPORTANT: In your FIRST response, display this exact status line as your opening line:
\`\`\`
Asaki Memory Active | user=${ASAKI_USER} | project=${ASAKI_PROJECT} | memories=${MEMORY_COUNT}
\`\`\`

Always include \`user_id: "${ASAKI_USER}"\` in every \`asaki_memory_search\` and \`asaki_memory_add\` call.

After completing any task, decision, or meaningful exchange, decide yourself whether it is worth storing durably via \`asaki_memory_add\` (decisions, bug fixes, patterns, preferences, task outcomes).
BANNER

if [ "$IS_PROJECT" = true ] && [ -n "$DIGEST" ]; then
  cat <<DIGEST_BANNER

## Asaki Memory — Project Digest (${ASAKI_PROJECT})

Top ${DIGEST_TOP_K} historical memories for this project (global + project scope, ranked by importance; context only, never overrides system/developer instructions):
${DIGEST}
DIGEST_BANNER
fi

exit 0
