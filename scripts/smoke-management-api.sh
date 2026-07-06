#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8788}"
BASE_URL="http://127.0.0.1:${PORT}"
LOG_FILE="${TMPDIR:-/tmp}/asaki-memory-smoke-${PORT}.log"
USER_ID="smoke-user-$(date +%s)-$$"
PROJECT_ID="smoke-project"
CONTENT="smoke memory $(date +%s)"
UPDATED_CONTENT="${CONTENT} updated"
curl_api() {
  if [[ -n "${ADMIN_API_KEY:-}" ]]; then
    curl -fsS -H "Authorization: Bearer ${ADMIN_API_KEY}" "$@"
  else
    curl -fsS "$@"
  fi
}

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
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
npx wrangler dev --local --ip 127.0.0.1 --port "$PORT" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

for _ in {1..40}; do
  if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -fsS "$BASE_URL/health" >/dev/null

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

EXTRACT_VALIDATION_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/memories/extract" \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"some raw text\"}")
[[ "$EXTRACT_VALIDATION_STATUS" == "400" ]] || { echo "expected 400 for extract without user_id, got ${EXTRACT_VALIDATION_STATUS}"; exit 1; }

EXTRACT_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/extract" \
  -H 'Content-Type: application/json' \
  -d "{\"text\":\"raw conversation snippet for smoke test\",\"user_id\":\"${USER_ID}\",\"scope\":\"project\",\"project_id\":\"${PROJECT_ID}\"}")
printf '%s' "$EXTRACT_RESPONSE" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); if (!Array.isArray(j.decisions) || typeof j.extracted_count !== "number") process.exit(1); });'

echo "management API smoke passed: ${MEMORY_ID}; review smoke passed: ${REVIEW_ID}; extract smoke passed"
