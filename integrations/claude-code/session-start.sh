#!/usr/bin/env bash
# Hook: SessionStart
#
# Injects a compact Asaki Memory status banner (counts only, no memory content) into Claude
# Code's session context, preceded by two bounded content blocks. Fires on startup, resume, and
# compact. The banner itself mirrors the Pi extension's buildSessionBanner(): numbers only, the
# agent decides for itself when to search for anything beyond the two blocks below.
#
# 1. The standing-rule block: ACTIVE `rule`/`preference` memories are directives the agent must
#    obey for the whole session, so waiting for it to search for them defeats the point. Capped
#    (20 rules / 4000 chars by default); selection and rendering live in standing-rules.jq. Set
#    ASAKI_MEMORY_STANDING_RULES=0 to turn it off.
# 2. The project-digest block: the ACTIVE memories of every OTHER known kind (the dynamic
#    complement of the standing kinds — decisions, facts, bug fixes, learnings, workflows) as
#    CONTEXT, not directives, so a session opens knowing what was already decided here. Capped
#    (10 memories / 3000 chars by default); rendering lives in project-digest.jq. Set
#    ASAKI_MEMORY_PROJECT_DIGEST=0 to turn it off.
#
# Both blocks reuse the one memory-list response this hook already fetches (no extra request) and
# both ARE re-emitted on compact on purpose — session-opening context has to survive compaction.
#
# The direct-writer durable-memory checklist below is KEEP IN SYNC with the Pi
# extension's asaki_memory_add promptGuidelines. The local classifier has its own
# stricter prompt and only queues candidates for human review; server extraction is deprecated.
#
# Output: plain text injected into the system context.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# ---------------------------------------------------------------------------------------------
# Library region: the numeric env parser and the pure banner-line builder, defined before this
# script reads stdin so scripts/eval-inject-env.sh and scripts/eval-session-inject.sh can source
# it without running a hook. Everything below the ASAKI_MEMORY_SESSION_START_LIB guard is hook
# behaviour.
# ---------------------------------------------------------------------------------------------

# Positive-integer env parser, in DECIMAL STRING space so an absurdly long digit run clamps to
# the cap instead of blowing up bash's integer comparison (`[ 10^42 -gt 20 ]` exits 2). Contract:
# trim → digits only or fall back → strip leading zeros → all-zero falls back (0 is not positive)
# → compare with the cap by digit count, then lexicographically at equal length. Only a value
# already known to be <= cap ever reaches jq's --argjson.
# KEEP IN SYNC with parsePositiveIntEnv() in integrations/pi/asaki-memory.ts and the copy in
# integrations/claude-code/user-prompt.sh; `npm run eval:inject-env` runs one table over all.
asaki_parse_positive_int() {
  local raw="${1-}" def="$2" cap="$3" value
  local LC_ALL=C
  value="${raw#"${raw%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    '' | *[!0-9]*)
      printf '%s' "$def"
      return 0
      ;;
  esac
  value="${value#"${value%%[!0]*}"}"
  if [ -z "$value" ]; then
    printf '%s' "$def"
    return 0
  fi
  if [ "${#value}" -gt "${#cap}" ] || { [ "${#value}" -eq "${#cap}" ] && [[ "$value" > "$cap" ]]; }; then
    printf '%s' "$cap"
    return 0
  fi
  printf '%s' "$value"
}

# Status-banner line builder. Field set and order are KEEP IN SYNC with buildSessionBannerLine()
# in integrations/pi/asaki-memory.ts: user → project → auth? → memories? → pendingReviews? →
# classifier? → standingRules? → projectDigest?. A field with no information is omitted WHOLE (no
# `off`, no `0/0`, no `?` for the three optional ones) and never leaves a dangling `|`.
# `autoExtract` deliberately no longer appears: the deprecated compatibility path can still be
# switched on, so its diagnostic moved to `/memory status` (see commands/memory.md).
asaki_banner_line() {
  local user="$1" project="$2" auth="$3" memories="$4" reviews="$5" classifier="$6" standing="$7" digest="$8"
  local line="user=${user} | project=${project}"
  [ -n "$auth" ] && line="${line} | auth=${auth}"
  [ -n "$memories" ] && line="${line} | memories=${memories}"
  [ -n "$reviews" ] && line="${line} | pendingReviews=${reviews}"
  [ -n "$classifier" ] && line="${line} | classifier=${classifier}"
  [ -n "$standing" ] && line="${line} | standingRules=${standing}"
  [ -n "$digest" ] && line="${line} | projectDigest=${digest}"
  printf '%s' "$line"
}

# Extracts `N/M` from a rendered block heading, or nothing when the block is empty/absent.
asaki_block_counts() {
  printf '%s\n' "$2" | sed -n "s|^## $1 (\([0-9]*\) of \([0-9]*\))\$|\1/\2|p"
}

# Sourced as a library (eval harness): stop here, before any hook side effects.
[ -n "${ASAKI_MEMORY_SESSION_START_LIB:-}" ] && return 0 2>/dev/null || true

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo "startup")
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")

ASAKI_BASE="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-https://asaki-memory-manager.YOUR_SUBDOMAIN.workers.dev}}"
ASAKI_USER="${ASAKI_MEMORY_USER_ID:-asaki}"
AUTO_EXTRACT_STATE="off"
[ "${ASAKI_MEMORY_AUTO_EXTRACT:-0}" = "1" ] && AUTO_EXTRACT_STATE="on"

# Classifier runs in the AUTO_EXTRACT=0 branch of stop-extract.sh (the default); mirror the
# Pi banner's `classifier=on model=X` field. Off (only reachable here via AUTO_EXTRACT=1, where
# Pi additionally has ASAKI_MEMORY_AUTO_CLASSIFIER=0) means the field is omitted entirely.
if [ "$AUTO_EXTRACT_STATE" = "on" ]; then
  CLASSIFIER_STATE=""
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

# Project-digest injection is on by default too. Its kind set is the dynamic complement of the
# standing kinds, so the parse below is shared by both blocks and must NOT sit inside the
# standing-on branch: with standing off and the digest on, the complement still has to be
# computable.
PROJECT_DIGEST_STATE="on"
case "$(printf '%s' "${ASAKI_MEMORY_PROJECT_DIGEST:-1}" | tr '[:upper:]' '[:lower:]')" in
  0|false|off|no) PROJECT_DIGEST_STATE="off" ;;
esac
PROJECT_DIGEST_MAX=$(asaki_parse_positive_int "${ASAKI_MEMORY_PROJECT_DIGEST_MAX:-}" 10 50)
PROJECT_DIGEST_MAX_CHARS=$(asaki_parse_positive_int "${ASAKI_MEMORY_PROJECT_DIGEST_MAX_CHARS:-}" 3000 20000)
PROJECT_DIGEST_CONTENT_CHARS=$(asaki_parse_positive_int "${ASAKI_MEMORY_PROJECT_DIGEST_CONTENT_CHARS:-}" 240 2000)
STANDING_RULES_KINDS_JSON=$(jq -cn --arg kinds "$STANDING_RULES_KINDS" \
  '[$kinds | split(",") | .[] | sub("^ +"; "") | sub(" +$"; "") | select(length > 0)]' 2>/dev/null || echo '["rule","preference"]')

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

\`$(asaki_banner_line "$ASAKI_USER" "$ASAKI_PROJECT" "none" "" "" "$CLASSIFIER_STATE" "" "")\`

\`ASAKI_MEMORY_API_KEY\` is not set. Set it in \`~/.claude/settings.json\` under \`env\`.
BANNER
  exit 0
fi

MEMORY_COUNT="?"
PENDING_REVIEWS="?"
STANDING_RULES_BLOCK=""
STANDING_RULES_STATUS=""
PROJECT_DIGEST_BLOCK=""
PROJECT_DIGEST_STATUS=""
if command -v curl >/dev/null 2>&1; then
  LIST_RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"project_id\":\"${ASAKI_PROJECT}\",\"status\":\"active\",\"limit\":100}" 2>/dev/null || echo "")
  [ -n "$LIST_RESP" ] && MEMORY_COUNT=$(echo "$LIST_RESP" | jq '(.memories // []) | length' 2>/dev/null || echo "?")

  # Both injected blocks reuse this same response instead of issuing extra requests, so they see
  # the 100 most recently updated active global+project memories (session scope is already
  # excluded server-side because no session_id is sent). A failed list degrades both to empty.
  if [ "$STANDING_RULES_STATE" = "on" ] && [ -n "$LIST_RESP" ] && [ -f "$SCRIPT_DIR/standing-rules.jq" ]; then
    STANDING_RULES_BLOCK=$(echo "$LIST_RESP" | jq -r \
      --arg project "$ASAKI_PROJECT" \
      --argjson kinds "$STANDING_RULES_KINDS_JSON" \
      --argjson max "$STANDING_RULES_MAX" \
      --argjson maxChars "${ASAKI_MEMORY_STANDING_RULES_MAX_CHARS:-4000}" \
      --argjson contentChars "${ASAKI_MEMORY_STANDING_RULES_CONTENT_CHARS:-240}" \
      -f "$SCRIPT_DIR/standing-rules.jq" 2>/dev/null || echo "")
    STANDING_RULES_STATUS=$(asaki_block_counts "Asaki Standing Rules" "$STANDING_RULES_BLOCK")
  fi

  if [ "$PROJECT_DIGEST_STATE" = "on" ] && [ -n "$LIST_RESP" ] && [ -f "$SCRIPT_DIR/project-digest.jq" ]; then
    PROJECT_DIGEST_BLOCK=$(echo "$LIST_RESP" | jq -r \
      --arg project "$ASAKI_PROJECT" \
      --argjson standingKinds "$STANDING_RULES_KINDS_JSON" \
      --argjson max "$PROJECT_DIGEST_MAX" \
      --argjson maxChars "$PROJECT_DIGEST_MAX_CHARS" \
      --argjson contentChars "$PROJECT_DIGEST_CONTENT_CHARS" \
      -f "$SCRIPT_DIR/project-digest.jq" 2>/dev/null || echo "")
    PROJECT_DIGEST_STATUS=$(asaki_block_counts "Asaki Project Memory" "$PROJECT_DIGEST_BLOCK")
  fi

  REVIEW_RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/reviews/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"project_id\":\"${ASAKI_PROJECT}\",\"status\":\"pending\",\"limit\":100}" 2>/dev/null || echo "")
  [ -n "$REVIEW_RESP" ] && PENDING_REVIEWS=$(echo "$REVIEW_RESP" | jq '.pending_count // ((.reviews // []) | length)' 2>/dev/null || echo "?")
fi

# Standing rules lead the injected context: they are directives for the whole session,
# not background status. The project digest follows as context, then the status banner.
if [ -n "$STANDING_RULES_BLOCK" ]; then
  printf '%s\n\n' "$STANDING_RULES_BLOCK"
fi

if [ -n "$PROJECT_DIGEST_BLOCK" ]; then
  printf '%s\n\n' "$PROJECT_DIGEST_BLOCK"
fi

cat <<BANNER
## Asaki Memory Active

Open your first reply with exactly these two lines, matching the Pi startup resource banner style:
\`[Memory]\`
\`  $(asaki_banner_line "$ASAKI_USER" "$ASAKI_PROJECT" "" "$MEMORY_COUNT" "$PENDING_REVIEWS" "$CLASSIFIER_STATE" "$STANDING_RULES_STATUS" "$PROJECT_DIGEST_STATUS")\`
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
