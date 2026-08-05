#!/usr/bin/env bash
# Hook: Stop
#
# When ASAKI_MEMORY_AUTO_EXTRACT=1, sends the plain-text user/assistant lines appended since
# the last processed offset to /v1/memories/extract for server-side LLM-based background memory
# extraction. Tool calls, tool results, and thinking blocks are never sent — only plain text
# turns. Fire-and-forget: the extraction request runs in the background so it never blocks the
# Stop event.
#
# NOTE: this deliberately sends conversation text off-machine to the Worker.
#
# When ASAKI_MEMORY_AUTO_EXTRACT is unset/0 (the default), cloud auto-extract is permanently
# off. Instead of doing nothing, this hook runs a local classifier (`claude -p --safe-mode`, no
# tools) in the background to judge the delta against the 6-criteria checklist and, if it
# qualifies, distill it into one ready-to-write sentence (text/type/scope). If it qualifies, the
# same background job then executes the write itself via plain HTTP — POST
# /v1/memories/candidates, the identical server endpoint the asaki_memory_add MCP tool calls
# under the hood (integrations/mcp/asaki-memory.ts), so it gets the same server-side dedup/merge
# pipeline. No Claude/MCP/claude-p in that second step at all, so there's nothing for a model to
# fabricate — the result is whatever the server actually decided. The next Stop event just
# reports the outcome as a one-line systemMessage; the main conversation agent is never forced
# into an extra turn for this path.
#
# Two earlier designs were tried and reverted for this branch:
# 1. Giving the classifier direct asaki_memory_add access via a scoped MCP tool (no --safe-mode)
#    so it could write asynchronously itself. Reverted after live testing showed MCP tool
#    registration inside a single-shot `claude -p` call is not reliably ready by the time the
#    model decides whether to call it — in multiple runs the model reported "no such tool," and
#    in one run it fabricated a plausible-looking `{"action":"added",...}` result for a write
#    that never actually reached the server. Silent false-success reports are unacceptable.
# 2. Forcing a `decision:"block"` continuation so the main agent executes asaki_memory_add with
#    the classifier's pre-distilled fields (no re-review). This worked correctly but still cost
#    one forced extra agent turn per qualifying candidate, and Claude Code's CLI renders any
#    decision:block as "Stop hook error/feedback" regardless of content — confusing even for a
#    non-error nudge, with no documented way to change that rendering.
# The current plain-HTTP-write design avoids both problems: no MCP involved (nothing to register
# late), no model self-report to trust (a real HTTP response), and no forced continuation.
set -uo pipefail

# This script's state dir stores generated memory text and classifier judgments — private
# content on a possibly multi-user host. Force all files/dirs this script creates to be
# owner-only, overriding whatever the default umask (commonly 0022/0002) would otherwise allow.
umask 077

# ---------------------------------------------------------------------------------------------
# Library region: patterns and the two pure decision functions, defined before this script reads
# stdin so scripts/eval-throttle-state.sh can source it and exercise them without running a hook.
# Everything below the ASAKI_MEMORY_STOP_EXTRACT_LIB guard is hook behaviour.
# ---------------------------------------------------------------------------------------------

# Sensitive-content gate: never send private keys, bearer tokens, provider API keys, AWS access
# keys, or key=value secret assignments off-machine — applies to both the cloud extraction call
# and the local classifier call (the classifier is still a real model call over the network).
# A slice containing a secret must never be retried, since leaving it queued would just resend
# the same secret in every future (larger) delta until it scrolls out of the transcript.
# KEEP IN SYNC with the canonical server list in src/utils/sensitiveContent.ts, SENSITIVE_RE_LIST
# in integrations/pi/asaki-memory.ts, and SENSITIVE_PATTERNS in build-delta.mjs. Both holes the
# canonical list closed are carried here: the credential keyword may carry an identifier
# prefix/suffix (so DATABASE_PASSWORD=… is caught, where the old `\b` form was not), and any fish
# `set -x`/`-gx`/`-Ux` flag spelling matches, not only the literal `set -gx`.
SENSITIVE_PATTERN='-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b|\bsk-[A-Za-z0-9-]{10,}\b|\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|://[^/[:space:]:]+:[^/[:space:]@]{6,}@|(^|[^[:alnum:]])[[:alnum:]_-]{0,64}(api[_-]?key|token|secret|password|passwd|authorization)([_-][[:alnum:]_-]{0,64})?\s*[:=]\s*"?[^"'"'"' ]{8,}|set(\s+--?[[:alpha:]][[:alnum:]-]*)+\s+[[:alnum:]_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD)[[:alnum:]_]*\s+[^$[:space:]][^[:space:]]{8,}'

# Correction pre-gate (plan §4.1). Used for exactly two things: the throttle override (§4.5) and
# the `correction_suspected` prompt hint. It is deliberately NOT a pre-filter on the classifier
# call — the default path still asks the model about every delta.
# KEEP IN SYNC with CORRECTION_SIGNAL_RE in integrations/pi/asaki-memory.ts.
CORRECTION_SIGNAL_PATTERN='不对|不是这样|错了|这不行|不用改了|别改|别再|改回|回到|还是原来的|还是之前|撤销|去掉|删掉|换成|直接用|就行|应该是|说过了|都说了|第几次|又.{0,6}了吗|对了|这样就行|可以了|就这样|何必|没必要|多余|想复杂了|that.{0,3}s wrong|that.{0,3}s not right|revert|undo that|put it back|drop that|use .{1,24} instead|i already said|yes that.{0,3}s it|overkill|why bother'

# Reads a flag the way AUTO_EXTRACT is read (`0`/`false`/`off`/`no`/empty → off).
is_flag_enabled() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    ""|0|false|off|no) return 1 ;;
    *) return 0 ;;
  esac
}

# Throttle state machine (plan §4.5). The window anchor and the "a call happened" stamp are
# deliberately different files: an override must NOT restart the window, or every correction-
# carrying Stop event would replenish its own override and the ceiling would not hold.
#
#   W = $WINDOW_START_FILE  written only by a normal fire
#   O = $OVERRIDE_USED_FILE written only by an override fire (holds the W it was charged against)
#   $LAST_EXTRACT_FILE      written by every fire; read only as the migration fallback for W
#
# Args: NOW INTERVAL SIGNAL(1|0). Echoes normal|override|skip and performs the state writes.
# Ceiling: at most 2 calls per fixed window [W, W+I) — one T1 and one T2.
throttle_decision() {
  local now="$1" interval="$2" signal="${3:-0}"
  local window=0 override_used=-1

  if [ -f "$WINDOW_START_FILE" ]; then
    window=$(cat "$WINDOW_START_FILE" 2>/dev/null || echo 0)
  elif [ -f "$LAST_EXTRACT_FILE" ]; then
    # First run after upgrading: fall back to the pre-existing stamp so the upgrade does not
    # hand out a free extra call.
    window=$(cat "$LAST_EXTRACT_FILE" 2>/dev/null || echo 0)
  fi
  case "$window" in ''|*[!0-9]*) window=0 ;; esac
  if [ -f "$OVERRIDE_USED_FILE" ]; then
    override_used=$(cat "$OVERRIDE_USED_FILE" 2>/dev/null || echo -1)
  fi
  case "$override_used" in ''|-1) override_used=-1 ;; *[!0-9]*) override_used=-1 ;; esac

  # T0: clock moved backwards. T1: the window expired.
  if [ "$window" -gt "$now" ] || [ $((now - window)) -ge "$interval" ]; then
    echo "$now" >"$WINDOW_START_FILE"
    echo "$now" >"$LAST_EXTRACT_FILE"
    echo "normal"
    return 0
  fi

  # T2: a correction signal, and this window's single override is still unspent. W is NOT moved.
  if [ "$signal" = "1" ] && [ "$override_used" != "$window" ]; then
    echo "$window" >"$OVERRIDE_USED_FILE"
    echo "$now" >"$LAST_EXTRACT_FILE"
    echo "override"
    return 0
  fi

  # T3.
  echo "skip"
}

# Offset consumption by failure class (plan §9.3). `curl -sf` used to turn every failure into the
# same empty body, so a deterministic 400 was retried forever while a 429 and a permanently wrong
# key were indistinguishable from it. Echoes advance|hold|giveup.
#
#   advance — this exact body will never be accepted (or was): consume the delta.
#   hold    — repairable/retryable: leave the offset so the delta folds into the next one.
#   giveup  — held too many times already: consume the delta loudly (the caller logs the code).
#
# Args: HTTP_CODE OFFSET. Uses $RETRY_FILE ("<offset> <count>") and $MAX_DELTA_RETRIES.
outcome_for_status() {
  local code="$1" offset="$2"
  case "$code" in
    2*)
      rm -f "$RETRY_FILE" 2>/dev/null
      echo "advance"
      return 0
      ;;
    400|413|414|422)
      # Deterministic body rejection (validation, sensitive-content reject, too large).
      rm -f "$RETRY_FILE" 2>/dev/null
      echo "advance"
      return 0
      ;;
  esac

  # Everything else — 401/403 (repairable auth/config), 404/405 (endpoint/config), 408/425/429,
  # any 5xx, and `000` for a network error/timeout — holds the offset under a bounded budget.
  local retry_offset="" retry_count=0
  if [ -f "$RETRY_FILE" ]; then
    read -r retry_offset retry_count <"$RETRY_FILE" 2>/dev/null
  fi
  case "${retry_count:-0}" in ''|*[!0-9]*) retry_count=0 ;; esac
  if [ "${retry_offset:-}" != "$offset" ]; then retry_count=0; fi
  retry_count=$((retry_count + 1))
  echo "$offset $retry_count" >"$RETRY_FILE"

  if [ "$retry_count" -gt "${MAX_DELTA_RETRIES:-5}" ]; then
    rm -f "$RETRY_FILE" 2>/dev/null
    echo "giveup"
    return 0
  fi
  echo "hold"
}

# Sourced as a library (eval harness): stop here, before any hook side effects.
[ -n "${ASAKI_MEMORY_STOP_EXTRACT_LIB:-}" ] && return 0 2>/dev/null || true

INPUT=$(cat)

# Guard against the block below re-triggering itself: when Claude Code is already forcing a
# continuation from a previous Stop hook decision, stop_hook_active is true. Bail immediately —
# emitting another block here would compound with Claude Code's own hook infinitely, until its
# native 8-consecutive-block circuit breaker kicks in.
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)
[ "$STOP_HOOK_ACTIVE" = "true" ] && exit 0

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null)

[ -z "${ASAKI_MEMORY_API_KEY:-}" ] && exit 0
if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
  exit 0
fi
[ -z "$SESSION_ID" ] && SESSION_ID="unknown"
# session_id is interpolated directly into filesystem paths below (STATE_FILE, LOG_FILE, etc.);
# reject anything outside the character set a real UUID/session-id would use (e.g. a "../"
# sequence) rather than trying to sanitize and continue — fall back to "unknown" outright.
case "$SESSION_ID" in
  *[!A-Za-z0-9_-]*) SESSION_ID="unknown" ;;
esac

ASAKI_BASE="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-}}"
[ -z "$ASAKI_BASE" ] && exit 0
AUTO_EXTRACT="${ASAKI_MEMORY_AUTO_EXTRACT:-0}"
ASAKI_USER="${ASAKI_MEMORY_USER_ID:-asaki}"
# Both default ON. Correction mode gates the correction prompt/schema, the extra POST fields,
# the tail carry-over, the prior-candidate line and the throttle override; action trace gates
# only the `Tool:` lines inside the delta. Set either to 0 to fall back: with correction mode off
# the prompt, the schema, the POST body and the call frequency are what they were before this
# feature existed, and the input text is byte-for-byte identical ONLY when action trace is also
# off (trace adds `Tool:` lines to the delta regardless of correction mode). Read the "What action
# trace sends off-machine" notice in integrations/claude-code/README.md before leaving trace on:
# non-path free text (commit messages, grep patterns) leaves this machine verbatim.
CORRECTION_MODE="${ASAKI_MEMORY_CORRECTION_MODE:-1}"
ACTION_TRACE="${ASAKI_MEMORY_ACTION_TRACE:-1}"
MAX_DELTA_RETRIES="${ASAKI_MEMORY_MAX_DELTA_RETRIES:-5}"
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GIT_ROOT=""
if [ -n "$CWD" ]; then
  GIT_ROOT=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || GIT_ROOT=""
fi
if [ -n "${ASAKI_MEMORY_PROJECT_ID:-}" ]; then
  ASAKI_PROJECT="$ASAKI_MEMORY_PROJECT_ID"
elif [ -n "$GIT_ROOT" ]; then
  ASAKI_PROJECT=$(basename "$GIT_ROOT")
else
  ASAKI_PROJECT=$(basename "${CWD:-unknown}")
fi

STATE_DIR="${TMPDIR:-/tmp}/asaki-memory-stop-extract"
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/${SESSION_ID}.offset"
LOG_FILE="$STATE_DIR/${SESSION_ID}.log"
REPORTED_FILE="$STATE_DIR/${SESSION_ID}.reported"
CLASSIFIER_LOG_FILE="$STATE_DIR/${SESSION_ID}.classifier.log"
CLASSIFIER_REPORTED_FILE="$STATE_DIR/${SESSION_ID}.classifier.reported"
# Throttle state machine files (plan §4.5) plus the bounded-retry counter (§9.3). All keyed by
# SESSION_ID, so a new session starts fresh.
LAST_EXTRACT_FILE="$STATE_DIR/${SESSION_ID}.last_extract"
WINDOW_START_FILE="$STATE_DIR/${SESSION_ID}.window_start"
OVERRIDE_USED_FILE="$STATE_DIR/${SESSION_ID}.override_used"
RETRY_FILE="$STATE_DIR/${SESSION_ID}.retry"
# Tail carry-over (plan §3.2): the last few formatted lines of each successfully processed delta,
# replayed into the next prompt as labelled antecedent-only context.
TAIL_FILE="$STATE_DIR/${SESSION_ID}.tail"
TAIL_MAX_LINES=8

# The extraction/classifier calls run fire-and-forget in the background (see below), so their
# result isn't known when this invocation exits. Instead, each Stop event first checks whether
# the *previous* invocation's response landed in one of the log files since it was last
# reported, and surfaces it — one turn of delay, but visible without blocking Stop every time.
report_and_exit() {
  # Classifier result takes priority over the cloud-extraction counts below. The two paths are
  # mutually exclusive in practice (a session runs with AUTO_EXTRACT either on or off for its
  # lifetime), so there's no real conflict to merge. No decision:block here — the classifier's
  # background job already executed the write itself via plain HTTP (see the dispatch branch
  # below), so this just reports what actually happened, one turn later.
  if [ -f "$CLASSIFIER_LOG_FILE" ]; then
    CLASSIFIER_LOG_LINES=$(wc -l <"$CLASSIFIER_LOG_FILE" | tr -d ' ')
    CLASSIFIER_LAST_LINES=0
    CLASSIFIER_RETRIES=0
    if [ -f "$CLASSIFIER_REPORTED_FILE" ]; then
      read -r CLASSIFIER_LAST_LINES CLASSIFIER_RETRIES <"$CLASSIFIER_REPORTED_FILE" 2>/dev/null
    fi
    CLASSIFIER_LAST_LINES=${CLASSIFIER_LAST_LINES:-0}
    CLASSIFIER_RETRIES=${CLASSIFIER_RETRIES:-0}
    # Sticky report: this systemMessage can be silently squeezed out of the visible transcript
    # when another Stop hook (e.g. a personal atomic-commit hook) finishes after this one —
    # Claude Code surfaces only the last-finishing Stop hook's systemMessage for the turn, not
    # every hook's. Re-emit the same unseen result for a few more Stop events instead of marking
    # it consumed the instant it merely parses as valid JSON, so a single lost race doesn't mean
    # the result is gone forever.
    CLASSIFIER_MAX_RETRIES=3
    if [ "$CLASSIFIER_LOG_LINES" -gt "$CLASSIFIER_LAST_LINES" ] || [ "$CLASSIFIER_RETRIES" -lt "$CLASSIFIER_MAX_RETRIES" ]; then
      CLASSIFIER_RESP="$(tail -n 1 "$CLASSIFIER_LOG_FILE" | sed -E 's/^[^ ]+ //')"
      # Only advance CLASSIFIER_REPORTED_FILE once this parses as valid JSON — a still-in-flight
      # or failed background job (classifier crash, curl failure) must not be marked reported,
      # or the next Stop event silently skips checking it forever. A failure here is silent by
      # design (no message, no retry) — the offset was already consumed.
      if echo "$CLASSIFIER_RESP" | jq -e . >/dev/null 2>&1; then
        if [ "$CLASSIFIER_LOG_LINES" -gt "$CLASSIFIER_LAST_LINES" ]; then
          echo "$CLASSIFIER_LOG_LINES 1" >"$CLASSIFIER_REPORTED_FILE"
        else
          echo "$CLASSIFIER_LOG_LINES $((CLASSIFIER_RETRIES + 1))" >"$CLASSIFIER_REPORTED_FILE"
        fi
        ACTION=$(echo "$CLASSIFIER_RESP" | jq -r '.action // "failed"')
        MEMORY=$(echo "$CLASSIFIER_RESP" | jq -r '.memory // ""')
        case "$ACTION" in
          add) VERB="add" ;;
          merge) VERB="merge into existing" ;;
          update) VERB="update existing with" ;;
          delete) VERB="delete stale memory for" ;;
          ignore) VERB="ignore (duplicate)" ;;
          review) VERB="queue for review" ;;
          failed) VERB="failed to save (will retry next turn)" ;;
          skipped)
            REASON=$(echo "$CLASSIFIER_RESP" | jq -r '.reason // ""')
            jq -cn --arg r "$REASON" '{systemMessage: ("🧠 Asaki-memory (prev turn): skip" + (if $r == "" then "" else " — " + $r end))}'
            exit 0
            ;;
          *) VERB="" ;;
        esac
        if [ -n "$VERB" ]; then
          jq -cn --arg verb "$VERB" --arg m "$MEMORY" '{systemMessage: ("🧠 Asaki-memory: " + $verb + " \"" + ($m | .[0:120]) + "\"")}'
        fi
        exit 0
      fi
    fi
  fi

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
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # The EXIT trap never fires on SIGKILL or the hook runner's hard timeout, so a crashed run
  # can leave the lock behind forever — which would silently disable capture for the rest of
  # the session. The lock only guards the short foreground phase (seconds), so anything older
  # than 60s is stale: reclaim it. Otherwise another invocation really is mid-flight — skip.
  LOCK_MTIME=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null || echo 0)
  [ $(( $(date +%s) - LOCK_MTIME )) -lt 60 ] && report_and_exit
  rmdir "$LOCK_DIR" 2>/dev/null
  mkdir "$LOCK_DIR" 2>/dev/null || report_and_exit
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

MIN_INTERVAL="${ASAKI_MEMORY_EXTRACT_MIN_INTERVAL_SECONDS:-300}"
NOW_EPOCH=$(date +%s)

LAST=0
[ -f "$STATE_FILE" ] && LAST=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
TOTAL=$(wc -l <"$TRANSCRIPT" | tr -d ' ')
[ -z "$TOTAL" ] && TOTAL=0
[ "$TOTAL" -le "$LAST" ] && report_and_exit

# The delta is built BEFORE the throttle decision (plan §4.5): the correction override has to be
# able to see the text it is deciding about. Costs one sed + one node pass per Stop event even
# when the decision is "skip" — a few ms on a 20k-char slice.
# The builder lives in build-delta.mjs so it is testable offline (scripts/eval-trace-builder.mjs).
TEXT=$(sed -n "$((LAST + 1)),${TOTAL}p" "$TRANSCRIPT" \
  | ASAKI_MEMORY_ACTION_TRACE="$ACTION_TRACE" ASAKI_TRACE_REPO_ROOT="$GIT_ROOT" node "$HOOK_DIR/build-delta.mjs")

# Whole-delta sensitive gate. Per-trace-line gating already ran inside the builder on the
# original (un-redacted) tool arguments; this is the second line of defence over the assembled
# text, and it still consumes the offset on a hit.
if echo "$TEXT" | grep -qiE -e "$SENSITIVE_PATTERN"; then
  echo "$TOTAL" >"$STATE_FILE"
  report_and_exit
fi

# Throttle: at most one normal fire per MIN_INTERVAL window, plus at most one correction-signal
# override charged against that same window. A skip deliberately does NOT advance STATE_FILE —
# the skipped delta stays queued and folds into the next Stop event's (larger) increment.
CORRECTION_SIGNAL=0
CORRECTION_SIGNAL_LINES=""
if is_flag_enabled "$CORRECTION_MODE"; then
  CORRECTION_SIGNAL_LINES=$(printf '%s' "$TEXT" | grep -iE -e "$CORRECTION_SIGNAL_PATTERN" | head -n 3)
  [ -n "$CORRECTION_SIGNAL_LINES" ] && CORRECTION_SIGNAL=1
fi
THROTTLE_DECISION=$(throttle_decision "$NOW_EPOCH" "$MIN_INTERVAL" "$CORRECTION_SIGNAL")
[ "$THROTTLE_DECISION" = "skip" ] && report_and_exit

if [ "$AUTO_EXTRACT" = "1" ]; then
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

  # Keep the tail of the delta, not the head — the highest-value content in a long turn (a final
  # "verified working" / "decided to use X" conclusion) tends to land at the end; the head is
  # more often process noise. Must NOT use "${TEXT: -20000}": macOS ships bash 3.2, where a
  # negative offset whose magnitude exceeds the string length yields an empty string (bash 4.2+
  # returns the whole string) — that silently emptied every sub-20000-char delta. Slice with a
  # positive offset instead, and only when actually longer than the cap.
  [ "${#TEXT}" -gt 20000 ] && TEXT="${TEXT:$((${#TEXT} - 20000))}"

  # No "scope" here on purpose — let the server infer global vs project per candidate.
  # project_id is still sent as a hint for whichever candidates resolve to project scope.
  BODY=$(jq -cn --arg text "$TEXT" --arg user "$ASAKI_USER" --arg project "$ASAKI_PROJECT" \
    '{text: $text, user_id: $user, project_id: $project, source: "claude-code:auto-extract"}')

  (
    RESP=$(curl -sf --max-time 20 -X POST "${ASAKI_BASE}/v1/memories/extract" \
      -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
      -H "Content-Type: application/json" \
      -d "$BODY" 2>>"$LOG_FILE")
    CURL_STATUS=$?
    # Only advance STATE_FILE here, inside the background job, once the request actually
    # succeeded — writing it eagerly before dispatch (as before) meant a curl failure (network
    # down, 429, process killed) would permanently skip this delta with no retry. Leaving
    # STATE_FILE untouched on failure folds the delta into the next Stop event's (larger)
    # increment instead, mirroring the throttle's and content-gate's carry-forward behavior
    # above. Trade-off: a Stop event that fires again before this job finishes will re-read the
    # same not-yet-advanced offset and may resend an overlapping delta — accepted, since the
    # server's dedup/merge pipeline (src/services/candidates.ts) collapses duplicate candidates
    # instead of writing them twice.
    if [ "$CURL_STATUS" -eq 0 ] && echo "$RESP" | jq -e . >/dev/null 2>&1; then
      echo "$TOTAL" >"$STATE_FILE"
    fi
    echo "$(date -u +%FT%TZ) ${RESP}" >>"$LOG_FILE"
  ) >/dev/null 2>&1 &
  disown
else
  # Cloud auto-extract is off (the default): no regex pre-filter here on purpose — a real LLM
  # judgment call is more reliable than a keyword gate at deciding whether a delta is worth
  # flagging, and this classifier has no write access, so a false positive only costs one extra
  # agent turn, not a bad write.
  # Keep the tail of the delta, not the head — see the matching comment in the AUTO_EXTRACT=1
  # branch above for why, and for the bash-3.2 empty-string pitfall this positive-offset form avoids.
  [ "${#TEXT}" -gt 20000 ] && TEXT="${TEXT:$((${#TEXT} - 20000))}"

  CLASSIFIER_MODEL="${ASAKI_MEMORY_CLASSIFIER_MODEL:-claude-haiku-4-5-20251001}"
  # --json-schema forces the CLI to constrain decoding to this shape (not just prompt-requested
  # JSON) — without it, real conversation deltas (esp. ones ending on an open question, or ones
  # that discuss this very classifier/memory mechanism) reliably pull the model into "continuing
  # the conversation" instead of classifying it, producing prose instead of JSON. Confirmed via
  # two real production failures before this flag was added.
  CLASSIFIER_SCHEMA='{"type":"object","properties":{"flag":{"type":"boolean"},"text":{"type":"string"},"type":{"type":"string"},"scope":{"type":"string"},"reason":{"type":"string"}},"required":["flag","text","type","scope","reason"],"additionalProperties":false}'
  # --system-prompt fully replaces Claude Code's default system prompt (which otherwise leaks
  # ambient cwd/git-status context into every call) — confirmed via direct test. It also cleanly
  # separates role/instructions from the delta content itself (system turn vs. user turn),
  # instead of concatenating both into one prompt string.
  # KEEP IN SYNC with the judgment/distill/scope-rule prompt template in scripts/eval-classifier.sh,
  # and (scope rule wording) with src/services/extraction.ts's SYSTEM_PROMPT / commands/memory.md /
  # integrations/pi/asaki-memory.ts.
  CLASSIFIER_SYSTEM_PROMPT='You are a memory-candidate detector, not a writer. Given a conversation delta, decide if it contains something worth saving as a durable memory, and if so pre-distill it into ready-to-write fields — this hook executes the write itself via HTTP after your response (the server then routes it to a review queue), so make the call carefully here.

Apply this checklist:
1. Durable — will this still matter later, not just for the current task.
2. Actually happened — a completed decision/fact/fix, not a proposal, question, or hypothetical.
3. Not noise — not chit-chat, a one-off command, or quoted code/CLI output/prompt text used only to explain how something works (even if the quoted text itself sounds like a preference/rule).
4. Self-contained — understandable on its own, without the rest of the conversation.
5. Right scope — see scope rule below.

Do NOT flag: an in-progress/undecided plan, a problem report that ends by asking whether to fix it, routine implementation-progress update within ongoing work, or prompt/eval calibration notes that quote hypothetical user inputs. Actual user forget/retract requests are durable and should be flag=true.

Three noise classes that read like durable outcomes but are not — all flag=false:
- Pipeline state: plan/review verdicts, blocker lists, eval pass rates, batch statistics, rollout gate numbers. They describe one run of a process and the next run replaces them.
- A completed one-off edit to content or documentation whose own record is the artifact it changed (one row in a data file, a doc/skill/prompt file update). The durable configuration or behaviour state a change leaves behind still qualifies; the edit event by itself does not.
- A restatement of a rule the delta itself presents as already recorded, already in effect, or unchanged. Flag it only when the delta actually establishes or changes the rule.

Two contrastive examples:
- "解决了内存泄漏问题，已验证生效" -> flag=true (a previously-existing problem is now resolved).
- "加了个测试用例，跑了一下全过了" -> flag=false (a routine step of ongoing work, no prior problem being resolved, nothing durable to recall later).
- "这条需要改。要不要现在改？" -> flag=false (problem identified but fix/decision is still pending).
- "FORGET_SIGNALS 正则用于识别类似 \"forget that I prefer dark mode\" 这种表达" -> flag=false (documentation-style explanation of code/prompt behavior, not an actual forget request).
- User says "forget that I prefer dark mode" -> flag=true (actual forget/retract request).
- "prompt 里加了 few-shot 正例，比如 User: 以后都用 pnpm" -> flag=false (prompt/eval calibration quoting a hypothetical user input).
- "已将变更推送至 origin/main，提交为 8df25dd" -> flag=false (one-off delivery status, not durable memory).
- "Node.js new URL().hostname 对 IPv6 loopback 返回 '[::1]'" -> flag=false (generic technical trivia, not a user/project memory).
- "点点数据的 App 详情页是 JS SPA，WebFetch 抓不到价格，后续改用官方 API" -> flag=true, scope=project (tool/site-specific learning never belongs in global scope).
- "已从 Pi 配置中彻底移除 Ponytail 包、extension、skills 和配置引用" -> flag=true, scope=project (durable current configuration state).
- "type: fix" -> flag=false (vague commit fragment with no self-contained durable fact).
- "Music playing now" -> flag=false (transient UI/runtime status).
- "先强制使用 Chafa；后续确认已支持 Kitty graphics，撤销 Chafa 并恢复 Kgp" -> flag=true, scope=project, but distill only the final Kgp state (superseded intermediate states must not become separate memories).
- "环境变量/API密钥统一存放在 ~/.config/fish/conf.d/api_keys.local.fish" -> flag=true, scope=project (machine-local shell paths belong to the dotfiles project, never global).
- "一次性汇报放 scratchpad，不写入项目仓库" -> flag=true, scope=global (a reusable cross-project delivery preference; keep it concise).
- "周会每项目 3–5 行，与豪哥日报区分；临时汇报放 scratchpad" -> flag=true, scope=project (mentor/reporting-specific conventions do not help in unrelated projects).
- "Claude Code 的交付文本必须放在回合最后，否则后续工具调用可能使文本不展示" -> flag=true, scope=project (app-specific harness behavior is not global).
- "用户希望针对技能和工具进行优化，列出推荐项并决定是否禁用" -> flag=false (an open optimization intention is not a completed decision or durable outcome).
- "paneru 四边 padding 4→10，与 sketchybar 左侧 10px 对齐" -> flag=true, scope=project, and distill the final 10px state rather than the change history.
- A long SketchyBar popup implementation report -> flag=true, scope=project, but compress it to the stable entry point, switching mechanism, and fallback behavior within 300 characters.
- "Claude Design 画布页（.dc.html）不在 DesignSync MCP 文件树里（get_file 404）。浏览器登录态下可直接调 Omelette API：读取 GetFile，写回用 UploadFile，DeleteFile 删文件；大段 HTML 下载用 Blob+anchor，上传方向页内 fetch 后再 SHA-256 对齐本地。" -> flag=false (raw one-off API procedure dump, not an explicit repeat-use convention or established project workflow).
- "用户希望不使用嵌套并复用同一个 herdr 进程和 server" -> flag=false ("不使用嵌套" lacks an object and cannot stand alone).
- "手动拖高 Ghostty 窗口以填补当前布局缺口" -> flag=false (transient manual UI adjustment).
- "独立审查判定方案 v2 不通过，阻塞项 B-2 至 B-8 需在动代码前解决" -> flag=false (a plan-review verdict and its blocker list are pipeline state, replaced by the next review round).
- "classifier eval 57/60 通过，correction recall 92%、precision 100%，作为后续批次的对比参考点" -> flag=false (eval pass rates and batch statistics describe one run, not durable knowledge).
- "已把审计流程的第 4 步补写进 commands/memory.md 的 workflow 段落" -> flag=false (a completed one-off edit to a data or doc file is already recorded by that file; only the durable configuration or behaviour state it leaves behind would qualify).
- "复核了一遍现有规则，push 前检查明文密钥这条依然有效，本轮没有新增或修改任何规则" -> flag=false (restating an already-recorded rule adds nothing; flag only when the delta establishes or changes it).

If flag=true, distill: compress the candidate into exactly ONE self-contained sentence for `text`, same language as the source. Preference/rule should be roughly 40-160 characters; decision/workflow/bug_fix/task_learning should be 1-2 sentences and at most roughly 200-300 characters. No bullet lists. One fact per memory — never chain multiple facts with semicolons/commas. Never paste raw code, CLI output, or a multi-paragraph narrative.

Classify (only meaningful when flag=true):
- type: preference | rule | fact | decision | task_learning | bug_fix | workflow
- scope rule: "global" only if the statement would genuinely help in ANY unrelated project (cross-project dev preferences, communication/output style, secret-handling rules, durable personal/identity facts), and "project" for everything else, including system/tool troubleshooting (dotfiles, window manager configs, app-specific bugs, OS-level fixes) even when it was not said inside a recognizable project. When ambiguous, prefer "project".

Be conservative: when genuinely unsure, prefer flag=false — a missed candidate falls back to the existing prompt-based reminder, a false alarm costs the main agent one wasted turn.

Output your FINAL answer as compact JSON only, no other prose before or after it: {"flag":true|false,"text":"<distilled sentence if flag=true, else empty string>","type":"<type if flag=true, else empty string>","scope":"<scope if flag=true, else empty string>","reason":"<short reason, especially when flag=false>"}'
  # Correction mode (plan §6). Superset of the prompt above: same checklist and few-shot set,
  # plus correction detection, the contrast pair, rule-form grammar and the extra output fields.
  # KEEP IN SYNC — byte-identical — with CORRECTION_SYSTEM_PROMPT in
  # integrations/pi/asaki-memory.ts and scripts/eval-classifier.sh.
  CORRECTION_SYSTEM_PROMPT='You are a memory-candidate detector, not a writer. Given a conversation delta, decide if it contains something worth saving as a durable memory, and if so pre-distill it into ready-to-write fields — the client executes the write itself via HTTP after your response (the server then routes it to a review queue), so make the call carefully here.

PRIORITY: the user correcting the agent outranks everything else. A correction is any turn where the user rejects, reverses, narrows, or explicitly approves what the agent just did. If one delta contains BOTH a correction and an ordinary outcome/preference, emit ONLY the correction — the competitor is dropped, not downgraded. At most one candidate per delta.

Input shape. The delta may contain:
- "User:" / "Assistant:" lines — conversation prose, in transcript order.
- "Tool: <name> <arg>" lines — one line per agent tool call, with paths, URIs and hosts already redacted. Tool results and thinking are never shown to you.
- An optional block that starts with "Prior context (ALREADY PROCESSED — antecedent only, never extract from this block):" and ends at the line "--- current delta below ---". Everything above that delimiter was already processed in an earlier turn: use it ONLY as the antecedent of a correction, and never extract a memory out of it.
- An optional "Prior memory candidate: <text>" line inside that prior block — the memory candidate this classifier proposed last time. A verdict about "那条记忆" / "that memory" refers to it.

Correction reasoning — build the contrast pair BEFORE writing the rule:
1. correction.agent_did — what the agent produced or attempted, taken from assistant prose, a "Tool:" line, the prior block, or the prior memory candidate.
2. correction.captain_verdict — the user words, verbatim, trimmed.
3. correction.redirect_target — what the user pointed to instead (empty for a pure prohibition).

Temporal attribution: agent_did MUST come from a line appearing BEFORE the verdict in reading order. "Tool:" lines appearing AFTER the verdict in the current delta are the agent repairing itself and must never be used as agent_did. If the only candidate action is post-verdict, treat the antecedent as unrecoverable.

If the antecedent cannot be recovered, output flag=false, signal="correction", antecedent_source="none", reason="correction-without-antecedent" — never invent one. This applies ONLY when the user rejects an agent ACTION you cannot find. It does NOT apply to an explicit forget/retract request about an existing memory, rule or prior candidate ("forget that I prefer dark mode", "那条记忆不对") — that request IS its own antecedent, so it is flag=true with rule_form="retract" and needs no agent action at all.

Corrections are the PRIORITY, not the only thing worth saving. A delta with no correction in it is judged exactly as it was before: a completed decision, fix, configuration state or stated preference is flag=true on its own merits and never needs a user verdict, approval or confirmation to qualify. "No correction here" is a reason to fall through to the checklist below, never a reason to answer flag=false. Judge self-containedness on what the sentence itself names — do not demand extra project context it does not need.

Fields:
- signal: correction | preference | outcome | none. Use "preference" for a stated preference/rule with no correction, "outcome" for a completed decision/fix/learning, "none" when flag=false and nothing was detected.
- signal_subtype, only when signal=correction (otherwise empty string):
  - explicit_negation — 不对、不是这样、错了、这不行、no that is wrong, that is not right
  - override_of_action — 不用改了、别改、改回、回到…、还是原来的、撤销、revert, undo that, put it back
  - terse_redirect — 去掉、删掉、换成、直接用、应该是…、use X instead, drop that
  - repeat_complaint — 又…、还是…、说过了、都说了、第几次了、again, I already said
  - approval_after_change — 对了、这样就行、可以了、就这样、yes that is it (EXPLICIT approval only; never mine implicit acceptance)
  - futility_verdict — 何必、没必要、多余、想复杂了、overkill, why bother
- rule_form: prohibition | preference | procedure | retract. Use "retract" for an explicit request to drop or undo an existing memory, rule or prior candidate — including when the user also names a replacement in the same breath (the replacement goes in redirect_target and shapes text; the form stays retract).
- antecedent_source: prose | trace | prior_tail | candidate | none — where agent_did came from. Use "trace" for a "Tool:" line in the current delta, "prior_tail" for anything inside the prior block, "candidate" for the "Prior memory candidate:" line, "prose" for assistant text, "none" when there is no antecedent.
- supersedes_query: an AFFIRMATIVE restatement of the OLD behaviour the new rule retires, phrased the way the old memory would have been written — NOT the new negative rule. Empty string when nothing is being retired.
- Never output importance or confidence. The server derives both from signal and antecedent_source.

Rule phrasing per rule_form:
- prohibition → 不要<动作>（<场景/对象>） / Never <action> when <scope>. The object must be named; an objectless fragment is flag=false.
- preference → <场景>下优先<Y>，不要<X> / Prefer Y over X when <scope>. Name both alternatives.
- procedure → <触发条件>时先<步骤> / When <trigger>, do <step> first.
- retract → still phrased as a usable negative rule, never the bare verdict.

Two invariants:
1. The verdict is never the memory. "不对" / "何必" may appear only in correction.captain_verdict, never in text.
2. The rule must survive the death of the conversation: no 这个 / 该文件 / 上面那版 / 主公说的 in text.

Apply this checklist to every candidate, correction or not:
1. Durable — will this still matter later, not just for the current task.
2. Actually happened — a completed decision/fact/fix, not a proposal, question, or hypothetical.
3. Not noise — not chit-chat, a one-off command, or quoted code/CLI output/prompt text used only to explain how something works (even if the quoted text itself sounds like a preference/rule).
4. Self-contained — understandable on its own, without the rest of the conversation.
5. Right scope — see scope rule below.

Do NOT flag: an in-progress/undecided plan, a problem report that ends by asking whether to fix it, routine implementation-progress update within ongoing work, or prompt/eval calibration notes that quote hypothetical user inputs. Actual user forget/retract requests are durable and should be flag=true.

Three noise classes that read like durable outcomes but are not — all flag=false:
- Pipeline state: plan/review verdicts, blocker lists, eval pass rates, batch statistics, rollout gate numbers. They describe one run of a process and the next run replaces them.
- A completed one-off edit to content or documentation whose own record is the artifact it changed (one row in a data file, a doc/skill/prompt file update). The durable configuration or behaviour state a change leaves behind still qualifies; the edit event by itself does not.
- A restatement of a rule the delta itself presents as already recorded, already in effect, or unchanged. Flag it only when the delta actually establishes or changes the rule.

Correction examples:
- "Tool: bash git commit -m \"wip\"" … "User: 别再自动 commit 了" -> flag=true, signal=correction, signal_subtype=override_of_action, rule_form=prohibition, antecedent_source=trace, text="不要在未获得确认前自动 commit 本仓库的改动".
- "Assistant: 顺手把首页布局重排了" … "User: 回打开前的页面" -> flag=true, signal=correction, signal_subtype=override_of_action, rule_form=prohibition, antecedent_source=prose, text="修改页面时不要顺手重排既有布局，改完后回到用户打开前的页面状态".
- "Assistant: 加了三层缓存做兜底" … "User: 何必" -> flag=true, signal=correction, signal_subtype=futility_verdict, rule_form=preference, antecedent_source=prose, text="没有实测瓶颈时不要预先加多层缓存兜底，先用最简实现".
- "Assistant: 把配置改成 A 方案" … "User: 还是原来的好" -> flag=true, signal=correction, signal_subtype=override_of_action, rule_form=preference, antecedent_source=prose, text="该项目配置保留原方案 B，不要换成 A 方案", supersedes_query="该项目配置改用 A 方案".
- "Prior memory candidate: 每次编辑完成后自动 commit 并推送" … "User: 那条不对" -> flag=true, signal=correction, signal_subtype=explicit_negation, rule_form=retract, antecedent_source=candidate, text="不要在编辑完成后自动 commit 并推送", supersedes_query="每次编辑完成后自动 commit 并推送".
- prior block "Tool: edit src/a.ts" … current delta "User: 不对" then "Tool: edit src/a.ts" -> the antecedent is the PRIOR action (antecedent_source=prior_tail); the post-verdict tool line is the repair and must be ignored.
- "User: 不对" with nothing before it -> flag=false, signal=correction, antecedent_source=none, reason="correction-without-antecedent".
- User says "forget that I prefer dark mode" -> flag=true, signal=correction, rule_form=retract, antecedent_source=prose, supersedes_query="prefers dark mode" (an explicit forget request is never "correction-without-antecedent").
- "Prior memory candidate: Always run the full eval suite before every commit" … "User: that memory is wrong, drop it — only run it before a release" -> flag=true, rule_form=retract (NOT procedure), antecedent_source=candidate, redirect_target="only before a release".
- "User: 这样不会有问题吗？" -> flag=false (a question is not a verdict).
- "Assistant: 我上面那条改错了，已经修回来了" -> flag=false (the agent correcting itself is not a user correction).
- "Tool: bash fm-wake-drain.sh --verify" … "User: 关掉这个自动核查" -> flag=false (a 这个/这次-scoped verdict switches off ONE specific redundant run and is not durable; only widen a verdict into a standing prohibition when the user words themselves generalize, e.g. 别再/以后/每次/again).
- One delta with "Assistant: 已修复登录超时" and "User: 别再自动 commit 了" -> emit ONLY the correction; the fix outcome is dropped.

Non-correction examples (unchanged rules):
- "解决了内存泄漏问题，已验证生效" -> flag=true (a previously-existing problem is now resolved).
- "记忆里漏了缓存过期时间的配置项" … "已经补全，缓存过期时间统一改成 300 秒" -> flag=true (a concrete corrected configuration value is durable; do not demand an extra system/project identifier the sentence does not need).
- "加了个测试用例，跑了一下全过了" -> flag=false (a routine step of ongoing work, no prior problem being resolved, nothing durable to recall later).
- "这条需要改。要不要现在改？" -> flag=false (problem identified but fix/decision is still pending).
- "FORGET_SIGNALS 正则用于识别类似 \"forget that I prefer dark mode\" 这种表达" -> flag=false (documentation-style explanation of code/prompt behavior, not an actual forget request).
- User says "forget that I prefer dark mode" -> flag=true (actual forget/retract request).
- "prompt 里加了 few-shot 正例，比如 User: 以后都用 pnpm" -> flag=false (prompt/eval calibration quoting a hypothetical user input).
- "已将变更推送至 origin/main，提交为 8df25dd" -> flag=false (one-off delivery status, not durable memory).
- "Node.js new URL().hostname 对 IPv6 loopback 返回 [::1]" -> flag=false (generic technical trivia, not a user/project memory).
- "点点数据的 App 详情页是 JS SPA，WebFetch 抓不到价格，后续改用官方 API" -> flag=true, scope=project (tool/site-specific learning never belongs in global scope).
- "已从 Pi 配置中彻底移除 Ponytail 包、extension、skills 和配置引用" -> flag=true, scope=project (durable current configuration state).
- "type: fix" -> flag=false (vague commit fragment with no self-contained durable fact).
- "Music playing now" -> flag=false (transient UI/runtime status).
- "先强制使用 Chafa；后续确认已支持 Kitty graphics，撤销 Chafa 并恢复 Kgp" -> flag=true, scope=project, but distill only the final Kgp state (superseded intermediate states must not become separate memories).
- "环境变量/API密钥统一存放在 ~/.config/fish/conf.d/api_keys.local.fish" -> flag=true, scope=project (machine-local shell paths belong to the dotfiles project, never global).
- "一次性汇报放 scratchpad，不写入项目仓库" -> flag=true, scope=global (where one-off artifacts go is a reusable cross-project delivery preference, so it stays global even though the sentence mentions 项目仓库; keep it concise).
- "周会每项目 3–5 行，与豪哥日报区分；临时汇报放 scratchpad" -> flag=true, scope=project (mentor/reporting-specific conventions do not help in unrelated projects).
- "Claude Code 的交付文本必须放在回合最后，否则后续工具调用可能使文本不展示" -> flag=true, scope=project (app-specific harness behavior is not global).
- "用户希望针对技能和工具进行优化，列出推荐项并决定是否禁用" -> flag=false (an open optimization intention is not a completed decision or durable outcome).
- "paneru 四边 padding 4→10，与 sketchybar 左侧 10px 对齐" -> flag=true, scope=project, and distill the final 10px state rather than the change history.
- A long SketchyBar popup implementation report -> flag=true, scope=project, but compress it to the stable entry point, switching mechanism, and fallback behavior within 300 characters.
- "Claude Design 画布页（.dc.html）不在 DesignSync MCP 文件树里（get_file 404）。浏览器登录态下可直接调 Omelette API：读取 GetFile，写回用 UploadFile，DeleteFile 删文件；大段 HTML 下载用 Blob+anchor，上传方向页内 fetch 后再 SHA-256 对齐本地。" -> flag=false (raw one-off API procedure dump, not an explicit repeat-use convention or established project workflow).
- "用户希望不使用嵌套并复用同一个 herdr 进程和 server" -> flag=false ("不使用嵌套" lacks an object and cannot stand alone).
- "手动拖高 Ghostty 窗口以填补当前布局缺口" -> flag=false (transient manual UI adjustment).
- "独立审查判定方案 v2 不通过，阻塞项 B-2 至 B-8 需在动代码前解决" -> flag=false (a plan-review verdict and its blocker list are pipeline state, replaced by the next review round).
- "classifier eval 57/60 通过，correction recall 92%、precision 100%，作为后续批次的对比参考点" -> flag=false (eval pass rates and batch statistics describe one run, not durable knowledge).
- "已把审计流程的第 4 步补写进 commands/memory.md 的 workflow 段落" -> flag=false (a completed one-off edit to a data or doc file is already recorded by that file; only the durable configuration or behaviour state it leaves behind would qualify).
- "复核了一遍现有规则，push 前检查明文密钥这条依然有效，本轮没有新增或修改任何规则" -> flag=false (restating an already-recorded rule adds nothing; flag only when the delta establishes or changes it).

If flag=true, distill: compress the candidate into exactly ONE self-contained sentence for text, same language as the source. Preference/rule should be roughly 40-160 characters; decision/workflow/bug_fix/task_learning should be 1-2 sentences and at most roughly 200-300 characters. No bullet lists. One fact per memory — never chain multiple facts with semicolons/commas. Never paste raw code, CLI output, or a multi-paragraph narrative.

Classify (only meaningful when flag=true):
- type: preference | rule | fact | decision | task_learning | bug_fix | workflow. A correction is normally "rule", or "preference" for a taste-level redirect.
- scope rule: "global" only if the statement would genuinely help in ANY unrelated project (cross-project dev preferences, communication/output style, secret-handling rules, durable personal/identity facts), and "project" for everything else, including system/tool troubleshooting (dotfiles, window manager configs, app-specific bugs, OS-level fixes) even when it was not said inside a recognizable project. When ambiguous, prefer "project".

Be conservative: when genuinely unsure, prefer flag=false — a missed candidate falls back to the existing prompt-based reminder, a false alarm costs the main agent one wasted turn.

Output your FINAL answer as compact JSON only, no other prose before or after it: {"flag":true|false,"signal":"correction|preference|outcome|none","signal_subtype":"<subtype if signal=correction, else empty string>","text":"<distilled sentence if flag=true, else empty string>","type":"<type if flag=true, else empty string>","scope":"<scope if flag=true, else empty string>","rule_form":"<prohibition|preference|procedure|retract, empty string when not a rule-shaped candidate>","antecedent_source":"prose|trace|prior_tail|candidate|none","correction":{"agent_did":"","captain_verdict":"","redirect_target":""},"supersedes_query":"","reason":"<short reason, especially when flag=false>"}'
  # additionalProperties:false forces every field to be emitted; importance/confidence are
  # deliberately absent — the server derives both (plan §6.1/§9.1).
  # KEEP IN SYNC with CORRECTION_SCHEMA in scripts/eval-classifier.sh and the ClassifierResult
  # parse in integrations/pi/asaki-memory.ts.
  CORRECTION_SCHEMA='{"type":"object","properties":{"flag":{"type":"boolean"},"signal":{"type":"string"},"signal_subtype":{"type":"string"},"text":{"type":"string"},"type":{"type":"string"},"scope":{"type":"string"},"rule_form":{"type":"string"},"antecedent_source":{"type":"string"},"correction":{"type":"object","properties":{"agent_did":{"type":"string"},"captain_verdict":{"type":"string"},"redirect_target":{"type":"string"}},"required":["agent_did","captain_verdict","redirect_target"],"additionalProperties":false},"supersedes_query":{"type":"string"},"reason":{"type":"string"}},"required":["flag","signal","signal_subtype","text","type","scope","rule_form","antecedent_source","correction","supersedes_query","reason"],"additionalProperties":false}'

  if is_flag_enabled "$CORRECTION_MODE"; then
    ACTIVE_SYSTEM_PROMPT="$CORRECTION_SYSTEM_PROMPT"
    ACTIVE_SCHEMA="$CORRECTION_SCHEMA"
    # Prior block (plan §3.2/§3.4): already-processed tail lines plus, at most, the last memory
    # candidate the server actually queued for review. Labelled and delimited so "prior" vs
    # "current" is machine-visible rather than inferred from position, and never reordered.
    PRIOR_BLOCK=""
    PRIOR_TAIL=$(tail -n "$TAIL_MAX_LINES" "$TAIL_FILE" 2>/dev/null)
    # `review` is logged only on a successful candidate POST the server routed to the queue —
    # `failed` and `skipped` lines must never become an antecedent. `fromjson?` skips partial
    # lines instead of aborting the pipeline.
    # A candidate from this morning must not be blamed for this afternoon: only the last 30
    # minutes count. The log stamps are UTC `%FT%TZ`, which is fixed-width, so a plain string
    # comparison against the cutoff is a correct chronological comparison.
    PRIOR_CANDIDATE=""
    if [ -f "$CLASSIFIER_LOG_FILE" ]; then
      PRIOR_CUTOFF_TS=$(date -u -r "$((NOW_EPOCH - 1800))" +%FT%TZ 2>/dev/null || date -u -d "@$((NOW_EPOCH - 1800))" +%FT%TZ 2>/dev/null || echo "")
      PRIOR_CANDIDATE=$(tail -n 50 "$CLASSIFIER_LOG_FILE" 2>/dev/null \
        | awk -v cutoff="$PRIOR_CUTOFF_TS" '{ ts = $1; sub(/^[^ ]+ /, ""); if (cutoff == "" || ts >= cutoff) print }' \
        | jq -rR 'fromjson? | select(.action == "review") | .memory // ""' 2>/dev/null | tail -n 1)
      PRIOR_CANDIDATE="${PRIOR_CANDIDATE:0:300}"
    fi
    if [ -n "$PRIOR_TAIL" ] || [ -n "$PRIOR_CANDIDATE" ]; then
      PRIOR_BLOCK="Prior context (ALREADY PROCESSED — antecedent only, never extract from this block):"
      [ -n "$PRIOR_TAIL" ] && PRIOR_BLOCK="${PRIOR_BLOCK}
${PRIOR_TAIL}"
      [ -n "$PRIOR_CANDIDATE" ] && PRIOR_BLOCK="${PRIOR_BLOCK}
Prior memory candidate: ${PRIOR_CANDIDATE}"
      PRIOR_BLOCK="${PRIOR_BLOCK}
--- current delta below ---"
    fi
    CORRECTION_HINT=""
    if [ "$CORRECTION_SIGNAL" = "1" ]; then
      CORRECTION_HINT="correction_suspected: true (lines that tripped the local pre-gate)
${CORRECTION_SIGNAL_LINES}
"
    fi
    # Hint first, then the labelled prior block, then the delta — so nothing sits between the
    # `--- current delta below ---` delimiter and the current delta it introduces.
    CLASSIFIER_PROMPT=$(printf '%s%sDelta:\n%s' "$CORRECTION_HINT" "${PRIOR_BLOCK:+$PRIOR_BLOCK$'\n'}" "$TEXT")
    # Carried into the NEXT prompt, but only once this delta is actually processed (written
    # below). Transcript order is preserved and nothing is deduplicated: the trace line format
    # carries no timestamp, so order is the only temporal signal the model gets.
    TAIL_LINES=$(printf '%s\n' "$TEXT" | grep -v '^[[:space:]]*$' | tail -n "$TAIL_MAX_LINES")
    [ -n "$TAIL_LINES" ] && TAIL_LINES="${TAIL_LINES}
"
  else
    ACTIVE_SYSTEM_PROMPT="$CLASSIFIER_SYSTEM_PROMPT"
    ACTIVE_SCHEMA="$CLASSIFIER_SCHEMA"
    CLASSIFIER_PROMPT=$(printf 'Delta:\n%s' "$TEXT")
    TAIL_LINES=""
  fi

  (
    RESP=$(claude -p --safe-mode --tools "" --model "$CLASSIFIER_MODEL" --system-prompt "$ACTIVE_SYSTEM_PROMPT" --json-schema "$ACTIVE_SCHEMA" "$CLASSIFIER_PROMPT" 2>>"$CLASSIFIER_LOG_FILE")
    CLAUDE_STATUS=$?
    RESP_SINGLE_LINE=$(echo "$RESP" | tr '\n' ' ' | sed -E 's/```(json)?//g')
    # STATE_FILE only advances once the delta's FINAL outcome is known: a valid flag=false
    # classification (nothing to write), or a flag=true candidate whose HTTP write actually
    # succeeded. Advancing right after `claude -p` returned valid JSON (as before) reintroduced
    # the exact bug the AUTO_EXTRACT=1 branch's comment warns about — a curl failure on the
    # write below happened AFTER the offset had moved, so a classifier-approved memory was
    # silently lost with no retry. Checking FLAG alone isn't enough to detect classifier
    # success: `jq -r '.flag // false'` also yields "false" when parsing fails outright,
    # indistinguishable from a genuine flag=false — so validity is checked separately via
    # `jq -e .` first. Leaving STATE_FILE untouched on any failure folds the delta into the
    # next Stop event's (larger) increment instead, mirroring the throttle's and content-gate's
    # carry-forward behavior above. Trade-off: a Stop event that fires again before this job
    # finishes will re-read the same not-yet-advanced offset and may re-classify/re-send an
    # overlapping delta — accepted, since the server's dedup/merge pipeline
    # (src/services/candidates.ts) collapses duplicate candidates instead of writing them twice.
    CLASSIFIER_OK=0
    if [ "$CLAUDE_STATUS" -eq 0 ] && echo "$RESP_SINGLE_LINE" | jq -e . >/dev/null 2>&1; then
      CLASSIFIER_OK=1
    fi
    FLAG=$(echo "$RESP_SINGLE_LINE" | jq -r '.flag // false' 2>/dev/null)
    if [ "$FLAG" = "true" ]; then
      TEXT_FIELD=$(echo "$RESP_SINGLE_LINE" | jq -r '.text // ""')
      TYPE_FIELD=$(echo "$RESP_SINGLE_LINE" | jq -r '.type // "fact"')
      SCOPE_FIELD=$(echo "$RESP_SINGLE_LINE" | jq -r '.scope // "project"')
      # Execute the write ourselves via plain HTTP — the same server endpoint the
      # asaki_memory_add MCP tool calls under the hood (integrations/mcp/asaki-memory.ts), so it
      # gets the identical server-side dedup/merge pipeline (src/services/candidates.ts). No
      # Claude/MCP/claude-p involved in this step at all — a real HTTP round trip, so the result
      # is whatever the server actually decided, never a model's unverifiable self-report.
      if is_flag_enabled "$CORRECTION_MODE"; then
        # project_context is sent for EVERY scope, unlike project_id — it is a scope-neutral hint
        # the server persists but never uses for scope validation, visibility, or the review row
        # project_id column. Without it a global correction cannot be matched against the
        # project memories it retires (plan §5.3c).
        CANDIDATE_BODY=$(jq -cn --arg content "$TEXT_FIELD" --arg kind "$TYPE_FIELD" --arg scope "$SCOPE_FIELD" \
          --arg user "$ASAKI_USER" --arg project "$ASAKI_PROJECT" \
          --arg signal "$(echo "$RESP_SINGLE_LINE" | jq -r '.signal // ""')" \
          --arg signal_subtype "$(echo "$RESP_SINGLE_LINE" | jq -r '.signal_subtype // ""')" \
          --arg rule_form "$(echo "$RESP_SINGLE_LINE" | jq -r '.rule_form // ""')" \
          --arg antecedent_source "$(echo "$RESP_SINGLE_LINE" | jq -r '.antecedent_source // ""')" \
          --arg agent_did "$(echo "$RESP_SINGLE_LINE" | jq -r '.correction.agent_did // ""')" \
          --arg captain_verdict "$(echo "$RESP_SINGLE_LINE" | jq -r '.correction.captain_verdict // ""')" \
          --arg redirect_target "$(echo "$RESP_SINGLE_LINE" | jq -r '.correction.redirect_target // ""')" \
          --arg supersedes_query "$(echo "$RESP_SINGLE_LINE" | jq -r '.supersedes_query // ""')" '
          {user_id: $user, source: "claude-code:stop-classifier",
           candidates: [{content: $content, kind: $kind, scope: $scope, project_context: $project,
                         signal: $signal, signal_subtype: $signal_subtype, rule_form: $rule_form,
                         antecedent_source: $antecedent_source,
                         correction: {agent_did: $agent_did, captain_verdict: $captain_verdict, redirect_target: $redirect_target},
                         supersedes_query: $supersedes_query}
                        + (if $scope == "project" then {project_id: $project} else {} end)]}')
      else
        CANDIDATE_BODY=$(jq -cn --arg content "$TEXT_FIELD" --arg kind "$TYPE_FIELD" --arg scope "$SCOPE_FIELD" \
          --arg user "$ASAKI_USER" --arg project "$ASAKI_PROJECT" '
          {user_id: $user, source: "claude-code:stop-classifier",
           candidates: [{content: $content, kind: $kind, scope: $scope} + (if $scope == "project" then {project_id: $project} else {} end)]}')
      fi

      # Output-side gate (plan §8.2e): correction.* and supersedes_query are verbatim
      # conversation echoes, so the model can hand back a secret the input gate already passed
      # (it gates the delta, not the model's quoting of it). A hit consumes the offset and skips
      # the write — resending the same body would just resend the same secret.
      if echo "$CANDIDATE_BODY" | grep -qiE -e "$SENSITIVE_PATTERN"; then
        echo "$TOTAL" >"$STATE_FILE"
        FINAL_JSON=$(jq -cn '{action: "skipped", memory: "", reason: "sensitive-content-in-candidate"}')
        echo "$(date -u +%FT%TZ) ${FINAL_JSON}" >>"$CLASSIFIER_LOG_FILE"
        exit 0
      fi

      # PID-suffixed: the lock only guards the foreground phase, so two background jobs for
      # the same session can overlap and must not share a response file.
      ADD_BODY_FILE="$STATE_DIR/${SESSION_ID}.add-response.$$"
      # `-sf` used to collapse every failure into the same empty body, so a deterministic 400 was
      # retried forever while a 429 or a wrong key looked identical to it. Capture the status and
      # branch on failure class instead (plan §9.3). `000` = network error/timeout.
      HTTP_CODE=$(curl -s -o "$ADD_BODY_FILE" -w '%{http_code}' --max-time 20 -X POST "${ASAKI_BASE}/v1/memories/candidates" \
        -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$CANDIDATE_BODY" 2>>"$CLASSIFIER_LOG_FILE")
      [ -z "$HTTP_CODE" ] && HTTP_CODE="000"
      ADD_RESP=$(cat "$ADD_BODY_FILE" 2>/dev/null)
      rm -f "$ADD_BODY_FILE" 2>/dev/null
      OUTCOME=$(outcome_for_status "$HTTP_CODE" "$TOTAL")
      # The server routes this "claude-code:stop-classifier" source straight to the review queue
      # (never decisions) — see isUnsupervisedSource() in src/services/candidateDecision.ts.
      ACTION=$(echo "$ADD_RESP" | jq -r 'if (.decisions // [] | length) > 0 then .decisions[0].action elif (.reviews // [] | length) > 0 then "review" else "failed" end' 2>/dev/null)
      [ -z "$ACTION" ] && ACTION="failed"
      REASON=""
      case "$OUTCOME" in
        advance)
          echo "$TOTAL" >"$STATE_FILE"
          if [ "$ACTION" = "failed" ]; then
            REASON="rejected-${HTTP_CODE}"
            ACTION="skipped"
          fi
          ;;
        giveup)
          # Held this delta the whole retry budget and it still will not land. Consume it, loudly.
          echo "$TOTAL" >"$STATE_FILE"
          ACTION="skipped"
          REASON="give-up-after-${MAX_DELTA_RETRIES}-${HTTP_CODE}"
          ;;
        *)
          ACTION="failed"
          case "$HTTP_CODE" in
            401|403) REASON="http-${HTTP_CODE}; check ASAKI_MEMORY_API_KEY" ;;
            *) REASON="http-${HTTP_CODE}" ;;
          esac
          ;;
      esac
      if [ -n "$TAIL_LINES" ] && [ "$ACTION" != "failed" ]; then
        printf '%s' "$TAIL_LINES" >"$TAIL_FILE"
      fi
      FINAL_JSON=$(jq -cn --arg action "$ACTION" --arg memory "$TEXT_FIELD" --arg reason "$REASON" '{action: $action, memory: $memory, reason: $reason}')
    else
      if [ "$CLASSIFIER_OK" -eq 1 ]; then
        echo "$TOTAL" >"$STATE_FILE"
        [ -n "$TAIL_LINES" ] && printf '%s' "$TAIL_LINES" >"$TAIL_FILE"
      fi
      REASON_FIELD=$(echo "$RESP_SINGLE_LINE" | jq -r '.reason // ""' 2>/dev/null)
      FINAL_JSON=$(jq -cn --arg reason "$REASON_FIELD" '{action: "skipped", memory: "", reason: $reason}')
    fi
    # Collapse to one line defensively before appending — report_and_exit's `tail -n 1` can only
    # ever recover a whole response if each run is exactly one log line.
    echo "$(date -u +%FT%TZ) ${FINAL_JSON}" >>"$CLASSIFIER_LOG_FILE"
  ) >/dev/null 2>&1 &
  disown
fi

report_and_exit
