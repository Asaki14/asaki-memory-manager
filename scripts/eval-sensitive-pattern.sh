#!/usr/bin/env bash
# Offline regression check for the client-side pre-send secret gate.
#
# This is the last local line of defense before text (a prompt, a transcript delta) leaves the
# machine to be judged by an external classifier model (Claude/DeepSeek/etc.) — a miss here means
# the sensitive text has already been sent off-machine, not just "stored". Pure regex, run locally,
# no network call — so this eval runs entirely offline against
# test/fixtures/sensitive-pattern-cases.json, no API key or Worker needed.
#
# KEEP IN SYNC: this pattern must match SENSITIVE_PATTERN in integrations/claude-code/stop-extract.sh
# (the copy exercised here — the production code path for the Stop hook). It should also stay
# equivalent to SENSITIVE_RE in integrations/claude-code/user-prompt.sh, SENSITIVE_RE_LIST in
# integrations/pi/asaki-memory.ts and scripts/shadow-run-extraction.ts, and the server-side
# canonical list in src/utils/sensitiveContent.ts; drift against those copies must still be caught
# by comparing the patterns at review time.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/test/fixtures/sensitive-pattern-cases.json"

SENSITIVE_PATTERN='-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b|\bsk-[A-Za-z0-9-]{10,}\b|\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}\b|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bAIza[0-9A-Za-z_-]{20,}\b|\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b|://[^/[:space:]:]+:[^/[:space:]@]{6,}@|\b(api[_-]?key|token|secret|password|passwd|authorization)\b\s*[:=]\s*"?[^"'"'"' ]{8,}|set\s+-gx\s+[[:alnum:]_]*(KEY|TOKEN|SECRET|PASSWORD)[[:alnum:]_]*\s+[^$[:space:]][^[:space:]]{8,}'

PASS=0
FAIL=0
FAILURES=()

CASE_COUNT=$(jq 'length' "$FIXTURES")
for i in $(seq 0 $((CASE_COUNT - 1))); do
  CASE=$(jq -c ".[$i]" "$FIXTURES")
  NAME=$(echo "$CASE" | jq -r '.name')
  TEXT=$(echo "$CASE" | jq -r '.text')
  EXPECT_MATCH=$(echo "$CASE" | jq -r '.expectMatch')

  if printf '%s' "$TEXT" | grep -qiE -- "$SENSITIVE_PATTERN"; then
    MATCHED=true
  else
    MATCHED=false
  fi

  if [ "$MATCHED" = "$EXPECT_MATCH" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: expected match=$EXPECT_MATCH, got match=$MATCHED")
  fi
done

echo "sensitive-pattern eval: ${PASS}/${CASE_COUNT} passed"
if [ "$FAIL" -gt 0 ]; then
  echo "fail:"
  for f in "${FAILURES[@]}"; do
    echo "- $f"
  done
  exit 1
fi
