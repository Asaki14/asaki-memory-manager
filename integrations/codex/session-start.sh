#!/usr/bin/env bash
# Hook: SessionStart (Codex)
#
# Injects Asaki Memory status banner and instructions into Codex's session
# context. Fires on startup, resume, and compact.
set -uo pipefail

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo "startup")
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")

ASAKI_BASE="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-https://asaki-memory-manager.YOUR_SUBDOMAIN.workers.dev}}"
ASAKI_USER="${ASAKI_MEMORY_USER_ID:-asaki}"

if [ -n "${ASAKI_MEMORY_PROJECT_ID:-}" ]; then
  ASAKI_PROJECT="$ASAKI_MEMORY_PROJECT_ID"
elif [ -n "$CWD" ]; then
  ASAKI_PROJECT=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null | xargs basename 2>/dev/null || basename "$CWD")
else
  ASAKI_PROJECT="unknown"
fi

if [ -z "${ASAKI_MEMORY_API_KEY:-}" ]; then
  cat <<BANNER
## Asaki Memory — Setup Required

\`user=${ASAKI_USER} | project=${ASAKI_PROJECT} | auth=none\`

\`ASAKI_MEMORY_API_KEY\` is not set. Add it to \`[mcp_servers.asaki-memory.env]\` in \`~/.codex/config.toml\`,
or create \`~/.codex/asaki-memory.json\` with \`{ "apiKey": "your-key" }\`.
BANNER
  exit 0
fi

MEMORY_COUNT="?"
if command -v curl >/dev/null 2>&1; then
  _RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"project_id\":\"${ASAKI_PROJECT}\",\"limit\":1}" 2>/dev/null || echo "")
  if [ -n "$_RESP" ]; then
    MEMORY_COUNT=$(echo "$_RESP" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('total', len(d.get('memories',[]))))" \
      2>/dev/null || echo "?")
  fi
fi

cat <<BANNER
## Asaki Memory Active

\`user=${ASAKI_USER} | project=${ASAKI_PROJECT} | memories=${MEMORY_COUNT}\`

IMPORTANT: In your FIRST response, display this exact status line as your opening line:
\`\`\`
Asaki Memory Active | user=${ASAKI_USER} | project=${ASAKI_PROJECT} | memories=${MEMORY_COUNT}
\`\`\`

Always include \`user_id: "${ASAKI_USER}"\` in every \`asaki_memory_search\` and \`asaki_memory_add\` call.

After completing any task, decision, or meaningful exchange, proactively store learnings via \`asaki_memory_add\`. Do NOT wait — store incrementally. Focus on: decisions made, bugs fixed, patterns discovered, user preferences, task outcomes. Aim for 1–3 memories per substantial interaction. Keep each memory to 1-3 sentences summarizing the durable takeaway only — never paste multi-paragraph implementation logs, changelogs, or step-by-step narratives.
BANNER

if [ "$SOURCE" = "startup" ]; then
  if [ "$MEMORY_COUNT" != "0" ] && [ "$MEMORY_COUNT" != "?" ]; then
    echo "Search Asaki memory for recent decisions and task learnings before responding. Run 2 parallel \`asaki_memory_search\` calls: one for decision kind, one for task_learning kind."
  fi
elif [ "$SOURCE" = "resume" ] || [ "$SOURCE" = "compact" ]; then
  echo "Session ${SOURCE}. Search Asaki memory for recent session state and decisions to recover context."
fi

exit 0
