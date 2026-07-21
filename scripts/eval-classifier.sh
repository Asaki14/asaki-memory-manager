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
  SYSTEM_PROMPT='You are a memory-candidate detector, not a writer. Given a conversation delta, decide if it contains something worth saving as a durable memory, and if so pre-distill it into ready-to-write fields — this hook executes the write itself via HTTP after your response (the server then routes it to a review queue), so make the call carefully here.

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
- "已将变更推送至 origin/main，提交为 8df25dd" -> flag=false (one-off delivery status, not durable memory).
- "Node.js new URL().hostname 对 IPv6 loopback 返回 '[::1]'" -> flag=false (generic technical trivia, not a user/project memory).
- "点点数据的 App 详情页是 JS SPA，WebFetch 抓不到价格，后续改用官方 API" -> flag=true, scope=project (tool/site-specific learning never belongs in global scope).
- "已从 Pi 配置中彻底移除 Ponytail 包、extension、skills 和配置引用" -> flag=true, scope=project (durable current configuration state).
- "type: fix" -> flag=false (vague commit fragment with no self-contained durable fact).
- "Music playing now" -> flag=false (transient UI/runtime status).
- "先强制使用 Chafa；后续确认已支持 Kitty graphics，撤销 Chafa 并恢复 Kgp" -> flag=true, scope=project, but distill only the final Kgp state (superseded intermediate states must not become separate memories).
- "环境变量/API密钥统一存放在 ~/.config/fish/conf.d/api_keys.local.fish" -> flag=true, scope=project (machine-local shell paths belong to the dotfiles project, never global).
- "一次性汇报放 scratchpad，不写入项目仓库" -> flag=true, scope=global (a reusable cross-project delivery preference; keep it concise).
- "周会每项目 3–5 行，与豪哥日报区分；临时汇报放 scratchpad" -> flag=true, scope=project (mentor/reporting-specific conventions do not help in unrelated projects).
- "Claude Code 的交付文本必须放在回合最后，否则后续工具调用可能使文本不展示" -> flag=true, scope=project (app-specific harness behavior is not global).
- "用户希望针对技能和工具进行优化，列出推荐项并决定是否禁用" -> flag=false (an open optimization intention is not a completed decision or durable outcome).
- "paneru 四边 padding 4→10，与 sketchybar 左侧 10px 对齐" -> flag=true, scope=project, and distill the final 10px state rather than the change history.
- A long SketchyBar popup implementation report -> flag=true, scope=project, but compress it to the stable entry point, switching mechanism, and fallback behavior within 300 characters.
- "Claude Design 画布页（.dc.html）不在 DesignSync MCP 文件树里（get_file 404）。浏览器登录态下可直接调 Omelette API：读取 GetFile，写回用 UploadFile，DeleteFile 删文件；大段 HTML 下载用 Blob+anchor，上传方向页内 fetch 后再 SHA-256 对齐本地。" -> flag=false (raw one-off API procedure dump, not an explicit repeat-use convention or established project workflow).
- "用户希望不使用嵌套并复用同一个 herdr 进程和 server" -> flag=false ("不使用嵌套" lacks an object and cannot stand alone).
- "手动拖高 Ghostty 窗口以填补当前布局缺口" -> flag=false (transient manual UI adjustment).

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
  CASE_FAILURES=()
  if [ "$FLAG" != "$EXPECT_FLAG" ]; then
    CASE_FAILURES+=("expected flag=$EXPECT_FLAG, got flag=$FLAG")
  fi

  if [ "$EXPECT_FLAG" = "true" ] && [ "$FLAG" = "true" ]; then
    ACTUAL_TEXT=$(echo "$JSON" | jq -r '.text // ""')
    ACTUAL_TYPE=$(echo "$JSON" | jq -r '.type // ""')
    ACTUAL_SCOPE=$(echo "$JSON" | jq -r '.scope // ""')
    EXPECT_TYPE=$(echo "$CASE" | jq -r '.expectType // empty')
    EXPECT_SCOPE=$(echo "$CASE" | jq -r '.expectScope // empty')
    EXPECT_MAX_TEXT_LENGTH=$(echo "$CASE" | jq -r '.expectMaxTextLength // empty')

    [ -n "$EXPECT_TYPE" ] && [ "$ACTUAL_TYPE" != "$EXPECT_TYPE" ] && CASE_FAILURES+=("expected type=$EXPECT_TYPE, got type=$ACTUAL_TYPE")
    [ -n "$EXPECT_SCOPE" ] && [ "$ACTUAL_SCOPE" != "$EXPECT_SCOPE" ] && CASE_FAILURES+=("expected scope=$EXPECT_SCOPE, got scope=$ACTUAL_SCOPE")
    [ -n "$EXPECT_MAX_TEXT_LENGTH" ] && [ "${#ACTUAL_TEXT}" -gt "$EXPECT_MAX_TEXT_LENGTH" ] && CASE_FAILURES+=("expected text length <= $EXPECT_MAX_TEXT_LENGTH, got ${#ACTUAL_TEXT}")
    while IFS= read -r NEEDLE; do
      [ -n "$NEEDLE" ] && [[ "$ACTUAL_TEXT" != *"$NEEDLE"* ]] && CASE_FAILURES+=("expected text to include '$NEEDLE'")
    done < <(echo "$CASE" | jq -r '.expectTextIncludes[]?')
  fi

  if [ "${#CASE_FAILURES[@]}" -eq 0 ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: $(IFS='; '; echo "${CASE_FAILURES[*]}") (resp: $JSON)")
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
