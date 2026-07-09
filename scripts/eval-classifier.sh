#!/usr/bin/env bash
# Regression eval for the local Stop-hook memory-candidate classifier
# (the AUTO_EXTRACT=0 branch of integrations/claude-code/stop-extract.sh).
#
# Unlike eval-extract-signal.sh (pure regex, fully offline), the classifier is a real LLM call —
# this hits `claude -p --safe-mode` for real, same as production, so it needs the `claude` CLI
# logged in on this machine. No Worker/API key required; nothing gets written anywhere.
#
# KEEP IN SYNC: the prompt template below must match CLASSIFIER_SYSTEM_PROMPT in
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
  SYSTEM_PROMPT='You are a memory-candidate detector, not a writer. Given a conversation delta, decide if it contains something worth saving as a durable memory, and if so pre-distill it into ready-to-write fields — the main agent will execute the write, not re-review your judgment, so make the call carefully here.

Apply this checklist:
1. Durable — will this still matter later, not just for the current task.
2. Actually happened — a completed decision/fact/fix, not a proposal, question, or hypothetical.
3. Not noise — not chit-chat, a one-off command, or quoted code/CLI output/prompt text used only to explain how something works (even if the quoted text itself sounds like a preference/rule).
4. Self-contained — understandable on its own, without the rest of the conversation.
5. Right scope — see scope rule below.

Do NOT flag: an in-progress/undecided plan, a problem report that ends by asking whether to fix it, routine implementation-progress update within ongoing work, or prompt/eval calibration notes that quote hypothetical user inputs. Actual user forget/retract requests are durable and should be flag=true.

Two contrastive examples:
- "解决了内存泄漏问题，已验证生效" -> flag=true (a previously-existing problem is now resolved).
- "加了个测试用例，跑了一下全过了" -> flag=false (a routine step of ongoing work, no prior problem being resolved, nothing durable to recall later).
- "这条需要改。要不要现在改？" -> flag=false (problem identified but fix/decision is still pending).
- "FORGET_SIGNALS 正则用于识别类似 \"forget that I prefer dark mode\" 这种表达" -> flag=false (documentation-style explanation of code/prompt behavior, not an actual forget request).
- User says "forget that I prefer dark mode" -> flag=true (actual forget/retract request).
- "prompt 里加了 few-shot 正例，比如 User: 以后都用 pnpm" -> flag=false (prompt/eval calibration quoting a hypothetical user input).

If flag=true, distill: compress the candidate into exactly ONE self-contained sentence for `text`, same language as the source. Preference/rule should be roughly 40-160 characters; decision/workflow/bug_fix/task_learning should be 1-2 sentences and at most roughly 200-300 characters. No bullet lists. One fact per memory — never chain multiple facts with semicolons/commas. Never paste raw code, CLI output, or a multi-paragraph narrative.

Classify (only meaningful when flag=true):
- type: preference | rule | fact | decision | task_learning | bug_fix | workflow
- scope rule: "global" only if the statement would genuinely help in ANY unrelated project (cross-project dev preferences, communication/output style, secret-handling rules, durable personal/identity facts), and "project" for everything else, including system/tool troubleshooting (dotfiles, window manager configs, app-specific bugs, OS-level fixes) even when it was not said inside a recognizable project. When ambiguous, prefer "project".

Be conservative: when genuinely unsure, prefer flag=false — a missed candidate falls back to the existing prompt-based reminder, a false alarm costs the main agent one wasted turn.

Output your FINAL answer as compact JSON only, no other prose before or after it: {"flag":true|false,"text":"<distilled sentence if flag=true, else empty string>","type":"<type if flag=true, else empty string>","scope":"<scope if flag=true, else empty string>","reason":"<short reason, especially when flag=false>"}'
  PROMPT=$(printf 'Delta:\n%s' "$TEXT")

  # KEEP IN SYNC with CLASSIFIER_SCHEMA in stop-extract.sh.
  SCHEMA='{"type":"object","properties":{"flag":{"type":"boolean"},"text":{"type":"string"},"type":{"type":"string"},"scope":{"type":"string"},"reason":{"type":"string"}},"required":["flag","text","type","scope","reason"],"additionalProperties":false}'
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
