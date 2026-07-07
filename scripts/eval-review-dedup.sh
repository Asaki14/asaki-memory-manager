#!/usr/bin/env bash
# Regression eval for the pending-review dedup added to createMemoryReviews()
# (src/services/reviews.ts): a near-duplicate candidate submitted while an earlier one is still
# pending should merge into the existing review row instead of creating a second one.
#
# Hits a live Worker directly via /v1/memories/reviews (bypasses /v1/memories/extract and its
# LLM call entirely, since this is testing DB-level dedup logic, not extraction quality).
set -uo pipefail

BASE_URL="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-https://asaki-memory-manager.wangyao1414114wy.workers.dev}}"
API_KEY="${ASAKI_MEMORY_API_KEY:-${ADMIN_API_KEY:-}}"
if [ -z "$API_KEY" ]; then
  echo "ASAKI_MEMORY_API_KEY (or ADMIN_API_KEY) must be set." >&2
  exit 1
fi

TEST_USER="eval-review-dedup-$(date +%s)-$$"
PASS=0
FAIL=0
FAILURES=()

cleanup() {
  IDS=$(curl -s -X POST "$BASE_URL/v1/memories/reviews/list" \
    -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg user "$TEST_USER" '{user_id:$user, status:"pending", limit:50}')" | jq -r '.reviews[]?.id')
  for id in $IDS; do
    curl -s -X POST "$BASE_URL/v1/memories/reviews/$id/resolve" \
      -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
      -d "$(jq -cn --arg user "$TEST_USER" '{user_id:$user, action:"ignore", reason:"eval cleanup"}')" >/dev/null
  done
}
trap cleanup EXIT

create_review() {
  local content="$1"
  curl -s -X POST "$BASE_URL/v1/memories/reviews" \
    -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg content "$content" --arg user "$TEST_USER" \
      '{candidates:[{content:$content, kind:"preference", importance:0.4, confidence:0.7, scope:"global"}], user_id:$user, source:"eval-review-dedup"}')" \
    | jq -r '.reviews[0].id'
}

# Case 1: near-duplicate content submitted twice should merge into one pending review.
ID_A=$(create_review "用户偏好使用 pnpm 管理依赖")
ID_B=$(create_review "用户偏好使用 pnpm 管理依赖，不使用 npm")
if [ -n "$ID_A" ] && [ "$ID_A" = "$ID_B" ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  FAILURES+=("near-duplicate candidates should merge into one review, got id_a=$ID_A id_b=$ID_B")
fi

# Case 2: a genuinely distinct candidate should create a new review, not merge into case 1's.
ID_C=$(create_review "用户偏好周报使用简体中文撰写")
if [ -n "$ID_C" ] && [ "$ID_C" != "$ID_A" ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  FAILURES+=("distinct candidate should create a new review, got id_c=$ID_C (same as id_a=$ID_A)")
fi

echo "review-dedup eval: ${PASS}/$((PASS + FAIL)) passed"
if [ "$FAIL" -gt 0 ]; then
  echo "fail:"
  for f in "${FAILURES[@]}"; do
    echo "- $f"
  done
  exit 1
fi
