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
# The one exception is the standing-rule block: ACTIVE `rule`/`preference` memories are
# directives the agent must obey for the whole session, so waiting for it to search for
# them defeats the point. It is capped (20 rules / 4000 chars by default) and IS re-emitted
# on compact on purpose — standing rules have to survive compaction. Selection and
# rendering live in standing-rules.jq; set ASAKI_MEMORY_STANDING_RULES=0 to turn it off.
#
# The direct-writer durable-memory checklist below is KEEP IN SYNC with the Pi
# extension's asaki_memory_add promptGuidelines. The local classifier has its own
# stricter prompt and only queues candidates for human review; server extraction is deprecated.
#
# Output: plain text injected into the system context.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo "startup")
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")

ASAKI_BASE="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-https://asaki-memory-manager.YOUR_SUBDOMAIN.workers.dev}}"
ASAKI_USER="${ASAKI_MEMORY_USER_ID:-asaki}"
AUTO_EXTRACT_STATE="off"
[ "${ASAKI_MEMORY_AUTO_EXTRACT:-0}" = "1" ] && AUTO_EXTRACT_STATE="on"

# Classifier runs in the AUTO_EXTRACT=0 branch of stop-extract.sh (the default); mirror the
# Pi banner's `classifier=on model=X` / `classifier=off` field.
if [ "$AUTO_EXTRACT_STATE" = "on" ]; then
  CLASSIFIER_STATE="off"
else
  CLASSIFIER_STATE="on model=${ASAKI_MEMORY_CLASSIFIER_MODEL:-claude-haiku-4-5-20251001}"
fi

# Standing-rule injection is on by default; mirror the Pi extension's envFlagEnabled().
STANDING_RULES_STATE="on"
case "$(printf '%s' "${ASAKI_MEMORY_STANDING_RULES:-1}" | tr '[:upper:]' '[:lower:]')" in
  0|false|off|no) STANDING_RULES_STATE="off" ;;
esac
STANDING_RULES_MAX="${ASAKI_MEMORY_STANDING_RULES_MAX:-20}"
STANDING_RULES_KINDS="${ASAKI_MEMORY_STANDING_RULES_KINDS:-rule,preference}"

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
STANDING_RULES_BLOCK=""
STANDING_RULES_STATUS="$STANDING_RULES_STATE"
if command -v curl >/dev/null 2>&1; then
  LIST_RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"project_id\":\"${ASAKI_PROJECT}\",\"status\":\"active\",\"limit\":100}" 2>/dev/null || echo "")
  [ -n "$LIST_RESP" ] && MEMORY_COUNT=$(echo "$LIST_RESP" | jq '(.memories // []) | length' 2>/dev/null || echo "?")

  # The standing-rule block reuses this same response instead of issuing extra requests, so
  # it sees the 100 most recently updated active global+project memories (session scope is
  # already excluded server-side because no session_id is sent).
  if [ "$STANDING_RULES_STATE" = "on" ] && [ -n "$LIST_RESP" ] && [ -f "$SCRIPT_DIR/standing-rules.jq" ]; then
    STANDING_RULES_KINDS_JSON=$(jq -cn --arg kinds "$STANDING_RULES_KINDS" \
      '[$kinds | split(",") | .[] | sub("^ +"; "") | sub(" +$"; "") | select(length > 0)]' 2>/dev/null || echo '["rule","preference"]')
    STANDING_RULES_BLOCK=$(echo "$LIST_RESP" | jq -r \
      --arg project "$ASAKI_PROJECT" \
      --argjson kinds "$STANDING_RULES_KINDS_JSON" \
      --argjson max "$STANDING_RULES_MAX" \
      --argjson maxChars "${ASAKI_MEMORY_STANDING_RULES_MAX_CHARS:-4000}" \
      --argjson contentChars "${ASAKI_MEMORY_STANDING_RULES_CONTENT_CHARS:-240}" \
      -f "$SCRIPT_DIR/standing-rules.jq" 2>/dev/null || echo "")
    STANDING_RULES_COUNTS=$(printf '%s\n' "$STANDING_RULES_BLOCK" | sed -n 's|^## Asaki Standing Rules (\([0-9]*\) of \([0-9]*\))$|\1/\2|p')
    [ -n "$STANDING_RULES_COUNTS" ] && STANDING_RULES_STATUS="$STANDING_RULES_COUNTS"
  fi

  REVIEW_RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/reviews/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"project_id\":\"${ASAKI_PROJECT}\",\"status\":\"pending\",\"limit\":100}" 2>/dev/null || echo "")
  [ -n "$REVIEW_RESP" ] && PENDING_REVIEWS=$(echo "$REVIEW_RESP" | jq '(.reviews // []) | length' 2>/dev/null || echo "?")
fi

# Standing rules lead the injected context: they are directives for the whole session,
# not background status.
if [ -n "$STANDING_RULES_BLOCK" ]; then
  printf '%s\n\n' "$STANDING_RULES_BLOCK"
fi

cat <<BANNER
## Asaki Memory Active

Open your first reply with exactly these two lines, matching the Pi startup resource banner style:
\`[Memory]\`
\`  user=${ASAKI_USER} | project=${ASAKI_PROJECT} | memories=${MEMORY_COUNT} | pendingReviews=${PENDING_REVIEWS} | autoExtract=${AUTO_EXTRACT_STATE} | classifier=${CLASSIFIER_STATE} | standingRules=${STANDING_RULES_STATUS}\`
Always include \`user_id: "${ASAKI_USER}"\` in every \`asaki_memory_search\` and \`asaki_memory_add\` call.

You are the primary reviewed writer for durable memory. Cloud/server extraction is deprecated; the local background classifier may queue candidates for human review but never auto-activates them. Record deliberately, not more. Before calling \`asaki_memory_add\`, check ALL of:
1. Durable: a stated preference, a made decision, a completed bug fix/task outcome, an established rule/convention, or an explicit forget/retract request — not a question, chit-chat, a one-off command, or something with no future value.
2. Actually happened: a completed fact, not a proposed plan, an open "should we do X? I'd recommend X" deliberation, or a present-tense explanation of how something works (a past-tense "we changed X, verified it works" DOES qualify).
3. Not noise: skip illustrative/hypothetical examples and quoted code/CLI output; when a problem and its fix both appear in the same exchange, record only the resolved outcome, not the problem report too.
4. Not a duplicate or stale-making: \`asaki_memory_search\` first — update/skip a near-duplicate, and separately, if what you just did makes an OLDER, differently-worded memory factually wrong (e.g. you just disabled a mechanism an old memory still describes as active), update that old memory too — don't just leave it to rot next to the new one.
5. Right scope: \`global\` only if useful in ANY unrelated project (cross-project preferences, communication style, secret-handling rules). Everything else, including project-specific tooling/bugs AND product/business decisions (a metric definition, a customer-facing feature) — even ones that feel foundational — is \`project\`. Importance and scope are independent; a high-stakes decision is not automatically global. When genuinely ambiguous, default to \`project\` — rescoping later is cheap, a wrongly-global memory pollutes every future project's context immediately.
6. Self-contained: no pronoun or bare reference (this/that/该/这个/主公) whose target isn't named in the same sentence — a reader with zero conversation context must be able to understand it standing alone.

If nothing in the exchange clears this bar, call nothing — silence is a correct outcome, not a shortfall. Keep each memory concise: preference/rule should be roughly 40-160 chars; decision/workflow/bug_fix/task_learning should be 1-2 sentences and at most roughly 200-300 chars. Summarize the durable takeaway only — never paste multi-paragraph implementation logs, changelogs, or step-by-step narratives.
BANNER

exit 0
