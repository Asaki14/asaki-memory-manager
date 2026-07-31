#!/usr/bin/env bash
# Offline eval for the two decision machines in integrations/claude-code/stop-extract.sh:
#
#   throttle_decision   — plan §4.5's transition table (T0/T1/T2/T3), including the property that
#                         makes the ceiling hold: an OVERRIDE never moves the window anchor, so a
#                         correction storm cannot replenish its own override budget.
#   outcome_for_status  — plan §9.3's status table (which failure class consumes the transcript
#                         offset and which one holds it) plus the bounded retry budget.
#
# Both are sourced straight out of the hook via its library guard (ASAKI_MEMORY_STOP_EXTRACT_LIB),
# so this eval tests the shipped code, not a copy of it. No network, no model, no Worker.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/test/fixtures/throttle-cases.json"

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

WINDOW_START_FILE="$TMP_DIR/session.window_start"
OVERRIDE_USED_FILE="$TMP_DIR/session.override_used"
LAST_EXTRACT_FILE="$TMP_DIR/session.last_extract"
RETRY_FILE="$TMP_DIR/session.retry"
MAX_DELTA_RETRIES=5

ASAKI_MEMORY_STOP_EXTRACT_LIB=1
export ASAKI_MEMORY_STOP_EXTRACT_LIB
# shellcheck source=../integrations/claude-code/stop-extract.sh
. "$ROOT/integrations/claude-code/stop-extract.sh"

PASS=0
FAIL=0
FAILURES=()

read_state() {
  [ -f "$1" ] && cat "$1" 2>/dev/null || printf ''
}

THROTTLE_COUNT=$(jq '.throttle | length' "$FIXTURES")
for i in $(seq 0 $((THROTTLE_COUNT - 1))); do
  CASE=$(jq -c ".throttle[$i]" "$FIXTURES")
  NAME=$(echo "$CASE" | jq -r '.name')
  [ "$(echo "$CASE" | jq -r '.reset // false')" = "true" ] && rm -f "$WINDOW_START_FILE" "$OVERRIDE_USED_FILE" "$LAST_EXTRACT_FILE"
  PRESET_WINDOW=$(echo "$CASE" | jq -r '.presetWindow // empty')
  PRESET_OVERRIDE=$(echo "$CASE" | jq -r '.presetOverride // empty')
  PRESET_LAST=$(echo "$CASE" | jq -r '.presetLastExtract // empty')
  [ -n "$PRESET_WINDOW" ] && echo "$PRESET_WINDOW" >"$WINDOW_START_FILE"
  [ -n "$PRESET_OVERRIDE" ] && echo "$PRESET_OVERRIDE" >"$OVERRIDE_USED_FILE"
  [ -n "$PRESET_LAST" ] && echo "$PRESET_LAST" >"$LAST_EXTRACT_FILE"

  NOW=$(echo "$CASE" | jq -r '.now')
  INTERVAL=$(echo "$CASE" | jq -r '.interval')
  SIGNAL=$(echo "$CASE" | jq -r '.signal')
  EXPECT=$(echo "$CASE" | jq -r '.expect')
  EXPECT_WINDOW=$(echo "$CASE" | jq -r '.expectWindow // empty')
  EXPECT_OVERRIDE=$(echo "$CASE" | jq -r '.expectOverride // empty')

  ACTUAL=$(throttle_decision "$NOW" "$INTERVAL" "$SIGNAL")
  ACTUAL_WINDOW=$(read_state "$WINDOW_START_FILE")
  ACTUAL_OVERRIDE=$(read_state "$OVERRIDE_USED_FILE")

  CASE_FAILURES=()
  [ "$ACTUAL" != "$EXPECT" ] && CASE_FAILURES+=("expected $EXPECT, got $ACTUAL")
  [ "$ACTUAL_WINDOW" != "$EXPECT_WINDOW" ] && CASE_FAILURES+=("expected window_start='$EXPECT_WINDOW', got '$ACTUAL_WINDOW'")
  [ "$ACTUAL_OVERRIDE" != "$EXPECT_OVERRIDE" ] && CASE_FAILURES+=("expected override_used='$EXPECT_OVERRIDE', got '$ACTUAL_OVERRIDE'")

  if [ "${#CASE_FAILURES[@]}" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("throttle/$NAME: $(IFS='; '; echo "${CASE_FAILURES[*]}")")
  fi
done

STATUS_COUNT=$(jq '.status | length' "$FIXTURES")
for i in $(seq 0 $((STATUS_COUNT - 1))); do
  CASE=$(jq -c ".status[$i]" "$FIXTURES")
  NAME=$(echo "$CASE" | jq -r '.name')
  [ "$(echo "$CASE" | jq -r '.reset // false')" = "true" ] && rm -f "$RETRY_FILE"
  CODE=$(echo "$CASE" | jq -r '.code')
  OFFSET=$(echo "$CASE" | jq -r '.offset')
  EXPECT=$(echo "$CASE" | jq -r '.expect')

  ACTUAL=$(outcome_for_status "$CODE" "$OFFSET")
  if [ "$ACTUAL" = "$EXPECT" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("status/$NAME: expected $EXPECT, got $ACTUAL")
  fi
done

TOTAL=$((THROTTLE_COUNT + STATUS_COUNT))
echo "throttle-state eval: ${PASS}/${TOTAL} passed"
if [ "$FAIL" -gt 0 ]; then
  echo "fail:"
  for f in "${FAILURES[@]}"; do
    echo "- $f"
  done
  exit 1
fi
