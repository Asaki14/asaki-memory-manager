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

# Failed-side-effect regression: resolving with a memory_id that doesn't exist must fail (404)
# without leaving the review permanently stuck "resolved" — resolveMemoryReview()'s atomic claim
# now rolls the row back to pending on any side-effect failure so it stays retryable.
FAILRESOLVE_REVIEW_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/reviews" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"project_id\":\"${PROJECT_ID}\",\"source\":\"smoke-review-failure\",\"candidates\":[{\"content\":\"failure rollback candidate ${CONTENT}\",\"scope\":\"project\",\"kind\":\"task_learning\",\"importance\":0.1,\"confidence\":0.9}]}")
FAILRESOLVE_REVIEW_ID=$(printf '%s' "$FAILRESOLVE_REVIEW_RESPONSE" | json_value 'reviews.0.id')
FAILRESOLVE_STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE_URL/v1/memories/reviews/${FAILRESOLVE_REVIEW_ID}/resolve" \
  -H "Authorization: Bearer ${ADMIN_API_KEY}" -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"action\":\"merge\",\"memory_id\":\"does-not-exist\",\"reason\":\"smoke test\"}")
[[ "$FAILRESOLVE_STATUS" == "404" ]] || { echo "expected 404 for resolve with a missing target memory_id, got ${FAILRESOLVE_STATUS}"; exit 1; }
FAILRESOLVE_LIST_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/reviews/list" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"project_id\":\"${PROJECT_ID}\",\"status\":\"pending\"}")
printf '%s' "$FAILRESOLVE_LIST_RESPONSE" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); if (!j.reviews?.some((review) => review.id === process.argv[1] && review.status === "pending")) process.exit(1); });' "$FAILRESOLVE_REVIEW_ID"
curl_api -X POST "$BASE_URL/v1/memories/reviews/${FAILRESOLVE_REVIEW_ID}/resolve" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"action\":\"ignore\",\"reason\":\"smoke test cleanup\"}" >/dev/null

# Concurrent-resolve regression: N requests racing to resolve the same review must not all
# run the add/merge/update/delete side effects. resolveMemoryReview() now folds the
# "still pending?" check and the resolved-status write into a single atomic UPDATE
# (WHERE status = 'pending'), so only one of many simultaneous resolves can win the row.
# Fire all N requests from one already-running Node process via Promise.all(fetch...) so they
# dispatch within the same tick (verified via timing: all N land within ~1-2ms of each other,
# vs. spawning N separate `curl` processes, whose own fork/exec/DNS/connect overhead serializes
# requests enough that they never overlap). Note: local `wrangler dev` has no real AI/Vectorize
# credentials (both report "not supported" locally), so createMemory() never actually performs
# genuine async I/O here — every promise in the request settles via microtasks with no macrotask
# yield, so even fully-simultaneous dispatch mostly can't reproduce the interleaving that's
# possible in production D1 (real network round-trips). This assertion is still meaningful as a
# safety net (exactly one winner, even under maximum local contention) and directly exercises the
# atomic `UPDATE ... WHERE status = 'pending'` guard that SQLite enforces at the storage layer.
CONCURRENT_CONTENT="concurrency review candidate ${CONTENT}"
CONCURRENT_REVIEW_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/reviews" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"project_id\":\"${PROJECT_ID}\",\"source\":\"smoke-review-concurrency\",\"candidates\":[{\"content\":\"${CONCURRENT_CONTENT}\",\"scope\":\"project\",\"kind\":\"task_learning\",\"importance\":0.1,\"confidence\":0.9}]}")
CONCURRENT_REVIEW_ID=$(printf '%s' "$CONCURRENT_REVIEW_RESPONSE" | json_value 'reviews.0.id')

CONCURRENT_N=16
CONCURRENT_RESULT=$(node -e '
const [baseUrl, adminApiKey, userId, reviewId, n] = process.argv.slice(1);
(async () => {
  const requests = Array.from({ length: Number(n) }, (_, i) =>
    fetch(`${baseUrl}/v1/memories/reviews/${reviewId}/resolve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, action: "add", reason: `concurrency race ${i}` }),
    }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
  );
  const results = await Promise.all(requests);
  console.log(JSON.stringify(results));
})();
' "$BASE_URL" "$ADMIN_API_KEY" "$USER_ID" "$CONCURRENT_REVIEW_ID" "$CONCURRENT_N")

set +e
CONCURRENT_SUCCESS_COUNT=$(printf '%s' "$CONCURRENT_RESULT" | node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const results = JSON.parse(s);
  for (const r of results) {
    const ok2xx = r.status >= 200 && r.status < 300;
    const looksResolved = ok2xx && r.body?.review?.status === "resolved" && !!r.body?.memory;
    if (ok2xx && !looksResolved) {
      console.error(`concurrent resolve returned ${r.status} but body lacks resolved review + memory: ${JSON.stringify(r.body)}`);
      process.exit(2);
    }
    if (!ok2xx && !r.body?.error) {
      console.error(`concurrent resolve failed with ${r.status} but body has no error: ${JSON.stringify(r.body)}`);
      process.exit(2);
    }
  }
  console.log(results.filter((r) => r.status >= 200 && r.status < 300).length);
});
')
CONCURRENT_EXIT=$?
set -e
[[ "$CONCURRENT_EXIT" == "0" ]] || { echo "concurrent resolve responses failed shape validation: $CONCURRENT_RESULT"; exit 1; }
[[ "$CONCURRENT_SUCCESS_COUNT" == "1" ]] || { echo "expected exactly one of ${CONCURRENT_N} concurrent resolves to succeed, got ${CONCURRENT_SUCCESS_COUNT}: $CONCURRENT_RESULT"; exit 1; }

CONCURRENT_LIST_RESPONSE=$(curl_api -X POST "$BASE_URL/v1/memories/list" \
  -H 'Content-Type: application/json' \
  -d "{\"user_id\":\"${USER_ID}\",\"project_id\":\"${PROJECT_ID}\"}")
CONCURRENT_MATCH_COUNT=$(printf '%s' "$CONCURRENT_LIST_RESPONSE" | node -e 'let s=""; process.stdin.on("data", d => s += d).on("end", () => { const j = JSON.parse(s); const needle = process.argv[1]; console.log((j.memories ?? []).filter(m => m.content === needle && m.status === "active").length); });' "$CONCURRENT_CONTENT")
[[ "$CONCURRENT_MATCH_COUNT" == "1" ]] || { echo "expected exactly 1 memory from the concurrent add-resolve race, got ${CONCURRENT_MATCH_COUNT}"; exit 1; }

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
