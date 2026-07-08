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
[ "${ASAKI_MEMORY_AUTO_EXTRACT:-0}" != "1" ] && exit 0
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
LOG_FILE="$STATE_DIR/${SESSION_ID}.log"
REPORTED_FILE="$STATE_DIR/${SESSION_ID}.reported"

# The extraction curl runs fire-and-forget in the background (see below), so its result
# isn't known when this invocation exits. Instead, each Stop event first checks whether the
# *previous* invocation's response landed in LOG_FILE since it was last reported, and surfaces
# it as a systemMessage — one turn of delay, but visible in the TUI without blocking Stop.
report_and_exit() {
  MSG=""
  if [ -f "$LOG_FILE" ]; then
    LAST_REPORTED=0
    [ -f "$REPORTED_FILE" ] && LAST_REPORTED=$(cat "$REPORTED_FILE" 2>/dev/null || echo 0)
    LOG_LINES=$(wc -l <"$LOG_FILE" | tr -d ' ')
    if [ "$LOG_LINES" -gt "$LAST_REPORTED" ]; then
      RESP_JSON="$(tail -n 1 "$LOG_FILE" | sed -E 's/^[^ ]+ //')"
      # Only advance REPORTED_FILE once RESP_JSON parses as valid JSON — a curl failure or a
      # partial write from a still-in-flight background job must NOT be marked reported, or
      # this result is silently skipped forever (the next Stop event only re-checks tail -1).
      if echo "$RESP_JSON" | jq -e . >/dev/null 2>&1; then
        COUNTS=$(echo "$RESP_JSON" | jq -r '
          def verb:
            if . == "add" then "added"
            elif . == "merge" then "merged"
            elif . == "ignore" then "ignored"
            elif . == "update" then "updated"
            elif . == "delete" then "deleted"
            else . end;
          (.decisions // []) as $d
          | (.reviews // []) as $r
          | ($d | length) as $dn
          | ($r | length) as $rn
          | if ($dn + $rn) == 0 then empty
            else ($d | group_by(.action) | map("\(length) " + (.[0].action | verb))) as $breakdown
            | ($breakdown + (if $rn > 0 then ["\($rn) queued for review"] else [] end) | join(", ")) as $line
            | "\($dn + $rn) candidates → \($line)"
            end
        ' 2>/dev/null)
        [ -n "$COUNTS" ] && MSG="🧠 Asaki auto-extract (prev turn): ${COUNTS}"
        echo "$LOG_LINES" >"$REPORTED_FILE"
      fi
    fi
  fi
  [ -n "$MSG" ] && jq -cn --arg msg "$MSG" '{systemMessage: $msg}'
  exit 0
}

# `mkdir` is an atomic, portable lock (flock isn't available on macOS). If another invocation
# for this session is already mid-flight, skip this one — the offset hasn't advanced, so the
# next Stop event will pick up the full accumulated delta anyway.
LOCK_DIR="$STATE_DIR/${SESSION_ID}.lock"
mkdir "$LOCK_DIR" 2>/dev/null || report_and_exit
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# Throttle: skip firing another extraction call within the min interval since the last one
# actually fired. Deliberately does NOT advance STATE_FILE below — the skipped delta stays
# queued and gets folded into the next Stop event's (larger) increment instead of being lost.
LAST_EXTRACT_FILE="$STATE_DIR/${SESSION_ID}.last_extract"
MIN_INTERVAL="${ASAKI_MEMORY_EXTRACT_MIN_INTERVAL_SECONDS:-300}"
NOW_EPOCH=$(date +%s)
LAST_EXTRACT=0
[ -f "$LAST_EXTRACT_FILE" ] && LAST_EXTRACT=$(cat "$LAST_EXTRACT_FILE" 2>/dev/null || echo 0)
[ $((NOW_EPOCH - LAST_EXTRACT)) -lt "$MIN_INTERVAL" ] && report_and_exit

LAST=0
[ -f "$STATE_FILE" ] && LAST=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
TOTAL=$(wc -l <"$TRANSCRIPT" | tr -d ' ')
[ -z "$TOTAL" ] && TOTAL=0
[ "$TOTAL" -le "$LAST" ] && report_and_exit

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

# Sensitive-content gate: never send private keys, bearer tokens, provider API keys, AWS access
# keys, or key=value secret assignments off-machine. Consume the offset here — a slice containing
# a secret must never be retried, since leaving it queued would just resend the same secret in
# every future (larger) delta until it scrolls out of the transcript.
# KEEP IN SYNC with SENSITIVE_RE_LIST in integrations/pi/asaki-memory.ts and
# scripts/shadow-run-extraction.ts.
SENSITIVE_PATTERN='-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b|\b(sk|sk-ant|sk-proj|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_=-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\b(api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*"?[^"'"'"' ]{8,}|set\s+-gx\s+[[:alnum:]_]*(KEY|TOKEN|SECRET|PASSWORD)[[:alnum:]_]*\s+[^$[:space:]][^[:space:]]{8,}'
if echo "$TEXT" | grep -qiE "$SENSITIVE_PATTERN"; then
  echo "$TOTAL" >"$STATE_FILE"
  report_and_exit
fi

# Content gate: only proceed if the delta contains at least one durable-memory signal marker
# (preference/rule/decision/bug_fix/task_learning/workflow language), regardless of length —
# a short, decisive one-liner ("以后都用pnpm") is exactly the kind of turn worth catching, so
# there is no separate minimum-length cutoff.
# False negatives are expected and accepted; false positives just fall through to today's behavior.
# KEEP IN SYNC with EXTRACT_SIGNAL_RE in integrations/pi/asaki-memory.ts.
EXTRACT_SIGNAL_PATTERN='以后都|以后就|不要再|别再|记住|记得|规则是|统一用|统一使用|根因是|已验证|已修复|已确认|踩坑|决定用|决定是|改用|换成|约定是|复盘|经验是|remember|always|never|from now on|going forward|decided to|decision is|decision was|root cause is|root cause was|already fixed|now fixed|now verified|already verified|learned that|instead of|switch to|switched to|switching to|convention is|the rule is'
if ! echo "$TEXT" | grep -qiE "$EXTRACT_SIGNAL_PATTERN"; then
  # Deliberately does NOT advance STATE_FILE — this text might still be durable, just not
  # phrased in a way the gate recognizes yet. Leave the offset where
  # it is so this slice folds into the next Stop event's (larger) delta instead of being silently
  # and permanently lost, mirroring the throttle's carry-forward behavior earlier in this script.
  report_and_exit
fi

echo "$TOTAL" >"$STATE_FILE"
TEXT="${TEXT:0:20000}"

# No "scope" here on purpose — let the server infer global vs project per candidate.
# project_id is still sent as a hint for whichever candidates resolve to project scope.
BODY=$(jq -cn --arg text "$TEXT" --arg user "$ASAKI_USER" --arg project "$ASAKI_PROJECT" \
  '{text: $text, user_id: $user, project_id: $project, source: "claude-code:auto-extract"}')

echo "$NOW_EPOCH" >"$LAST_EXTRACT_FILE"

(
  RESP=$(curl -sf --max-time 20 -X POST "${ASAKI_BASE}/v1/memories/extract" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "$BODY" 2>>"$LOG_FILE")
  echo "$(date -u +%FT%TZ) ${RESP}" >>"$LOG_FILE"
) >/dev/null 2>&1 &
disown

report_and_exit
