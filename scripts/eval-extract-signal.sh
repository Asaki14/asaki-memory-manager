#!/usr/bin/env bash
# Offline regression check for the client-side pre-extraction signal gate.
#
# Unlike eval-extraction.sh (which hits a live Worker to test the LLM extraction itself), this
# gate is pure regex run locally before any network call — so this eval runs entirely offline
# against test/fixtures/extract-signal-cases.json, no API key or Worker needed.
#
# KEEP IN SYNC: this pattern must match EXTRACT_SIGNAL_PATTERN in
# integrations/claude-code/stop-extract.sh and EXTRACT_SIGNAL_RE in
# integrations/pi/asaki-memory.ts. This script only exercises the bash/grep copy directly (the
# actual production code path for the Stop hook); drift against the TS copy must still be caught
# by comparing the two patterns at review time.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/test/fixtures/extract-signal-cases.json"

EXTRACT_SIGNAL_PATTERN='以后都|以后就|不要再|别再|记住|记得|规则是|统一用|统一使用|根因是|已验证|已修复|已确认|踩坑|决定用|决定是|改用|换成|约定是|复盘|经验是|remember|always|never|from now on|going forward|decided to|decision is|decision was|root cause is|root cause was|already fixed|now fixed|now verified|already verified|learned that|instead of|switch to|switched to|switching to|convention is|the rule is'

PASS=0
FAIL=0
FAILURES=()

CASE_COUNT=$(jq 'length' "$FIXTURES")
for i in $(seq 0 $((CASE_COUNT - 1))); do
  CASE=$(jq -c ".[$i]" "$FIXTURES")
  NAME=$(echo "$CASE" | jq -r '.name')
  TEXT=$(echo "$CASE" | jq -r '.text')
  EXPECT_SIGNAL=$(echo "$CASE" | jq -r '.expectSignal')

  if echo "$TEXT" | grep -qiE "$EXTRACT_SIGNAL_PATTERN"; then
    MATCHED=true
  else
    MATCHED=false
  fi

  if [ "$MATCHED" = "$EXPECT_SIGNAL" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: expected signal=$EXPECT_SIGNAL, got signal=$MATCHED")
  fi
done

echo "extract-signal eval: ${PASS}/${CASE_COUNT} passed"
if [ "$FAIL" -gt 0 ]; then
  echo "fail:"
  for f in "${FAILURES[@]}"; do
    echo "- $f"
  done
  exit 1
fi
