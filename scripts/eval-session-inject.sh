#!/usr/bin/env bash
# Wiring smoke for the session-start injection surface — the parts shellcheck and tsc cannot see.
#
# Claude Code half (this file): runs integrations/claude-code/session-start.sh and
# integrations/claude-code/user-prompt.sh for real against a stub `curl`, asserting
#   - the whole hook still costs ONE /v1/memories/list plus ONE /v1/memories/reviews/list,
#   - the injected order is standing rules → project digest → status banner,
#   - ASAKI_MEMORY_PROJECT_DIGEST=0 removes the block with no leftover whitespace,
#   - standing off + digest on still computes the kind complement (kinds parsing is hoisted),
#   - the banner's field/omission matrix on all three paths (setup-required, normal, list failure),
#   - auto-inject sends the validated top_k/min_score and honours its display budget.
#
# Pi half: scripts/eval-pi-inject.mjs (invoked at the end), which also emits the banner matrix so
# the two clients' field sets and order are compared byte for byte.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
CHECKS=0

fail() {
  echo "- FAIL $1"
  FAILURES=$((FAILURES + 1))
}

assert_contains() {
  CHECKS=$((CHECKS + 1))
  case "$2" in
    *"$3"*) ;;
    *) fail "$1: expected output to contain '$3'" ;;
  esac
}

assert_not_contains() {
  CHECKS=$((CHECKS + 1))
  case "$2" in
    *"$3"*) fail "$1: expected output NOT to contain '$3'" ;;
  esac
}

assert_eq() {
  CHECKS=$((CHECKS + 1))
  if [ "$2" != "$3" ]; then
    fail "$1: expected '$3', got '$2'"
  fi
}

# --- fixtures --------------------------------------------------------------------------------
cat >"$WORK/list.json" <<'JSON'
{"memories":[
  {"id":"r1","scope":"global","kind":"rule","status":"active","importance":0.9,"updated_at":"2026-01-03T00:00:00.000Z","content":"规则一"},
  {"id":"p1","scope":"global","kind":"preference","status":"active","importance":0.8,"updated_at":"2026-01-02T00:00:00.000Z","content":"偏好一"},
  {"id":"d1","scope":"global","kind":"decision","status":"active","importance":0.7,"updated_at":"2026-01-01T00:00:00.000Z","content":"决策一"},
  {"id":"b1","scope":"project","project_id":"proj","kind":"bug_fix","status":"active","importance":0.6,"updated_at":"2026-01-01T00:00:00.000Z","content":"修复一"}
]}
JSON

cat >"$WORK/list-rules-only.json" <<'JSON'
{"memories":[
  {"id":"r1","scope":"global","kind":"rule","status":"active","importance":0.9,"updated_at":"2026-01-03T00:00:00.000Z","content":"规则一"}
]}
JSON

cat >"$WORK/reviews.json" <<'JSON'
{"reviews":[{"id":"rev1"},{"id":"rev2"},{"id":"rev3"}]}
JSON

jq -cn '{results: [range(8) | {content: ("短记忆 " + (. | tostring)), score: (0.9 - (. / 100)), scope: "global", kind: "fact"}]}' >"$WORK/search-short.json"
jq -cn --arg big "$(printf 'x%.0s' $(seq 1 9000))" \
  '{results: ([{content: $big, score: 0.95, scope: "global", kind: "fact"}] + [range(7) | {content: ("短记忆 " + (. | tostring)), score: (0.9 - (. / 100)), scope: "global", kind: "fact"}])}' \
  >"$WORK/search-oversized.json"

# --- stub curl -------------------------------------------------------------------------------
mkdir -p "$WORK/bin"
cat >"$WORK/bin/curl" <<'STUB'
#!/usr/bin/env bash
url=""
body=""
next_is_body=0
for arg in "$@"; do
  if [ "$next_is_body" = "1" ]; then
    body="$arg"
    next_is_body=0
    continue
  fi
  case "$arg" in
    -d) next_is_body=1 ;;
    http*) url="$arg" ;;
  esac
done
printf '%s\n' "$url" >>"$STUB_CALL_LOG"
[ -n "$body" ] && printf '%s\n' "$body" >>"$STUB_BODY_LOG"
if [ "${STUB_FAIL_LIST:-0}" = "1" ] && [ "${url%/v1/memories/list}" != "$url" ]; then
  exit 22
fi
case "$url" in
  */v1/memories/list) cat "$STUB_LIST_FIXTURE" ;;
  */v1/memories/reviews/list) cat "$STUB_REVIEWS_FIXTURE" ;;
  */v1/memories/search) cat "$STUB_SEARCH_FIXTURE" ;;
esac
STUB
chmod +x "$WORK/bin/curl"

export STUB_CALL_LOG="$WORK/calls.log"
export STUB_BODY_LOG="$WORK/bodies.log"
export STUB_LIST_FIXTURE="$WORK/list.json"
export STUB_REVIEWS_FIXTURE="$WORK/reviews.json"
export STUB_SEARCH_FIXTURE="$WORK/search-short.json"
export PATH="$WORK/bin:$PATH"

export ASAKI_MEMORY_BASE_URL="https://memory.test"
export ASAKI_MEMORY_API_KEY="test-key"
export ASAKI_MEMORY_USER_ID="asaki"
export ASAKI_MEMORY_PROJECT_ID="proj"
export ASAKI_MEMORY_CLASSIFIER_MODEL="model-x"

run_session_start() {
  : >"$STUB_CALL_LOG"
  : >"$STUB_BODY_LOG"
  printf '{"source":"startup","cwd":"%s"}' "$WORK" | bash "$ROOT/integrations/claude-code/session-start.sh"
}

run_user_prompt() {
  : >"$STUB_CALL_LOG"
  : >"$STUB_BODY_LOG"
  jq -cn --arg p "$1" '{prompt: $p, cwd: "/", session_id: "sess-1"}' | bash "$ROOT/integrations/claude-code/user-prompt.sh"
}

banner_line_of() {
  printf '%s\n' "$1" | grep -o 'user=[^`]*' | head -1
}

# --- case A: both blocks on, one list + one reviews, fixed order ------------------------------
OUT=$(run_session_start)
assert_eq "A: one list call" "$(grep -c '/v1/memories/list$' "$STUB_CALL_LOG")" "1"
assert_eq "A: one reviews call" "$(grep -c '/v1/memories/reviews/list$' "$STUB_CALL_LOG")" "1"
assert_eq "A: no other calls" "$(wc -l <"$STUB_CALL_LOG" | tr -d ' ')" "2"
assert_contains "A: standing block present" "$OUT" "## Asaki Standing Rules (2 of 2)"
assert_contains "A: digest block present" "$OUT" "## Asaki Project Memory (2 of 2)"
assert_contains "A: digest carries the complement kinds" "$OUT" "- [global/decision] 决策一"
assert_contains "A: digest carries project-scoped memories" "$OUT" "- [project/bug_fix] 修复一"
STANDING_AT=$(printf '%s\n' "$OUT" | grep -n '^## Asaki Standing Rules' | cut -d: -f1)
DIGEST_AT=$(printf '%s\n' "$OUT" | grep -n '^## Asaki Project Memory' | cut -d: -f1)
BANNER_AT=$(printf '%s\n' "$OUT" | grep -n '^## Asaki Memory Active' | cut -d: -f1)
CHECKS=$((CHECKS + 1))
if ! [ "$STANDING_AT" -lt "$DIGEST_AT" ] || ! [ "$DIGEST_AT" -lt "$BANNER_AT" ]; then
  fail "A: expected order standing($STANDING_AT) → digest($DIGEST_AT) → banner($BANNER_AT)"
fi
LINE=$(banner_line_of "$OUT")
assert_eq "A: banner line" "$LINE" "user=asaki | project=proj | memories=4 | pendingReviews=3 | classifier=on model=model-x | standingRules=2/2 | projectDigest=2/2"
assert_not_contains "A: no autoExtract field" "$LINE" "autoExtract"
assert_not_contains "A: no dangling separator" "$LINE" "| |"

# --- case B: digest off -----------------------------------------------------------------------
OUT=$(ASAKI_MEMORY_PROJECT_DIGEST=0 run_session_start)
assert_not_contains "B: no digest block" "$OUT" "## Asaki Project Memory"
LINE=$(banner_line_of "$OUT")
assert_not_contains "B: no projectDigest field" "$LINE" "projectDigest"
assert_contains "B: standing block still present" "$OUT" "## Asaki Standing Rules (2 of 2)"
assert_eq "B: still one list call" "$(grep -c '/v1/memories/list$' "$STUB_CALL_LOG")" "1"
max_consecutive_blanks() {
  printf '%s\n' "$1" | awk 'BEGIN{run=0;max=0} /^[[:space:]]*$/{run++; if (run>max) max=run; next} {run=0} END{print max}'
}
assert_eq "B: a disabled digest leaves no double blank line" "$(max_consecutive_blanks "$OUT")" "1"

# --- case C: standing off + digest on (kind complement still computed) ------------------------
OUT=$(ASAKI_MEMORY_STANDING_RULES=0 ASAKI_MEMORY_STANDING_RULES_KINDS=rule run_session_start)
assert_not_contains "C: no standing block" "$OUT" "## Asaki Standing Rules"
assert_contains "C: digest still rendered" "$OUT" "## Asaki Project Memory (3 of 3)"
assert_contains "C: preference moved into the digest" "$OUT" "- [global/preference] 偏好一"
assert_not_contains "C: the configured standing kind stays out of the digest" "$OUT" "- [global/rule] 规则一"
LINE=$(banner_line_of "$OUT")
assert_not_contains "C: no standingRules field" "$LINE" "standingRules"
assert_contains "C: projectDigest field present" "$LINE" "projectDigest=3/3"

# --- case D: classifier off (only reachable via the deprecated auto-extract path) -------------
OUT=$(ASAKI_MEMORY_AUTO_EXTRACT=1 run_session_start)
LINE=$(banner_line_of "$OUT")
assert_not_contains "D: no classifier field" "$LINE" "classifier"
assert_not_contains "D: no autoExtract field" "$LINE" "autoExtract"
assert_contains "D: fields before/after the omission still joined" "$LINE" "pendingReviews=3 | standingRules=2/2"

# --- case E: list failure degrades both blocks -------------------------------------------------
OUT=$(STUB_FAIL_LIST=1 run_session_start)
assert_not_contains "E: no standing block" "$OUT" "## Asaki Standing Rules"
assert_not_contains "E: no digest block" "$OUT" "## Asaki Project Memory"
LINE=$(banner_line_of "$OUT")
assert_contains "E: memories falls back to ?" "$LINE" "memories=?"
assert_not_contains "E: no standingRules field" "$LINE" "standingRules"
assert_not_contains "E: no projectDigest field" "$LINE" "projectDigest"
assert_not_contains "E: no autoExtract field" "$LINE" "autoExtract"

# --- case F: empty digest (list has standing kinds only) --------------------------------------
OUT=$(STUB_LIST_FIXTURE="$WORK/list-rules-only.json" run_session_start)
assert_not_contains "F: no digest block" "$OUT" "## Asaki Project Memory"
LINE=$(banner_line_of "$OUT")
assert_not_contains "F: no projectDigest field" "$LINE" "projectDigest"
assert_contains "F: standing block still rendered" "$OUT" "## Asaki Standing Rules (1 of 1)"

# --- case G: setup required --------------------------------------------------------------------
OUT=$(ASAKI_MEMORY_API_KEY="" run_session_start)
assert_contains "G: setup banner" "$OUT" "## Asaki Memory — Setup Required"
LINE=$(banner_line_of "$OUT")
assert_eq "G: setup banner line" "$LINE" "user=asaki | project=proj | auth=none | classifier=on model=model-x"
assert_not_contains "G: no autoExtract field" "$LINE" "autoExtract"

# --- auto-inject: request fields and display budget --------------------------------------------
export ASAKI_MEMORY_AUTO_INJECT=1
export ASAKI_MEMORY_AUTO_INJECT_ALWAYS=1

OUT=$(ASAKI_MEMORY_AUTO_INJECT_TOP_K=8 ASAKI_MEMORY_AUTO_MIN_SCORE=.5 run_user_prompt "之前关于这个项目的决策是什么")
BODY=$(head -1 "$STUB_BODY_LOG")
assert_eq "H: top_k reaches the API" "$(printf '%s' "$BODY" | jq -r '.top_k')" "8"
assert_eq "H: min_score reaches the API" "$(printf '%s' "$BODY" | jq -r '.min_score')" "0.5"
CONTEXT=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext')
assert_contains "H: all 8 short results injected" "$CONTEXT" "injected 8/8"
assert_eq "H: 8 lines shown" "$(printf '%s\n' "$CONTEXT" | grep -c '^- 短记忆')" "8"
assert_not_contains "H: no budget footer needed" "$CONTEXT" "output budget reached"

OUT=$(STUB_SEARCH_FIXTURE="$WORK/search-oversized.json" ASAKI_MEMORY_AUTO_INJECT_TOP_K=8 run_user_prompt "之前关于这个项目的决策是什么")
CONTEXT=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext')
assert_contains "I: header counts all picked results" "$CONTEXT" "injected 8/8"
assert_contains "I: an oversized first result trips the budget footer" "$CONTEXT" "output budget reached"
assert_contains "I: the oversized line is clamped with an ellipsis" "$CONTEXT" "…"

OUT=$(ASAKI_MEMORY_AUTO_INJECT_TOP_K=8junk ASAKI_MEMORY_AUTO_MIN_SCORE=1.5 run_user_prompt "之前关于这个项目的决策是什么")
BODY=$(head -1 "$STUB_BODY_LOG")
assert_eq "J: an invalid top_k falls back to 6" "$(printf '%s' "$BODY" | jq -r '.top_k')" "6"
assert_eq "J: an out-of-range min_score falls back to 0.67" "$(printf '%s' "$BODY" | jq -r '.min_score')" "0.67"
CONTEXT=$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext')
assert_contains "J: the precheck instruction survives" "$CONTEXT" "Asaki memory precheck"

OUT=$(ASAKI_MEMORY_AUTO_INJECT_TOP_K=999999999999999999999999 run_user_prompt "之前关于这个项目的决策是什么")
BODY=$(head -1 "$STUB_BODY_LOG")
assert_eq "K: an absurd top_k clamps to 20" "$(printf '%s' "$BODY" | jq -r '.top_k')" "20"

unset ASAKI_MEMORY_AUTO_INJECT ASAKI_MEMORY_AUTO_INJECT_ALWAYS

# --- Pi half + cross-client banner comparison ---------------------------------------------------
MATRIX="$WORK/banner-matrix.tsv"
if ! ASAKI_BANNER_MATRIX_OUT="$MATRIX" node --experimental-strip-types "$ROOT/scripts/eval-pi-inject.mjs"; then
  FAILURES=$((FAILURES + 1))
fi

# The Pi builder and the hook's asaki_banner_line() must render the same state identically —
# same field set, same order, same separators.
# shellcheck source=/dev/null
ASAKI_MEMORY_SESSION_START_LIB=1 . "$ROOT/integrations/claude-code/session-start.sh"

claude_matrix_line() {
  case "$1" in
    all-on) asaki_banner_line asaki proj "" 90 3 "on model=m" "25/25" "10/65" ;;
    classifier-off) asaki_banner_line asaki proj "" 90 3 "" "25/25" "10/65" ;;
    standing-omitted) asaki_banner_line asaki proj "" 90 3 "on model=m" "" "10/65" ;;
    digest-omitted) asaki_banner_line asaki proj "" 90 3 "on model=m" "25/25" "" ;;
    both-omitted) asaki_banner_line asaki proj "" 90 3 "on model=m" "" "" ;;
    fetch-failed) asaki_banner_line asaki proj "" "?" "?" "on model=m" "" "" ;;
    no-project) asaki_banner_line asaki unknown "" 0 0 "on model=m" "" "" ;;
    setup-required) asaki_banner_line asaki proj none "" "" "on model=m" "" "" ;;
    setup-required-no-classifier) asaki_banner_line asaki proj none "" "" "" "" "" ;;
    *) printf 'UNKNOWN-STATE' ;;
  esac
}

if [ -f "$MATRIX" ]; then
  while IFS=$'\t' read -r label pi_line; do
    [ -z "$label" ] && continue
    assert_eq "matrix ${label}: Claude and Pi render the same fields" "$(claude_matrix_line "$label")" "$pi_line"
  done <"$MATRIX"
else
  fail "matrix: scripts/eval-pi-inject.mjs did not emit the banner matrix"
fi

echo "session-inject eval: ${CHECKS} Claude-side checks, ${FAILURES} failure(s)"
[ "$FAILURES" -eq 0 ] || exit 1
