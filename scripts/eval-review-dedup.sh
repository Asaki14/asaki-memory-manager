#!/usr/bin/env bash
# Regression eval for the pending-review dedup added to createMemoryReviews()
# (src/services/reviews.ts): a near-duplicate candidate submitted while an earlier one is still
# pending should merge into the existing review row instead of creating a second one. Also covers
# findActiveDuplicate(): a candidate that duplicates an already-`active` memory (not merely
# another pending review) should be skipped entirely, not queued for review. Cases 4-6 cover the
# correction-aware exceptions: corrections and non-corrections never merge into each other, two
# corrections of the same subtype/rule form do, and a merge rewrites the row's `source` column.
#
# Hits a live Worker directly via /v1/memories/reviews (bypasses /v1/memories/extract and its
# LLM call entirely, since this is testing DB-level dedup logic, not extraction quality).
set -uo pipefail

BASE_URL="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-}}"
if [ -z "$BASE_URL" ]; then
  echo "ASAKI_MEMORY_BASE_URL (or ASAKI_MEMORY_API_URL) must be set — no production default." >&2
  exit 1
fi
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
    -d "$(jq -cn --arg user "$TEST_USER" '{user_id:$user, status:"pending", limit:100}')" | jq -r '.reviews[]?.id')
  for id in $IDS; do
    curl -s -X POST "$BASE_URL/v1/memories/reviews/$id/resolve" \
      -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
      -d "$(jq -cn --arg user "$TEST_USER" '{user_id:$user, action:"ignore", reason:"eval cleanup"}')" >/dev/null
  done

  MEM_IDS=$(curl -s -X POST "$BASE_URL/v1/memories/list" \
    -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg user "$TEST_USER" '{user_id:$user, limit:50, scope:"global"}')" | jq -r '.memories[]?.id')
  for id in $MEM_IDS; do
    curl -s -X DELETE "$BASE_URL/v1/memories/$id" \
      -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
      -d "$(jq -cn --arg user "$TEST_USER" '{user_id:$user}')" >/dev/null
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

create_review_count() {
  local content="$1"
  curl -s -X POST "$BASE_URL/v1/memories/reviews" \
    -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg content "$content" --arg user "$TEST_USER" \
      '{candidates:[{content:$content, kind:"preference", importance:0.4, confidence:0.7, scope:"global"}], user_id:$user, source:"eval-review-dedup"}')" \
    | jq '.reviews | length'
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

# Case 3: a candidate duplicating an already-active memory should be skipped, not queued.
ACTIVE_CONTENT="用户偏好周末不回复工作消息"
curl -s -X POST "$BASE_URL/v1/memories" \
  -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
  -d "$(jq -cn --arg content "$ACTIVE_CONTENT" --arg user "$TEST_USER" \
    '{content:$content, user_id:$user, scope:"global", kind:"preference", importance:0.7, confidence:0.9}')" >/dev/null
REVIEW_COUNT=$(create_review_count "$ACTIVE_CONTENT")
if [ "$REVIEW_COUNT" = "0" ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  FAILURES+=("candidate duplicating an active memory should be skipped, got $REVIEW_COUNT review(s) created")
fi

# --- correction-aware dedup -------------------------------------------------------------------
# A correction and the affirmative statement it invalidates score >= 0.5 against each other, so the
# plain lexical merge above would fold a preference and its own negation into one row and keep the
# older evidence. These cases pin the exception.

# Posts one candidate carrying correction-classifier evidence. $2 is the signal ("correction" or
# "none"), $3 the signal_subtype, $4 the supersedes_query, $5 the client source string.
create_correction() {
  local content="$1" signal="$2" subtype="$3" supersedes="$4" source="$5"
  curl -s -X POST "$BASE_URL/v1/memories/reviews" \
    -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg content "$content" --arg user "$TEST_USER" --arg signal "$signal" \
      --arg subtype "$subtype" --arg supersedes "$supersedes" --arg source "$source" \
      '{candidates:[{content:$content, kind:"rule", importance:0.8, confidence:0.7, scope:"global",
                     signal:$signal, signal_subtype:$subtype, rule_form:"prohibition",
                     antecedent_source:"prose", supersedes_query:$supersedes,
                     correction:{agent_did:"用了 npm", captain_verdict:"别再用 npm 了", redirect_target:"改用 pnpm"}}],
        user_id:$user, source:$source}')"
}

review_field() {
  local id="$1" filter="$2"
  curl -s -X POST "$BASE_URL/v1/memories/reviews/list" \
    -H "Authorization: Bearer ${API_KEY}" -H "Content-Type: application/json" \
    -d "$(jq -cn --arg user "$TEST_USER" '{user_id:$user, status:"pending", limit:100}')" \
    | jq -r --arg id "$id" ".reviews[] | select(.id == \$id) | $filter"
}

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$label: expected '$expected', got '$actual'")
  fi
}

# Case 4: affirmative pending review, then its correction — two rows, and the correction row links
# back to the row it contradicts instead of merging into it.
ID_AFF=$(create_correction "部署脚本自动跳过测试步骤" "none" "" "" "eval-review-dedup" | jq -r '.reviews[0].id')
ID_COR=$(create_correction "部署脚本不要自动跳过测试步骤" "correction" "explicit_negation" "部署脚本自动跳过测试步骤" "eval-review-dedup" | jq -r '.reviews[0].id')
if [ -n "$ID_COR" ] && [ "$ID_COR" != "$ID_AFF" ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  FAILURES+=("a correction must not merge into a non-correction pending review, got id_aff=$ID_AFF id_cor=$ID_COR")
fi
check "correction row keeps its signal" "correction" "$(review_field "$ID_COR" '.candidate.signal')"
check "correction row keeps its supersedes_query" "部署脚本自动跳过测试步骤" "$(review_field "$ID_COR" '.candidate.supersedes_query')"
check "correction row links the review it contradicts" "$ID_AFF" "$(review_field "$ID_COR" '.candidate.supersedes_pending_review_id')"

# Case 5: correction first, affirmative second — also two rows (a pristine correction row is worth
# more than a compact queue).
ID_COR2=$(create_correction "文档站点不要使用旧的模板渲染" "correction" "explicit_negation" "文档站点使用旧的模板渲染" "eval-review-dedup" | jq -r '.reviews[0].id')
ID_AFF2=$(create_correction "文档站点使用旧的模板渲染" "none" "" "" "eval-review-dedup" | jq -r '.reviews[0].id')
if [ -n "$ID_AFF2" ] && [ "$ID_AFF2" != "$ID_COR2" ]; then
  PASS=$((PASS + 1))
else
  FAIL=$((FAIL + 1))
  FAILURES+=("a non-correction must not merge into a correction pending review, got id_cor=$ID_COR2 id_aff=$ID_AFF2")
fi
check "correction row survives the affirmative follow-up" "correction" "$(review_field "$ID_COR2" '.candidate.signal')"

# Case 6: two corrections of the same subtype and rule form DO merge — into one row carrying the
# newer evidence and the newer client's source, in the column as well as the JSON.
ID_C1=$(create_correction "团队约定不要在周五发布版本" "correction" "override_of_action" "团队在周五发布版本" "eval-review-dedup-old" | jq -r '.reviews[0].id')
ID_C2=$(create_correction "团队约定不要在周五发布版本到生产环境" "correction" "override_of_action" "团队在周五发布版本到生产环境" "eval-review-dedup-new" | jq -r '.reviews[0].id')
check "same-subtype corrections merge into one row" "$ID_C1" "$ID_C2"
check "merged row carries the newer supersedes_query" "团队在周五发布版本到生产环境" "$(review_field "$ID_C1" '.candidate.supersedes_query')"
check "merged row's source column follows the newer evidence" "eval-review-dedup-new" "$(review_field "$ID_C1" '.source')"

echo "review-dedup eval: ${PASS}/$((PASS + FAIL)) passed"
if [ "$FAIL" -gt 0 ]; then
  echo "fail:"
  for f in "${FAILURES[@]}"; do
    echo "- $f"
  done
  exit 1
fi
