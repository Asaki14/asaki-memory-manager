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

ASAKI_BASE="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-}}"
[ -z "$ASAKI_BASE" ] && exit 0
AUTO_EXTRACT="${ASAKI_MEMORY_AUTO_EXTRACT:-0}"
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
CLASSIFIER_LOG_FILE="$STATE_DIR/${SESSION_ID}.classifier.log"
CLASSIFIER_REPORTED_FILE="$STATE_DIR/${SESSION_ID}.classifier.reported"

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
mkdir "$LOCK_DIR" 2>/dev/null || report_and_exit
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# Throttle: skip firing another extraction/classifier call within the min interval since the
# last one actually fired. Deliberately does NOT advance STATE_FILE below — the skipped delta
# stays queued and gets folded into the next Stop event's (larger) increment instead of being
# lost. Shared between the cloud and classifier paths since a session only ever runs one.
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
# keys, or key=value secret assignments off-machine — applies to both the cloud extraction call
# and the local classifier call (the classifier is still a real model call over the network).
# A slice containing a secret must never be retried, since leaving it queued would just resend
# the same secret in every future (larger) delta until it scrolls out of the transcript.
# KEEP IN SYNC with SENSITIVE_RE_LIST in integrations/pi/asaki-memory.ts and
# scripts/shadow-run-extraction.ts.
SENSITIVE_PATTERN='-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b|\b(sk|sk-ant|sk-proj|ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_=-]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\b(api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*"?[^"'"'"' ]{8,}|set\s+-gx\s+[[:alnum:]_]*(KEY|TOKEN|SECRET|PASSWORD)[[:alnum:]_]*\s+[^$[:space:]][^[:space:]]{8,}'
if echo "$TEXT" | grep -qiE -e "$SENSITIVE_PATTERN"; then
  echo "$TOTAL" >"$STATE_FILE"
  report_and_exit
fi

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
else
  # Cloud auto-extract is off (the default): no regex pre-filter here on purpose — a real LLM
  # judgment call is more reliable than a keyword gate at deciding whether a delta is worth
  # flagging, and this classifier has no write access, so a false positive only costs one extra
  # agent turn, not a bad write.
  echo "$TOTAL" >"$STATE_FILE"
  TEXT="${TEXT:0:20000}"

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
  CLASSIFIER_SYSTEM_PROMPT='You are a memory-candidate detector, not a writer. Given a conversation delta, decide if it contains something worth saving as a durable memory, and if so pre-distill it into ready-to-write fields — the main agent will execute the write, not re-review your judgment, so make the call carefully here.

Apply this checklist:
1. Durable — will this still matter later, not just for the current task.
2. Actually happened — a completed decision/fact/fix, not a proposal, question, or hypothetical.
3. Not noise — not chit-chat, a one-off command, or quoted code/CLI output/prompt text used only to explain how something works (even if the quoted text itself sounds like a preference/rule).
4. Self-contained — understandable on its own, without the rest of the conversation.
5. Right scope — see scope rule below.

Do NOT flag: an in-progress/undecided plan, a problem report that ends by asking whether to fix it, routine implementation-progress update within ongoing work, or prompt/eval calibration notes that quote hypothetical user inputs. Actual user forget/retract requests are durable and should be flag=true.

Two contrastive examples:
- "解决了内存泄漏问题，已验证生效" -> flag=true (a previously-existing problem is now resolved).
- "加了个测试用例，跑了一下全过了" -> flag=false (a routine step of ongoing work, no prior problem being resolved, nothing durable to recall later).
- "这条需要改。要不要现在改？" -> flag=false (problem identified but fix/decision is still pending).
- "FORGET_SIGNALS 正则用于识别类似 \"forget that I prefer dark mode\" 这种表达" -> flag=false (documentation-style explanation of code/prompt behavior, not an actual forget request).
- User says "forget that I prefer dark mode" -> flag=true (actual forget/retract request).
- "prompt 里加了 few-shot 正例，比如 User: 以后都用 pnpm" -> flag=false (prompt/eval calibration quoting a hypothetical user input).

If flag=true, distill: compress the candidate into exactly ONE self-contained sentence for `text`, same language as the source. Preference/rule should be roughly 40-160 characters; decision/workflow/bug_fix/task_learning should be 1-2 sentences and at most roughly 200-300 characters. No bullet lists. One fact per memory — never chain multiple facts with semicolons/commas. Never paste raw code, CLI output, or a multi-paragraph narrative.

Classify (only meaningful when flag=true):
- type: preference | rule | fact | decision | task_learning | bug_fix | workflow
- scope rule: "global" only if the statement would genuinely help in ANY unrelated project (cross-project dev preferences, communication/output style, secret-handling rules, durable personal/identity facts), and "project" for everything else, including system/tool troubleshooting (dotfiles, window manager configs, app-specific bugs, OS-level fixes) even when it was not said inside a recognizable project. When ambiguous, prefer "project".

Be conservative: when genuinely unsure, prefer flag=false — a missed candidate falls back to the existing prompt-based reminder, a false alarm costs the main agent one wasted turn.

Output your FINAL answer as compact JSON only, no other prose before or after it: {"flag":true|false,"text":"<distilled sentence if flag=true, else empty string>","type":"<type if flag=true, else empty string>","scope":"<scope if flag=true, else empty string>","reason":"<short reason, especially when flag=false>"}'
  CLASSIFIER_PROMPT=$(printf 'Delta:\n%s' "$TEXT")

  echo "$NOW_EPOCH" >"$LAST_EXTRACT_FILE"

  (
    RESP=$(claude -p --safe-mode --tools "" --model "$CLASSIFIER_MODEL" --system-prompt "$CLASSIFIER_SYSTEM_PROMPT" --json-schema "$CLASSIFIER_SCHEMA" "$CLASSIFIER_PROMPT" 2>>"$CLASSIFIER_LOG_FILE")
    RESP_SINGLE_LINE=$(echo "$RESP" | tr '\n' ' ' | sed -E 's/```(json)?//g')
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
      CANDIDATE_BODY=$(jq -cn --arg content "$TEXT_FIELD" --arg kind "$TYPE_FIELD" --arg scope "$SCOPE_FIELD" \
        --arg user "$ASAKI_USER" --arg project "$ASAKI_PROJECT" '
        {user_id: $user, source: "claude-code:stop-classifier",
         candidates: [{content: $content, kind: $kind, scope: $scope} + (if $scope == "project" then {project_id: $project} else {} end)]}')
      ADD_RESP=$(curl -sf --max-time 20 -X POST "${ASAKI_BASE}/v1/memories/candidates" \
        -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
        -H "Content-Type: application/json" \
        -d "$CANDIDATE_BODY" 2>>"$CLASSIFIER_LOG_FILE")
      # The server routes this "claude-code:stop-classifier" source straight to the review queue
      # (never decisions) — see isUnsupervisedSource() in src/services/candidateDecision.ts.
      ACTION=$(echo "$ADD_RESP" | jq -r 'if (.decisions // [] | length) > 0 then .decisions[0].action elif (.reviews // [] | length) > 0 then "review" else "failed" end' 2>/dev/null)
      [ -z "$ACTION" ] && ACTION="failed"
      FINAL_JSON=$(jq -cn --arg action "$ACTION" --arg memory "$TEXT_FIELD" '{action: $action, memory: $memory, reason: ""}')
    else
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
