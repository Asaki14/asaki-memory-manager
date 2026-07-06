#!/usr/bin/env bash
# Hook: Stop
#
# After each assistant turn, sends the plain-text user/assistant lines
# appended since the last processed offset to /v1/memories/extract for
# server-side LLM-based background memory extraction. Tool calls, tool
# results, and thinking blocks are never sent — only plain text turns.
#
# NOTE: this deliberately sends conversation text off-machine to the Worker.
# Fire-and-forget: the extraction request runs in the background so it
# never blocks the Stop event.
set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)

[ -z "${ASAKI_MEMORY_API_KEY:-}" ] && exit 0
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi
[ -z "$SESSION_ID" ] && SESSION_ID="unknown"

ASAKI_BASE="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-}}"
[ -z "$ASAKI_BASE" ] && exit 0
ASAKI_USER="${ASAKI_MEMORY_USER_ID:-asaki}"

if [ -n "${ASAKI_MEMORY_PROJECT_ID:-}" ]; then
  ASAKI_PROJECT="$ASAKI_MEMORY_PROJECT_ID"
elif [ -n "$CWD" ] && GIT_ROOT=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) && [ -n "$GIT_ROOT" ]; then
  ASAKI_PROJECT=$(basename "$GIT_ROOT")
else
  ASAKI_PROJECT=$(basename "${CWD:-unknown}")
fi

STATE_DIR="${TMPDIR:-/tmp}/asaki-memory-stop-extract"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/${SESSION_ID}.offset"
LAST=0
[ -f "$STATE_FILE" ] && LAST=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
TOTAL=$(wc -l <"$TRANSCRIPT" | tr -d ' ')
[ -z "$TOTAL" ] && TOTAL=0
[ "$TOTAL" -le "$LAST" ] && exit 0

TEXT=$(sed -n "$((LAST + 1)),${TOTAL}p" "$TRANSCRIPT" | node -e '
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const out = [];
  for (const line of s.split("\n")) {
    if (!line.trim()) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (j.type === "user" && j.message && typeof j.message.content === "string") {
      out.push("User: " + j.message.content.trim());
    } else if (j.type === "assistant" && j.message && Array.isArray(j.message.content)) {
      const text = j.message.content.filter((c) => c.type === "text").map((c) => c.text).join(" ").trim();
      if (text) out.push("Assistant: " + text);
    }
  }
  process.stdout.write(out.join("\n\n"));
});
')

echo "$TOTAL" >"$STATE_FILE"

# Skip trivial/empty slices — not worth an LLM extraction call.
[ "${#TEXT}" -lt 60 ] && exit 0
TEXT="${TEXT:0:20000}"

BODY=$(jq -cn --arg text "$TEXT" --arg user "$ASAKI_USER" --arg project "$ASAKI_PROJECT" \
  '{text: $text, user_id: $user, scope: "project", project_id: $project, source: "claude-code:auto-extract"}')

LOG_FILE="$STATE_DIR/${SESSION_ID}.log"
(
  RESP=$(curl -sf --max-time 20 -X POST "${ASAKI_BASE}/v1/memories/extract" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$BODY" 2>>"$LOG_FILE")
  echo "$(date -u +%FT%TZ) ${RESP}" >>"$LOG_FILE"
) >/dev/null 2>&1 &
disown

exit 0
