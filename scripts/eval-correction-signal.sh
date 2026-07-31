#!/usr/bin/env bash
# Offline eval for the correction pre-gate (plan §4.1, eval E1).
#
# The pattern is NOT a pre-filter on the classifier call — the classifier still sees every delta.
# It is used for exactly two things: the throttle override (§4.5) and the `correction_suspected`
# prompt hint. So the asymmetry in the gates below is deliberate:
#
#   recall on the correction set must be PERFECT — a missed correction is the exact failure this
#   whole feature exists to fix;
#   false triggers on the non-correction set are bounded, not forbidden — one costs a single
#   extra classifier call inside a window §4.5 already caps at 2 calls, and no write at all.
#
# Both copies are exercised and must agree per case: CORRECTION_SIGNAL_PATTERN in
# integrations/claude-code/stop-extract.sh (sourced through its library guard) and
# CORRECTION_SIGNAL_RE in integrations/pi/asaki-memory.ts. No network, no model, no Worker.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/test/fixtures/correction-signal-cases.json"
MAX_FALSE_TRIGGERS=2

ASAKI_MEMORY_STOP_EXTRACT_LIB=1
export ASAKI_MEMORY_STOP_EXTRACT_LIB
# shellcheck source=../integrations/claude-code/stop-extract.sh
. "$ROOT/integrations/claude-code/stop-extract.sh"

# Pi verdicts, one per fixture case, in fixture order.
PI_VERDICTS=$(cd "$ROOT" && node --experimental-strip-types --no-warnings -e '
import { readFileSync } from "node:fs";
const { loadPiTraceBuilder } = await import("./scripts/pi-trace-region.mjs");
const { module: pi, dispose } = await loadPiTraceBuilder();
const cases = JSON.parse(readFileSync("test/fixtures/correction-signal-cases.json", "utf8"));
for (const item of cases) console.log(pi.CORRECTION_SIGNAL_RE.test(item.text) ? "true" : "false");
dispose();
')

if [ -z "$PI_VERDICTS" ]; then
  echo "failed to evaluate CORRECTION_SIGNAL_RE from the Pi extension (see errors above)." >&2
  exit 1
fi

PASS=0
FAIL=0
FAILURES=()
CORRECTION_TOTAL=0
CORRECTION_HITS=0
NON_CORRECTION_TOTAL=0
FALSE_TRIGGERS=0

CASE_COUNT=$(jq 'length' "$FIXTURES")
for i in $(seq 0 $((CASE_COUNT - 1))); do
  CASE=$(jq -c ".[$i]" "$FIXTURES")
  NAME=$(echo "$CASE" | jq -r '.name')
  TEXT=$(echo "$CASE" | jq -r '.text')
  IS_CORRECTION=$(echo "$CASE" | jq -r '.correction')
  EXPECT=$(echo "$CASE" | jq -r '.expectMatch')

  if printf '%s' "$TEXT" | grep -qiE -e "$CORRECTION_SIGNAL_PATTERN"; then
    SHELL_MATCH=true
  else
    SHELL_MATCH=false
  fi
  PI_MATCH=$(echo "$PI_VERDICTS" | sed -n "$((i + 1))p")

  if [ "$IS_CORRECTION" = "true" ]; then
    CORRECTION_TOTAL=$((CORRECTION_TOTAL + 1))
    [ "$SHELL_MATCH" = "true" ] && CORRECTION_HITS=$((CORRECTION_HITS + 1))
  else
    NON_CORRECTION_TOTAL=$((NON_CORRECTION_TOTAL + 1))
    [ "$SHELL_MATCH" = "true" ] && FALSE_TRIGGERS=$((FALSE_TRIGGERS + 1))
  fi

  if [ "$SHELL_MATCH" = "$EXPECT" ] && [ "$PI_MATCH" = "$EXPECT" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: expected match=$EXPECT, got stop-extract=$SHELL_MATCH pi=$PI_MATCH")
  fi
done

echo "correction-signal eval: ${PASS}/${CASE_COUNT} passed"
echo "recall on corrections: ${CORRECTION_HITS}/${CORRECTION_TOTAL} (gate: all)"
echo "false triggers on non-corrections: ${FALSE_TRIGGERS}/${NON_CORRECTION_TOTAL} (gate: <= ${MAX_FALSE_TRIGGERS})"

if [ "$CORRECTION_HITS" -lt "$CORRECTION_TOTAL" ]; then
  FAIL=$((FAIL + 1))
  FAILURES+=("recall gate: ${CORRECTION_HITS}/${CORRECTION_TOTAL} corrections detected, all are required")
fi
if [ "$FALSE_TRIGGERS" -gt "$MAX_FALSE_TRIGGERS" ]; then
  FAIL=$((FAIL + 1))
  FAILURES+=("false-trigger gate: ${FALSE_TRIGGERS} > ${MAX_FALSE_TRIGGERS}")
fi

if [ "$FAIL" -gt 0 ]; then
  echo "fail:"
  for f in "${FAILURES[@]}"; do
    echo "- $f"
  done
  exit 1
fi
