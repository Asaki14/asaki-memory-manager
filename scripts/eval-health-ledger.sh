#!/usr/bin/env bash
# Offline coverage for the cross-session classifier health ledger (research report §4, P1-A).
#
# Sources the library region of integrations/claude-code/stop-extract.sh (above the
# ASAKI_MEMORY_STOP_EXTRACT_LIB guard) and drives asaki_health_record() /
# asaki_health_session_*() directly against a sandbox state dir — no hook, no model, no HTTP.
# Covers: the failure→success transitions, failing_since stickiness, per-SESSION (not per-turn)
# idle counting, corruption recovery, atomicity, and concurrent writers.
#
# The reader half (session-start.sh's two banner fields) is covered by eval:session-inject.
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

assert_eq() {
  CHECKS=$((CHECKS + 1))
  [ "$2" = "$3" ] || fail "$1: expected '$3', got '$2'"
}

# shellcheck source=/dev/null
ASAKI_MEMORY_STOP_EXTRACT_LIB=1 . "$ROOT/integrations/claude-code/stop-extract.sh"

HEALTH_FILE="$WORK/health.json"
HEALTH_LOCK_DIR="$WORK/health.lock"

field() { jq -r "$1 // \"null\"" "$HEALTH_FILE" 2>/dev/null; }
new_session() { HEALTH_SESSION_MARK="$WORK/$1.health_counted"; rm -f "$HEALTH_SESSION_MARK"; }

# --- a first-ever ledger is a normal first run, not damage --------------------------------------
new_session s0
asaki_health_record success
assert_eq "an absent ledger is created without a rebuild stamp" "$(field .last_rebuilt_at)" "null"
rm -f "$HEALTH_FILE"

# --- failures accumulate, failing_since is stamped once ---------------------------------------
new_session s1
asaki_health_record failure "http-500"
FIRST_SINCE=$(field .failing_since)
asaki_health_record failure "http-502"
asaki_health_record failure "classifier-1"
assert_eq "three failures counted" "$(field .consecutive_failures)" "3"
assert_eq "failing_since is stamped on the 0→1 transition only" "$(field .failing_since)" "$FIRST_SINCE"
assert_eq "the latest error code wins" "$(field .last_error_code)" "classifier-1"

# --- one success clears the run ---------------------------------------------------------------
asaki_health_record success
assert_eq "a success zeroes the run" "$(field .consecutive_failures)" "0"
assert_eq "a success clears failing_since" "$(field .failing_since)" "null"
CHECKS=$((CHECKS + 1))
[ "$(field .last_success_at)" != "null" ] || fail "a success stamps last_success_at"
assert_eq "the last error is kept for diagnosis" "$(field .last_error_code)" "classifier-1"

# --- idle counting is per SESSION, not per turn ------------------------------------------------
asaki_health_record success
new_session s2
asaki_health_session_idle
asaki_health_session_idle
asaki_health_session_idle
assert_eq "a whole quiet session counts once" "$(field .sessions_since_last_candidate)" "1"
new_session s3
asaki_health_session_idle
assert_eq "a second quiet session counts again" "$(field .sessions_since_last_candidate)" "2"

# --- a candidate resets the counter and immunises the rest of its session ----------------------
new_session s4
asaki_health_session_candidate
assert_eq "a candidate resets the idle counter" "$(field .sessions_since_last_candidate)" "0"
asaki_health_session_idle
assert_eq "a later quiet turn in a productive session does not count" "$(field .sessions_since_last_candidate)" "0"

# A session that counted itself idle and THEN produces a candidate must end at 0, not 1.
new_session s5
asaki_health_session_idle
assert_eq "the quiet session incremented first" "$(field .sessions_since_last_candidate)" "1"
asaki_health_session_candidate
assert_eq "the candidate erases its own session's increment" "$(field .sessions_since_last_candidate)" "0"

# --- corruption is repaired once, and the repair is recorded ------------------------------------
printf 'not json {' >"$HEALTH_FILE"
new_session s6
asaki_health_record failure "http-000"
assert_eq "a corrupt ledger is rebuilt from zero" "$(field .consecutive_failures)" "1"
CHECKS=$((CHECKS + 1))
[ "$(field .last_rebuilt_at)" != "null" ] || fail "the rebuild is recorded once"
REBUILT_AT=$(field .last_rebuilt_at)
asaki_health_record failure "http-000"
assert_eq "a healthy write does not re-stamp last_rebuilt_at" "$(field .last_rebuilt_at)" "$REBUILT_AT"

# An empty file (an interrupted writer) is the same recoverable case, not a crash.
: >"$HEALTH_FILE"
asaki_health_record success
assert_eq "an empty ledger recovers" "$(field .consecutive_failures)" "0"

# --- atomicity: no .tmp debris is left behind ---------------------------------------------------
assert_eq "no temp files survive a write" "$(find "$WORK" -name 'health.json.tmp.*' | wc -l | tr -d ' ')" "0"

# --- concurrent writers: 12 parallel failures must all land, and the file stays valid JSON ------
rm -f "$HEALTH_FILE"
new_session s7
i=0
while [ "$i" -lt 12 ]; do
  ( asaki_health_record failure "http-429" ) &
  i=$((i + 1))
done
wait
CHECKS=$((CHECKS + 1))
jq -e 'type == "object"' "$HEALTH_FILE" >/dev/null 2>&1 || fail "concurrent writers left valid JSON"
assert_eq "every concurrent failure was counted" "$(field .consecutive_failures)" "12"

echo "health-ledger eval: ${CHECKS} checks, ${FAILURES} failure(s)"
[ "$FAILURES" -eq 0 ] || exit 1
