#!/usr/bin/env bash
# Regression eval for extractMemoryCandidates() (src/services/extraction.ts).
#
# Unlike eval-candidates.ts (pure heuristicDecision(), no LLM call, runs offline instantly),
# extraction is inherently LLM-based — env.AI.run() only works inside a real Worker runtime.
# So this hits a live Worker over HTTP instead: defaults to production, or point it at
# `wrangler dev --remote` via ASAKI_MEMORY_BASE_URL for pre-deploy testing. Every case that
# expects candidates writes a real memory (test user, auto-cleaned at the end) since
# /v1/memories/extract always runs its output through the dedup pipeline.
#
# Each fixture case in test/fixtures/extraction-cases.json is a real production false positive/
# negative this project has hit — add a new case here whenever a future one turns up.
set -uo pipefail

BASE_URL="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-https://asaki-memory-manager.wangyao1414114wy.workers.dev}}"
API_KEY="${ASAKI_MEMORY_API_KEY:-${ADMIN_API_KEY:-}}"
if [ -z "$API_KEY" ]; then
  echo "ASAKI_MEMORY_API_KEY (or ADMIN_API_KEY) must be set." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/test/fixtures/extraction-cases.json"
TEST_USER="eval-extraction-$(date +%s)-$$"
PROJECT_ID="eval-extraction"

PASS=0
FAIL=0
FAILURES=()

cleanup() {
  for SCOPE in global project; do
    if [ "$SCOPE" = "project" ]; then
      IDS=$(curl -s -X POST "$BASE_URL/v1/memories/list" \
        -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
        -d "$(jq -cn --arg user "$TEST_USER" --arg proj "$PROJECT_ID" '{user_id:$user, limit:50, scope:"project", project_id:$proj}')" | jq -r '.memories[]?.id')
    else
      IDS=$(curl -s -X POST "$BASE_URL/v1/memories/list" \
        -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
        -d "$(jq -cn --arg user "$TEST_USER" '{user_id:$user, limit:50, scope:"global"}')" | jq -r '.memories[]?.id')
    fi
    for id in $IDS; do
      curl -s -X DELETE "$BASE_URL/v1/memories/$id" \
        -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
        -d "$(jq -cn --arg user "$TEST_USER" '{user_id:$user}')" >/dev/null
    done
  done
}
trap cleanup EXIT

CASE_COUNT=$(jq 'length' "$FIXTURES")
for i in $(seq 0 $((CASE_COUNT - 1))); do
  CASE=$(jq -c ".[$i]" "$FIXTURES")
  NAME=$(echo "$CASE" | jq -r '.name')
  TEXT=$(echo "$CASE" | jq -r '.text')
  EXPECT_EMPTY=$(echo "$CASE" | jq -r '.expectEmpty')

  RESP=$(curl -s -X POST "$BASE_URL/v1/memories/extract" \
    -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg text "$TEXT" --arg user "$TEST_USER" --arg project "$PROJECT_ID" \
      '{text:$text, user_id:$user, project_id:$project, source:"eval-extraction"}')")
  COUNT=$(echo "$RESP" | jq '.decisions | length' 2>/dev/null)

  if [ -z "$COUNT" ] || [ "$COUNT" = "null" ]; then
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: request failed or malformed response: $RESP")
    continue
  fi

  if { [ "$EXPECT_EMPTY" = "true" ] && [ "$COUNT" -eq 0 ]; } || { [ "$EXPECT_EMPTY" = "false" ] && [ "$COUNT" -gt 0 ]; }; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: expected $([ "$EXPECT_EMPTY" = "true" ] && echo "empty" || echo "non-empty"), got $COUNT candidate(s)")
  fi
done

echo "extraction eval: ${PASS}/${CASE_COUNT} passed"
if [ "$FAIL" -gt 0 ]; then
  echo "fail:"
  for f in "${FAILURES[@]}"; do
    echo "- $f"
  done
  exit 1
fi
