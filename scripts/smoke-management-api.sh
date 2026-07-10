#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8788}"
NOAUTH_PORT="${NOAUTH_PORT:-8789}"
BASE_URL="http://127.0.0.1:${PORT}"
NOAUTH_BASE_URL="http://127.0.0.1:${NOAUTH_PORT}"
LOG_FILE="${TMPDIR:-/tmp}/asaki-memory-smoke-${PORT}.log"
NOAUTH_LOG_FILE="${TMPDIR:-/tmp}/asaki-memory-smoke-${NOAUTH_PORT}.log"
ADMIN_API_KEY="${ADMIN_API_KEY:-smoke-$(date +%s)-$$}"
USER_ID="smoke-user-$(date +%s)-$$"
PROJECT_ID="smoke-project"
CONTENT="smoke memory $(date +%s)"
UPDATED_CONTENT="${CONTENT} updated"
curl_api() {
  curl -fsS -H "Authorization: Bearer ${ADMIN_API_KEY}" "$@"
}

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
  if [[ -n "${NOAUTH_SERVER_PID:-}" ]]; then
    kill "${NOAUTH_SERVER_PID}" >/dev/null 2>&1 || true
    wait "${NOAUTH_SERVER_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

json_value() {
  node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); const path = process.argv[1].split("."); let v = j; for (const key of path) v = v?.[key]; if (v == null) process.exit(1); console.log(v); });' "$1"
}

assert_json() {
  local script="$1"
  node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); const id = process.argv[1]; const script = process.argv[2]; if (!Function("j", "id", `return (${script});`)(j, id)) process.exit(1); });' "$MEMORY_ID" "$script"
}

npm run db:migrate:local >/dev/null
npx wrangler dev --local --ip 127.0.0.1 --port "$PORT" --var "ADMIN_API_KEY:${ADMIN_API_KEY}" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

for _ in {1..40}; do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -fsS "$BASE_URL/health" >/dev/null

npx wrangler dev --local --ip 127.0.0.1 --port "$NOAUTH_PORT" >"$NOAUTH_LOG_FILE" 2>&1 &
NOAUTH_SERVER_PID=$!

for _ in {1..40}; do
  if curl -fsS "$NOAUTH_BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -fsS "$NOAUTH_BASE_URL/health" >/dev/null

NOAUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$NOAUTH_BASE_URL/v1/memories/list" \
  -H 'Content-Type: application/json' \
  -d '{"user_id":"smoke-noauth"}')
[[ "$NOAUTH_STATUS" == "503" ]] || { echo "expected 503 for /v1/* with ADMIN_API_KEY unset, got ${NOAUTH_STATUS}"; exit 1; }
kill "${NOAUTH_SERVER_PID}" >/dev/null 2>&1 || true
wait "${NOAUTH_SERVER_PID}" >/dev/null 2>&1 || true
unset NOAUTH_SERVER_PID

SECRET_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/memories" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" -H 'Content-Type: application/json' \
  -d "{\"content\":\"my key is sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890\",\"user_id\":\"${USER_ID}\",\"scope\":\"project\",\"project_id\":\"${PROJECT_ID}\"}")
[[ "$SECRET_STATUS" == "400" ]] || { echo "expected 400 for content containing a secret, got ${SECRET_STATUS}"; exit 1; }

CREATE_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories" \
  -H 'Content-Type: application/json' \
  -d "{\"content\":\"${CONTENT}\",\"user_id\":\"${USER_ID}\",\"scope\":\"project\",\"project_id\":\"${PROJECT_ID}\",\"kind\":\"decision\",\"importance\":0.8,\"confidence\":0.9}")
MEMORY_ID=$(printf '%s' "$CREATE_RESPONSE" | json_value 'memory.id')

LIST_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/list" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"project_id\":\"${PROJECT_ID}\"}")
printf '%s' "$LIST_RESPONSE" | assert_json 'j.memories.some(m => m.id === id && m.status === "active")'

GET_RESPONSE=$(curl_api "$BASE_URL/v1/memories/${MEMORY_ID}?user_id=${USER_ID}")
printf '%s' "$GET_RESPONSE" | assert_json 'j.memory.id === id && j.memory.content.length > 0'

UPDATE_RESPONSE=$(curl_api -X PATCH "$BASE_URL/v1/memories/${MEMORY_ID}" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"content\":\"${UPDATED_CONTENT}\"}")
printf '%s' "$UPDATE_RESPONSE" | assert_json 'j.memory.id === id && j.memory.content.endsWith(" updated")'

DELETE_RESPONSE=$(curl_api -X DELETE "$BASE_URL/v1/memories/${MEMORY_ID}" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\"}")
printf '%s' "$DELETE_RESPONSE" | assert_json 'j.memory.id === id && j.memory.status === "deleted"'

PURGE_CREATE_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories" \
  -H 'Content-Type: application/json' \
  -d "{\"content\":\"leaked-looking content to purge ${CONTENT}\",\"user_id\":\"${USER_ID}\",\"scope\":\"project\",\"project_id\":\"${PROJECT_ID}\"}")
PURGE_MEMORY_ID=$(printf '%s' "$PURGE_CREATE_RESPONSE" | json_value 'memory.id')
PURGE_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/${PURGE_MEMORY_ID}/purge" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"reason\":\"smoke test\"}")
printf '%s' "$PURGE_RESPONSE" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); if (j.memory?.status !== "deleted" || j.memory?.content !== "[purged]") process.exit(1); });'
PURGE_GET_RESPONSE=$(curl_api "$BASE_URL/v1/memories/${PURGE_MEMORY_ID}?user_id=${USER_ID}")
printf '%s' "$PURGE_GET_RESPONSE" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); if (j.memory?.content !== "[purged]") process.exit(1); });'

REVIEW_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/reviews" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"project_id\":\"${PROJECT_ID}\",\"source\":\"smoke-review\",\"candidates\":[{\"content\":\"review candidate ${CONTENT}\",\"scope\":\"project\",\"kind\":\"task_learning\",\"importance\":0.1,\"confidence\":0.9}]}")
REVIEW_ID=$(printf '%s' "$REVIEW_RESPONSE" | json_value 'reviews.0.id')

REVIEW_LIST_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/reviews/list" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"project_id\":\"${PROJECT_ID}\",\"status\":\"pending\"}")
printf '%s' "$REVIEW_LIST_RESPONSE" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); if (!j.reviews?.some((review) => review.id === process.argv[1] && review.status === "pending")) process.exit(1); });' "$REVIEW_ID"

RESOLVE_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/reviews/${REVIEW_ID}/resolve" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"action\":\"ignore\",\"reason\":\"smoke test\"}")
printf '%s' "$RESOLVE_RESPONSE" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); if (j.review?.status !== "resolved" || j.review?.resolved_action !== "ignore") process.exit(1); });'

# Concurrent-resolve regression: two requests racing to resolve the same review must not both
# run the add/merge/update/delete side effects. resolveMemoryReview() now folds the
# "still pending?" check and the resolved-status write into a single atomic UPDATE
# (WHERE status = 'pending'), so only one of two simultaneous resolves can win the row.
CONCURRENT_CONTENT="concurrency review candidate ${CONTENT}"
CONCURRENT_REVIEW_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/reviews" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"project_id\":\"${PROJECT_ID}\",\"source\":\"smoke-review-concurrency\",\"candidates\":[{\"content\":\"${CONCURRENT_CONTENT}\",\"scope\":\"project\",\"kind\":\"task_learning\",\"importance\":0.1,\"confidence\":0.9}]}")
CONCURRENT_REVIEW_ID=$(printf '%s' "$CONCURRENT_REVIEW_RESPONSE" | json_value 'reviews.0.id')

CONCURRENT_DIR=$(mktemp -d)
set +e
(
  curl -s -o "${CONCURRENT_DIR}/resp1.json" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${ADMIN_API_KEY}" -H 'Content-Type: application/json' \
    "$BASE_URL/v1/memories/reviews/${CONCURRENT_REVIEW_ID}/resolve" \
    -d "{\"user_id\":\"${USER_ID}\",\"action\":\"add\",\"reason\":\"concurrency race A\"}" \
    > "${CONCURRENT_DIR}/status1.txt"
) &
CONCURRENT_PID1=$!
(
  curl -s -o "${CONCURRENT_DIR}/resp2.json" -w '%{http_code}' -X POST \
    -H "Authorization: Bearer ${ADMIN_API_KEY}" -H 'Content-Type: application/json' \
    "$BASE_URL/v1/memories/reviews/${CONCURRENT_REVIEW_ID}/resolve" \
    -d "{\"user_id\":\"${USER_ID}\",\"action\":\"add\",\"reason\":\"concurrency race B\"}" \
    > "${CONCURRENT_DIR}/status2.txt"
) &
CONCURRENT_PID2=$!
wait "$CONCURRENT_PID1"
wait "$CONCURRENT_PID2"
set -e

CONCURRENT_SUCCESS_COUNT=0
for i in 1 2; do
  status="$(cat "${CONCURRENT_DIR}/status${i}.txt")"
  body_file="${CONCURRENT_DIR}/resp${i}.json"
  if [[ "$status" =~ ^2 ]]; then
    if node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); if (j.review?.status !== "resolved" || !j.memory) process.exit(1); });' < "$body_file"; then
      CONCURRENT_SUCCESS_COUNT=$((CONCURRENT_SUCCESS_COUNT + 1))
    else
      echo "concurrent resolve request ${i} returned ${status} but body lacks resolved review + memory: $(cat "$body_file")"
      exit 1
    fi
  else
    node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); if (!j.error) process.exit(1); });' < "$body_file" \
      || { echo "concurrent resolve request ${i} failed with ${status} but body has no error: $(cat "$body_file")"; exit 1; }
  fi
done
[[ "$CONCURRENT_SUCCESS_COUNT" == "1" ]] || { echo "expected exactly one concurrent resolve to succeed, got ${CONCURRENT_SUCCESS_COUNT} (status1=$(cat "${CONCURRENT_DIR}/status1.txt") status2=$(cat "${CONCURRENT_DIR}/status2.txt"))"; exit 1; }

CONCURRENT_LIST_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/list" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"project_id\":\"${PROJECT_ID}\"}")
CONCURRENT_MATCH_COUNT=$(printf '%s' "$CONCURRENT_LIST_RESPONSE" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); const needle = process.argv[1]; console.log((j.memories ?? []).filter(m => m.content === needle && m.status === "active").length); });' "$CONCURRENT_CONTENT")
[[ "$CONCURRENT_MATCH_COUNT" == "1" ]] || { echo "expected exactly 1 memory from the concurrent add-resolve race, got ${CONCURRENT_MATCH_COUNT}"; exit 1; }
rm -rf "$CONCURRENT_DIR"

CLASSIFIER_CANDIDATE_BODY=$(jq -cn --arg user "$USER_ID" --arg project "$PROJECT_ID" --arg content "unsupervised classifier candidate ${CONTENT}" '
  {user_id: $user, source: "pi:agent-end-classifier",
   candidates: [{content: $content, kind: "task_learning", scope: "project", project_id: $project, importance: 0.9, confidence: 0.9}]}')
CLASSIFIER_CANDIDATE_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/candidates" \
  -H 'Content-Type: application/json' \
  -d "$CLASSIFIER_CANDIDATE_BODY")
# An unsupervised classifier source (project scope, high importance — would be auto-add
# eligible for a normal source) must still land in reviews, never decisions.
printf '%s' "$CLASSIFIER_CANDIDATE_RESPONSE" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); if ((j.decisions ?? []).length !== 0 || (j.reviews ?? []).length !== 1) { console.error(s); process.exit(1); } });'
CLASSIFIER_REVIEW_ID=$(printf '%s' "$CLASSIFIER_CANDIDATE_RESPONSE" | json_value 'reviews.0.id')
curl_api -X POST "$BASE_URL/v1/memories/reviews/${CLASSIFIER_REVIEW_ID}/resolve" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"action\":\"ignore\",\"reason\":\"smoke test\"}" >/dev/null

EXTRACT_VALIDATION_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/memories/extract" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" -H 'Content-Type: application/json' \
  -d "{\"text\":\"some raw text\"}")
[[ "$EXTRACT_VALIDATION_STATUS" == "400" ]] || { echo "expected 400 for extract without user_id, got ${EXTRACT_VALIDATION_STATUS}"; exit 1; }

UNAUTH_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/memories/list" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\"}")
[[ "$UNAUTH_STATUS" == "401" ]] || { echo "expected 401 for /v1/* without a valid token, got ${UNAUTH_STATUS}"; exit 1; }

EXTRACT_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/extract" \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"raw conversation snippet for smoke test\",\"user_id\":\"${USER_ID}\",\"scope\":\"project\",\"project_id\":\"${PROJECT_ID}\"}")
printf '%s' "$EXTRACT_RESPONSE" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); if (!Array.isArray(j.decisions) || typeof j.extracted_count !== "number") process.exit(1); });'

echo "management API smoke passed: ${MEMORY_ID}; review smoke passed: ${REVIEW_ID}; extract smoke passed"
