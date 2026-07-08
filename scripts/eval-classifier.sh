#!/usr/bin/env bash
# Regression eval for the local Stop-hook memory-candidate classifier
# (the AUTO_EXTRACT=0 branch of integrations/claude-code/stop-extract.sh).
#
# Unlike eval-extract-signal.sh (pure regex, fully offline), the classifier is a real LLM call —
# this hits `claude -p --safe-mode` for real, same as production, so it needs the `claude` CLI
# logged in on this machine. No Worker/API key required; nothing gets written anywhere.
#
# KEEP IN SYNC: the prompt template below must match CLASSIFIER_PROMPT in
# integrations/claude-code/stop-extract.sh. Each fixture case in
# test/fixtures/classifier-cases.json is a real or representative delta — add a new case
# whenever a production false positive/negative turns up.
set -uo pipefail

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found on PATH." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/test/fixtures/classifier-cases.json"
CLASSIFIER_MODEL="${ASAKI_MEMORY_CLASSIFIER_MODEL:-claude-haiku-4-5-20251001}"

PASS=0
FAIL=0
FAILURES=()

CASE_COUNT=$(jq 'length' "$FIXTURES")
for i in $(seq 0 $((CASE_COUNT - 1))); do
  CASE=$(jq -c ".[$i]" "$FIXTURES")
  NAME=$(echo "$CASE" | jq -r '.name')
  TEXT=$(echo "$CASE" | jq -r '.text')
  EXPECT_FLAG=$(echo "$CASE" | jq -r '.expectFlag')

  # KEEP IN SYNC with CLASSIFIER_SYSTEM_PROMPT in stop-extract.sh.
  SYSTEM_PROMPT='You are a memory-candidate detector, not a writer. Given a conversation delta, decide if it contains something worth flagging for the main agent to consider saving as a durable memory: a stated preference, a made decision, a completed bug fix or verified task outcome (look for cues like 已验证/已修复/已确认/根因是/verified/fixed/root cause is), an established rule/convention (以后都/统一用/from now on), or an explicit forget/retract request.
Do NOT flag: questions, chit-chat, one-off commands, hypothetical/illustrative examples or quoted text used only to explain how something works (even if the quoted text itself sounds like a preference), an in-progress/undecided plan, or a routine implementation-progress update within ongoing work.

Two contrastive examples:
- "解决了内存泄漏问题，已验证生效" -> flag=true (a previously-existing problem is now resolved).
- "加了个测试用例，跑了一下全过了" -> flag=false (a routine step of ongoing work, no prior problem being resolved, nothing durable to recall later).

Be conservative: when genuinely unsure, prefer flag=false — a missed candidate falls back to the existing prompt-based reminder, a false alarm costs the main agent one wasted turn.'
  PROMPT=$(printf 'Delta:\n%s' "$TEXT")

  # KEEP IN SYNC with CLASSIFIER_SCHEMA in stop-extract.sh.
  SCHEMA='{"type":"object","properties":{"flag":{"type":"boolean"},"summary":{"type":"string"}},"required":["flag","summary"],"additionalProperties":false}'
  RESP=$(claude -p --safe-mode --tools "" --model "$CLASSIFIER_MODEL" --system-prompt "$SYSTEM_PROMPT" --json-schema "$SCHEMA" "$PROMPT" 2>/dev/null)
  JSON=$(echo "$RESP" | sed -E '/^```/d')

  if ! echo "$JSON" | jq -e . >/dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: response did not parse as JSON: $RESP")
    continue
  fi

  FLAG=$(echo "$JSON" | jq -r '.flag // false')
  if [ "$FLAG" = "$EXPECT_FLAG" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: expected flag=$EXPECT_FLAG, got flag=$FLAG (resp: $JSON)")
  fi
done

echo "classifier eval: ${PASS}/${CASE_COUNT} passed"
if [ "$FAIL" -gt 0 ]; then
  echo "fail:"
  for f in "${FAILURES[@]}"; do
    echo "- $f"
  done
  exit 1
fi
