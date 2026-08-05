#!/usr/bin/env bash
# Regression eval for the local Stop-hook memory-candidate classifier
# (the AUTO_EXTRACT=0 branch of integrations/claude-code/stop-extract.sh).
#
# Unlike eval-extract-signal.sh (pure regex, fully offline), the classifier is a real LLM call —
# this hits `claude -p --safe-mode` for real, same as production, so it needs the `claude` CLI
# logged in on this machine. No Worker/API key required; nothing gets written anywhere.
#
# Correction mode is ON by default here (ASAKI_MEMORY_CORRECTION_MODE=0 selects the legacy
# prompt), because the rollout gates in the plan are stated for the correction prompt and the
# 33 pre-correction cases must keep passing under it — that is the zero-regression check.
#
# KEEP IN SYNC: both prompt templates below must match CLASSIFIER_SYSTEM_PROMPT and
# CORRECTION_SYSTEM_PROMPT in integrations/claude-code/stop-extract.sh (and the same two copies
# in integrations/pi/asaki-memory.ts). Each fixture case in test/fixtures/classifier-cases.json
# is a real or representative delta — add a new case whenever a production false
# positive/negative turns up.
set -uo pipefail

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found on PATH." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$ROOT/test/fixtures/classifier-cases.json"
CLASSIFIER_MODEL="${ASAKI_MEMORY_CLASSIFIER_MODEL:-claude-haiku-4-5-20251001}"
CORRECTION_MODE="${ASAKI_MEMORY_CORRECTION_MODE:-1}"

# Rollout gates (plan §10). Percentages are compared in integer hundredths to stay in POSIX sh
# arithmetic.
MIN_CORRECTION_RECALL_PCT=80
MIN_CORRECTION_PRECISION_PCT=90

PASS=0
FAIL=0
FAILURES=()

CORRECTION_TOTAL=0
CORRECTION_TP=0
CORRECTION_FP=0
RULE_FORM_TOTAL=0
RULE_FORM_HIT=0
SUPERSEDES_TOTAL=0
SUPERSEDES_HIT=0
TEMPORAL_TOTAL=0
TEMPORAL_HIT=0
COMPETITION_TOTAL=0
COMPETITION_HIT=0

# KEEP IN SYNC with CLASSIFIER_SYSTEM_PROMPT in stop-extract.sh.
LEGACY_SYSTEM_PROMPT='You are a memory-candidate detector, not a writer. Given a conversation delta, decide if it contains something worth saving as a durable memory, and if so pre-distill it into ready-to-write fields — this hook executes the write itself via HTTP after your response (the server then routes it to a review queue), so make the call carefully here.

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

# KEEP IN SYNC — byte-identical — with CORRECTION_SYSTEM_PROMPT in stop-extract.sh and
# integrations/pi/asaki-memory.ts.
CORRECTION_SYSTEM_PROMPT='You are a memory-candidate detector, not a writer. Given a conversation delta, decide if it contains something worth saving as a durable memory, and if so pre-distill it into ready-to-write fields — the client executes the write itself via HTTP after your response (the server then routes it to a review queue), so make the call carefully here.

PRIORITY: the user correcting the agent outranks everything else. A correction is any turn where the user rejects, reverses, narrows, or explicitly approves what the agent just did. If one delta contains BOTH a correction and an ordinary outcome/preference, emit ONLY the correction — the competitor is dropped, not downgraded. At most one candidate per delta.

Input shape. The delta may contain:
- "User:" / "Assistant:" lines — conversation prose, in transcript order.
- "Tool: <name> <arg>" lines — one line per agent tool call, with paths, URIs and hosts already redacted. Tool results and thinking are never shown to you.
- An optional block that starts with "Prior context (ALREADY PROCESSED — antecedent only, never extract from this block):" and ends at the line "--- current delta below ---". Everything above that delimiter was already processed in an earlier turn: use it ONLY as the antecedent of a correction, and never extract a memory out of it.
- An optional "Prior memory candidate: <text>" line inside that prior block — the memory candidate this classifier proposed last time. A verdict about "那条记忆" / "that memory" refers to it.

Correction reasoning — build the contrast pair BEFORE writing the rule:
1. correction.agent_did — what the agent produced or attempted, taken from assistant prose, a "Tool:" line, the prior block, or the prior memory candidate.
2. correction.captain_verdict — the user words, verbatim, trimmed.
3. correction.redirect_target — what the user pointed to instead (empty for a pure prohibition).

Temporal attribution: agent_did MUST come from a line appearing BEFORE the verdict in reading order. "Tool:" lines appearing AFTER the verdict in the current delta are the agent repairing itself and must never be used as agent_did. If the only candidate action is post-verdict, treat the antecedent as unrecoverable.

If the antecedent cannot be recovered, output flag=false, signal="correction", antecedent_source="none", reason="correction-without-antecedent" — never invent one. This applies ONLY when the user rejects an agent ACTION you cannot find. It does NOT apply to an explicit forget/retract request about an existing memory, rule or prior candidate ("forget that I prefer dark mode", "那条记忆不对") — that request IS its own antecedent, so it is flag=true with rule_form="retract" and needs no agent action at all.

Corrections are the PRIORITY, not the only thing worth saving. A delta with no correction in it is judged exactly as it was before: a completed decision, fix, configuration state or stated preference is flag=true on its own merits and never needs a user verdict, approval or confirmation to qualify. "No correction here" is a reason to fall through to the checklist below, never a reason to answer flag=false. Judge self-containedness on what the sentence itself names — do not demand extra project context it does not need.

Fields:
- signal: correction | preference | outcome | none. Use "preference" for a stated preference/rule with no correction, "outcome" for a completed decision/fix/learning, "none" when flag=false and nothing was detected.
- signal_subtype, only when signal=correction (otherwise empty string):
  - explicit_negation — 不对、不是这样、错了、这不行、no that is wrong, that is not right
  - override_of_action — 不用改了、别改、改回、回到…、还是原来的、撤销、revert, undo that, put it back
  - terse_redirect — 去掉、删掉、换成、直接用、应该是…、use X instead, drop that
  - repeat_complaint — 又…、还是…、说过了、都说了、第几次了、again, I already said
  - approval_after_change — 对了、这样就行、可以了、就这样、yes that is it (EXPLICIT approval only; never mine implicit acceptance)
  - futility_verdict — 何必、没必要、多余、想复杂了、overkill, why bother
- rule_form: prohibition | preference | procedure | retract. Use "retract" for an explicit request to drop or undo an existing memory, rule or prior candidate — including when the user also names a replacement in the same breath (the replacement goes in redirect_target and shapes text; the form stays retract).
- antecedent_source: prose | trace | prior_tail | candidate | none — where agent_did came from. Use "trace" for a "Tool:" line in the current delta, "prior_tail" for anything inside the prior block, "candidate" for the "Prior memory candidate:" line, "prose" for assistant text, "none" when there is no antecedent.
- supersedes_query: an AFFIRMATIVE restatement of the OLD behaviour the new rule retires, phrased the way the old memory would have been written — NOT the new negative rule. Empty string when nothing is being retired.
- Never output importance or confidence. The server derives both from signal and antecedent_source.

Rule phrasing per rule_form:
- prohibition → 不要<动作>（<场景/对象>） / Never <action> when <scope>. The object must be named; an objectless fragment is flag=false.
- preference → <场景>下优先<Y>，不要<X> / Prefer Y over X when <scope>. Name both alternatives.
- procedure → <触发条件>时先<步骤> / When <trigger>, do <step> first.
- retract → still phrased as a usable negative rule, never the bare verdict.

Two invariants:
1. The verdict is never the memory. "不对" / "何必" may appear only in correction.captain_verdict, never in text.
2. The rule must survive the death of the conversation: no 这个 / 该文件 / 上面那版 / 主公说的 in text.

Apply this checklist to every candidate, correction or not:
1. Durable — will this still matter later, not just for the current task.
2. Actually happened — a completed decision/fact/fix, not a proposal, question, or hypothetical.
3. Not noise — not chit-chat, a one-off command, or quoted code/CLI output/prompt text used only to explain how something works (even if the quoted text itself sounds like a preference/rule).
4. Self-contained — understandable on its own, without the rest of the conversation.
5. Right scope — see scope rule below.

Do NOT flag: an in-progress/undecided plan, a problem report that ends by asking whether to fix it, routine implementation-progress update within ongoing work, or prompt/eval calibration notes that quote hypothetical user inputs. Actual user forget/retract requests are durable and should be flag=true.

Correction examples:
- "Tool: bash git commit -m \"wip\"" … "User: 别再自动 commit 了" -> flag=true, signal=correction, signal_subtype=override_of_action, rule_form=prohibition, antecedent_source=trace, text="不要在未获得确认前自动 commit 本仓库的改动".
- "Assistant: 顺手把首页布局重排了" … "User: 回打开前的页面" -> flag=true, signal=correction, signal_subtype=override_of_action, rule_form=prohibition, antecedent_source=prose, text="修改页面时不要顺手重排既有布局，改完后回到用户打开前的页面状态".
- "Assistant: 加了三层缓存做兜底" … "User: 何必" -> flag=true, signal=correction, signal_subtype=futility_verdict, rule_form=preference, antecedent_source=prose, text="没有实测瓶颈时不要预先加多层缓存兜底，先用最简实现".
- "Assistant: 把配置改成 A 方案" … "User: 还是原来的好" -> flag=true, signal=correction, signal_subtype=override_of_action, rule_form=preference, antecedent_source=prose, text="该项目配置保留原方案 B，不要换成 A 方案", supersedes_query="该项目配置改用 A 方案".
- "Prior memory candidate: 每次编辑完成后自动 commit 并推送" … "User: 那条不对" -> flag=true, signal=correction, signal_subtype=explicit_negation, rule_form=retract, antecedent_source=candidate, text="不要在编辑完成后自动 commit 并推送", supersedes_query="每次编辑完成后自动 commit 并推送".
- prior block "Tool: edit src/a.ts" … current delta "User: 不对" then "Tool: edit src/a.ts" -> the antecedent is the PRIOR action (antecedent_source=prior_tail); the post-verdict tool line is the repair and must be ignored.
- "User: 不对" with nothing before it -> flag=false, signal=correction, antecedent_source=none, reason="correction-without-antecedent".
- User says "forget that I prefer dark mode" -> flag=true, signal=correction, rule_form=retract, antecedent_source=prose, supersedes_query="prefers dark mode" (an explicit forget request is never "correction-without-antecedent").
- "Prior memory candidate: Always run the full eval suite before every commit" … "User: that memory is wrong, drop it — only run it before a release" -> flag=true, rule_form=retract (NOT procedure), antecedent_source=candidate, redirect_target="only before a release".
- "User: 这样不会有问题吗？" -> flag=false (a question is not a verdict).
- "Assistant: 我上面那条改错了，已经修回来了" -> flag=false (the agent correcting itself is not a user correction).
- "Tool: bash fm-wake-drain.sh --verify" … "User: 关掉这个自动核查" -> flag=false (a 这个/这次-scoped verdict switches off ONE specific redundant run and is not durable; only widen a verdict into a standing prohibition when the user words themselves generalize, e.g. 别再/以后/每次/again).
- One delta with "Assistant: 已修复登录超时" and "User: 别再自动 commit 了" -> emit ONLY the correction; the fix outcome is dropped.

Non-correction examples (unchanged rules):
- "解决了内存泄漏问题，已验证生效" -> flag=true (a previously-existing problem is now resolved).
- "记忆里漏了缓存过期时间的配置项" … "已经补全，缓存过期时间统一改成 300 秒" -> flag=true (a concrete corrected configuration value is durable; do not demand an extra system/project identifier the sentence does not need).
- "加了个测试用例，跑了一下全过了" -> flag=false (a routine step of ongoing work, no prior problem being resolved, nothing durable to recall later).
- "这条需要改。要不要现在改？" -> flag=false (problem identified but fix/decision is still pending).
- "FORGET_SIGNALS 正则用于识别类似 \"forget that I prefer dark mode\" 这种表达" -> flag=false (documentation-style explanation of code/prompt behavior, not an actual forget request).
- User says "forget that I prefer dark mode" -> flag=true (actual forget/retract request).
- "prompt 里加了 few-shot 正例，比如 User: 以后都用 pnpm" -> flag=false (prompt/eval calibration quoting a hypothetical user input).
- "已将变更推送至 origin/main，提交为 8df25dd" -> flag=false (one-off delivery status, not durable memory).
- "Node.js new URL().hostname 对 IPv6 loopback 返回 [::1]" -> flag=false (generic technical trivia, not a user/project memory).
- "点点数据的 App 详情页是 JS SPA，WebFetch 抓不到价格，后续改用官方 API" -> flag=true, scope=project (tool/site-specific learning never belongs in global scope).
- "已从 Pi 配置中彻底移除 Ponytail 包、extension、skills 和配置引用" -> flag=true, scope=project (durable current configuration state).
- "type: fix" -> flag=false (vague commit fragment with no self-contained durable fact).
- "Music playing now" -> flag=false (transient UI/runtime status).
- "先强制使用 Chafa；后续确认已支持 Kitty graphics，撤销 Chafa 并恢复 Kgp" -> flag=true, scope=project, but distill only the final Kgp state (superseded intermediate states must not become separate memories).
- "环境变量/API密钥统一存放在 ~/.config/fish/conf.d/api_keys.local.fish" -> flag=true, scope=project (machine-local shell paths belong to the dotfiles project, never global).
- "一次性汇报放 scratchpad，不写入项目仓库" -> flag=true, scope=global (where one-off artifacts go is a reusable cross-project delivery preference, so it stays global even though the sentence mentions 项目仓库; keep it concise).
- "周会每项目 3–5 行，与豪哥日报区分；临时汇报放 scratchpad" -> flag=true, scope=project (mentor/reporting-specific conventions do not help in unrelated projects).
- "Claude Code 的交付文本必须放在回合最后，否则后续工具调用可能使文本不展示" -> flag=true, scope=project (app-specific harness behavior is not global).
- "用户希望针对技能和工具进行优化，列出推荐项并决定是否禁用" -> flag=false (an open optimization intention is not a completed decision or durable outcome).
- "paneru 四边 padding 4→10，与 sketchybar 左侧 10px 对齐" -> flag=true, scope=project, and distill the final 10px state rather than the change history.
- A long SketchyBar popup implementation report -> flag=true, scope=project, but compress it to the stable entry point, switching mechanism, and fallback behavior within 300 characters.
- "Claude Design 画布页（.dc.html）不在 DesignSync MCP 文件树里（get_file 404）。浏览器登录态下可直接调 Omelette API：读取 GetFile，写回用 UploadFile，DeleteFile 删文件；大段 HTML 下载用 Blob+anchor，上传方向页内 fetch 后再 SHA-256 对齐本地。" -> flag=false (raw one-off API procedure dump, not an explicit repeat-use convention or established project workflow).
- "用户希望不使用嵌套并复用同一个 herdr 进程和 server" -> flag=false ("不使用嵌套" lacks an object and cannot stand alone).
- "手动拖高 Ghostty 窗口以填补当前布局缺口" -> flag=false (transient manual UI adjustment).

If flag=true, distill: compress the candidate into exactly ONE self-contained sentence for text, same language as the source. Preference/rule should be roughly 40-160 characters; decision/workflow/bug_fix/task_learning should be 1-2 sentences and at most roughly 200-300 characters. No bullet lists. One fact per memory — never chain multiple facts with semicolons/commas. Never paste raw code, CLI output, or a multi-paragraph narrative.

Classify (only meaningful when flag=true):
- type: preference | rule | fact | decision | task_learning | bug_fix | workflow. A correction is normally "rule", or "preference" for a taste-level redirect.
- scope rule: "global" only if the statement would genuinely help in ANY unrelated project (cross-project dev preferences, communication/output style, secret-handling rules, durable personal/identity facts), and "project" for everything else, including system/tool troubleshooting (dotfiles, window manager configs, app-specific bugs, OS-level fixes) even when it was not said inside a recognizable project. When ambiguous, prefer "project".

Be conservative: when genuinely unsure, prefer flag=false — a missed candidate falls back to the existing prompt-based reminder, a false alarm costs the main agent one wasted turn.

Output your FINAL answer as compact JSON only, no other prose before or after it: {"flag":true|false,"signal":"correction|preference|outcome|none","signal_subtype":"<subtype if signal=correction, else empty string>","text":"<distilled sentence if flag=true, else empty string>","type":"<type if flag=true, else empty string>","scope":"<scope if flag=true, else empty string>","rule_form":"<prohibition|preference|procedure|retract, empty string when not a rule-shaped candidate>","antecedent_source":"prose|trace|prior_tail|candidate|none","correction":{"agent_did":"","captain_verdict":"","redirect_target":""},"supersedes_query":"","reason":"<short reason, especially when flag=false>"}'

# KEEP IN SYNC with CLASSIFIER_SCHEMA / CORRECTION_SCHEMA in stop-extract.sh.
LEGACY_SCHEMA='{"type":"object","properties":{"flag":{"type":"boolean"},"text":{"type":"string"},"type":{"type":"string"},"scope":{"type":"string"},"reason":{"type":"string"}},"required":["flag","text","type","scope","reason"],"additionalProperties":false}'
CORRECTION_SCHEMA='{"type":"object","properties":{"flag":{"type":"boolean"},"signal":{"type":"string"},"signal_subtype":{"type":"string"},"text":{"type":"string"},"type":{"type":"string"},"scope":{"type":"string"},"rule_form":{"type":"string"},"antecedent_source":{"type":"string"},"correction":{"type":"object","properties":{"agent_did":{"type":"string"},"captain_verdict":{"type":"string"},"redirect_target":{"type":"string"}},"required":["agent_did","captain_verdict","redirect_target"],"additionalProperties":false},"supersedes_query":{"type":"string"},"reason":{"type":"string"}},"required":["flag","signal","signal_subtype","text","type","scope","rule_form","antecedent_source","correction","supersedes_query","reason"],"additionalProperties":false}'

if [ "$CORRECTION_MODE" = "0" ]; then
  SYSTEM_PROMPT="$LEGACY_SYSTEM_PROMPT"
  SCHEMA="$LEGACY_SCHEMA"
else
  SYSTEM_PROMPT="$CORRECTION_SYSTEM_PROMPT"
  SCHEMA="$CORRECTION_SCHEMA"
fi

# The model never emits importance (plan §6.1) — it is derived server-side from signal/subtype.
# expectMinImportance/expectMaxImportance are therefore checked against the real derivation,
# imported straight from src/services/candidateDecision.ts rather than reimplemented here.
derived_importance() {
  (cd "$ROOT" && node --experimental-strip-types --no-warnings -e '
const [signal, subtype, kind] = process.argv.slice(1);
const { importanceForSignal } = await import("./src/services/candidateDecision.ts");
const derived = importanceForSignal(signal || undefined, subtype || undefined, kind || "fact");
console.log(derived == null ? 0.5 : derived);
' -- "$1" "$2" "$3" 2>/dev/null)
}

CASE_COUNT=$(jq 'length' "$FIXTURES")
for i in $(seq 0 $((CASE_COUNT - 1))); do
  CASE=$(jq -c ".[$i]" "$FIXTURES")
  NAME=$(echo "$CASE" | jq -r '.name')
  TEXT=$(echo "$CASE" | jq -r '.text')
  EXPECT_FLAG=$(echo "$CASE" | jq -r '.expectFlag')
  IS_CORRECTION=$(echo "$CASE" | jq -r '.correction // false')

  PROMPT=$(printf 'Delta:\n%s' "$TEXT")
  RESP=$(claude -p --safe-mode --tools "" --model "$CLASSIFIER_MODEL" --system-prompt "$SYSTEM_PROMPT" --json-schema "$SCHEMA" "$PROMPT" 2>/dev/null)
  JSON=$(echo "$RESP" | sed -E '/^```/d')

  if ! echo "$JSON" | jq -e . >/dev/null 2>&1; then
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: response did not parse as JSON: $RESP")
    continue
  fi

  FLAG=$(echo "$JSON" | jq -r '.flag // false')
  ACTUAL_SIGNAL=$(echo "$JSON" | jq -r '.signal // ""')
  CASE_FAILURES=()
  if [ "$FLAG" != "$EXPECT_FLAG" ]; then
    CASE_FAILURES+=("expected flag=$EXPECT_FLAG, got flag=$FLAG")
  fi

  # Detection accounting: a correction is "detected" when it is both flagged and typed as one.
  DETECTED_CORRECTION=false
  [ "$FLAG" = "true" ] && [ "$ACTUAL_SIGNAL" = "correction" ] && DETECTED_CORRECTION=true
  if [ "$IS_CORRECTION" = "true" ]; then
    CORRECTION_TOTAL=$((CORRECTION_TOTAL + 1))
    [ "$DETECTED_CORRECTION" = "true" ] && CORRECTION_TP=$((CORRECTION_TP + 1))
  elif [ "$DETECTED_CORRECTION" = "true" ]; then
    CORRECTION_FP=$((CORRECTION_FP + 1))
  fi

  if [ "$EXPECT_FLAG" = "true" ] && [ "$FLAG" = "true" ]; then
    ACTUAL_TEXT=$(echo "$JSON" | jq -r '.text // ""')
    ACTUAL_TYPE=$(echo "$JSON" | jq -r '.type // ""')
    ACTUAL_SCOPE=$(echo "$JSON" | jq -r '.scope // ""')
    ACTUAL_SUBTYPE=$(echo "$JSON" | jq -r '.signal_subtype // ""')
    ACTUAL_RULE_FORM=$(echo "$JSON" | jq -r '.rule_form // ""')
    ACTUAL_ANTECEDENT=$(echo "$JSON" | jq -r '.antecedent_source // ""')
    ACTUAL_SUPERSEDES=$(echo "$JSON" | jq -r '.supersedes_query // ""')
    EXPECT_TYPE=$(echo "$CASE" | jq -r '.expectType // empty')
    EXPECT_SCOPE=$(echo "$CASE" | jq -r '.expectScope // empty')
    EXPECT_MAX_TEXT_LENGTH=$(echo "$CASE" | jq -r '.expectMaxTextLength // empty')
    EXPECT_SIGNAL=$(echo "$CASE" | jq -r '.expectSignal // empty')
    EXPECT_SUBTYPE=$(echo "$CASE" | jq -r '.expectSignalSubtype // empty')
    EXPECT_RULE_FORM=$(echo "$CASE" | jq -r '.expectRuleForm // empty')
    EXPECT_ANTECEDENT=$(echo "$CASE" | jq -r '.expectAntecedentSource // empty')
    EXPECT_MIN_IMPORTANCE=$(echo "$CASE" | jq -r '.expectMinImportance // empty')
    EXPECT_MAX_IMPORTANCE=$(echo "$CASE" | jq -r '.expectMaxImportance // empty')

    [ -n "$EXPECT_TYPE" ] && [ "$ACTUAL_TYPE" != "$EXPECT_TYPE" ] && CASE_FAILURES+=("expected type=$EXPECT_TYPE, got type=$ACTUAL_TYPE")
    [ -n "$EXPECT_SCOPE" ] && [ "$ACTUAL_SCOPE" != "$EXPECT_SCOPE" ] && CASE_FAILURES+=("expected scope=$EXPECT_SCOPE, got scope=$ACTUAL_SCOPE")
    [ -n "$EXPECT_MAX_TEXT_LENGTH" ] && [ "${#ACTUAL_TEXT}" -gt "$EXPECT_MAX_TEXT_LENGTH" ] && CASE_FAILURES+=("expected text length <= $EXPECT_MAX_TEXT_LENGTH, got ${#ACTUAL_TEXT}")
    while IFS= read -r NEEDLE; do
      [ -n "$NEEDLE" ] && [[ "$ACTUAL_TEXT" != *"$NEEDLE"* ]] && CASE_FAILURES+=("expected text to include '$NEEDLE'")
    done < <(echo "$CASE" | jq -r '.expectTextIncludes[]?')

    if [ "$CORRECTION_MODE" != "0" ]; then
      [ -n "$EXPECT_SIGNAL" ] && [ "$ACTUAL_SIGNAL" != "$EXPECT_SIGNAL" ] && CASE_FAILURES+=("expected signal=$EXPECT_SIGNAL, got signal=$ACTUAL_SIGNAL")
      [ -n "$EXPECT_SUBTYPE" ] && [ "$ACTUAL_SUBTYPE" != "$EXPECT_SUBTYPE" ] && CASE_FAILURES+=("expected signal_subtype=$EXPECT_SUBTYPE, got $ACTUAL_SUBTYPE")
      [ -n "$EXPECT_ANTECEDENT" ] && [ "$ACTUAL_ANTECEDENT" != "$EXPECT_ANTECEDENT" ] && CASE_FAILURES+=("expected antecedent_source=$EXPECT_ANTECEDENT, got $ACTUAL_ANTECEDENT")

      if [ -n "$EXPECT_RULE_FORM" ]; then
        RULE_FORM_TOTAL=$((RULE_FORM_TOTAL + 1))
        if [ "$ACTUAL_RULE_FORM" = "$EXPECT_RULE_FORM" ]; then
          RULE_FORM_HIT=$((RULE_FORM_HIT + 1))
        else
          CASE_FAILURES+=("expected rule_form=$EXPECT_RULE_FORM, got $ACTUAL_RULE_FORM")
        fi
      fi

      while IFS= read -r NEEDLE; do
        [ -n "$NEEDLE" ] && [[ "$ACTUAL_TEXT" != *"$NEEDLE"* ]] && CASE_FAILURES+=("expected rule text to include '$NEEDLE'")
      done < <(echo "$CASE" | jq -r '.expectRuleIncludes[]?')
      while IFS= read -r NEEDLE; do
        [ -n "$NEEDLE" ] && [[ "$ACTUAL_TEXT" == *"$NEEDLE"* ]] && CASE_FAILURES+=("expected rule text NOT to include '$NEEDLE'")
      done < <(echo "$CASE" | jq -r '.expectRuleExcludes[]?')

      SUPERSEDES_NEEDLES=$(echo "$CASE" | jq -r '.expectSupersedesQueryIncludes[]?')
      if [ -n "$SUPERSEDES_NEEDLES" ]; then
        SUPERSEDES_TOTAL=$((SUPERSEDES_TOTAL + 1))
        SUPERSEDES_OK=true
        while IFS= read -r NEEDLE; do
          [ -n "$NEEDLE" ] && [[ "$ACTUAL_SUPERSEDES" != *"$NEEDLE"* ]] && SUPERSEDES_OK=false && CASE_FAILURES+=("expected supersedes_query to include '$NEEDLE', got '$ACTUAL_SUPERSEDES'")
        done < <(echo "$SUPERSEDES_NEEDLES")
        [ "$SUPERSEDES_OK" = "true" ] && SUPERSEDES_HIT=$((SUPERSEDES_HIT + 1))
      fi

      if [ -n "$EXPECT_MIN_IMPORTANCE" ] || [ -n "$EXPECT_MAX_IMPORTANCE" ]; then
        DERIVED=$(derived_importance "$ACTUAL_SIGNAL" "$ACTUAL_SUBTYPE" "$ACTUAL_TYPE")
        [ -z "$DERIVED" ] && DERIVED=0.5
        if [ -n "$EXPECT_MIN_IMPORTANCE" ] && [ "$(echo "$DERIVED < $EXPECT_MIN_IMPORTANCE" | bc -l)" = "1" ]; then
          CASE_FAILURES+=("expected derived importance >= $EXPECT_MIN_IMPORTANCE, got $DERIVED (signal=$ACTUAL_SIGNAL subtype=$ACTUAL_SUBTYPE)")
        fi
        if [ -n "$EXPECT_MAX_IMPORTANCE" ] && [ "$(echo "$DERIVED > $EXPECT_MAX_IMPORTANCE" | bc -l)" = "1" ]; then
          CASE_FAILURES+=("expected derived importance <= $EXPECT_MAX_IMPORTANCE, got $DERIVED (signal=$ACTUAL_SIGNAL subtype=$ACTUAL_SUBTYPE)")
        fi
      fi
    fi
  fi

  # Temporal-attribution and competition scoring: a case counts as a hit only when every one of
  # its assertions held, which is exactly "this case passed".
  CASE_OK=false
  [ "${#CASE_FAILURES[@]}" -eq 0 ] && CASE_OK=true
  if [ "$(echo "$CASE" | jq -r '.temporal // false')" = "true" ]; then
    TEMPORAL_TOTAL=$((TEMPORAL_TOTAL + 1))
    [ "$CASE_OK" = "true" ] && TEMPORAL_HIT=$((TEMPORAL_HIT + 1))
  fi
  if [ "$(echo "$CASE" | jq -r '.competition // false')" = "true" ]; then
    COMPETITION_TOTAL=$((COMPETITION_TOTAL + 1))
    [ "$CASE_OK" = "true" ] && COMPETITION_HIT=$((COMPETITION_HIT + 1))
  fi

  if [ "$CASE_OK" = "true" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    FAILURES+=("$NAME: $(IFS='; '; echo "${CASE_FAILURES[*]}") (resp: $JSON)")
  fi
done

pct() {
  # pct HIT TOTAL -> integer percent, 100 when TOTAL is 0 (nothing to fail).
  [ "$2" -eq 0 ] && echo 100 && return 0
  echo $(( $1 * 100 / $2 ))
}

RECALL_PCT=$(pct "$CORRECTION_TP" "$CORRECTION_TOTAL")
PRECISION_DENOM=$((CORRECTION_TP + CORRECTION_FP))
PRECISION_PCT=$(pct "$CORRECTION_TP" "$PRECISION_DENOM")

echo "classifier eval: ${PASS}/${CASE_COUNT} passed"
echo "correction detection: precision=${PRECISION_PCT}% (${CORRECTION_TP}/${PRECISION_DENOM})  recall=${RECALL_PCT}% (${CORRECTION_TP}/${CORRECTION_TOTAL})"
echo "rule-form accuracy: ${RULE_FORM_HIT}/${RULE_FORM_TOTAL}   supersedes-query hit: ${SUPERSEDES_HIT}/${SUPERSEDES_TOTAL}"
echo "temporal attribution: ${TEMPORAL_HIT}/${TEMPORAL_TOTAL}   competition (correction beats outcome): ${COMPETITION_HIT}/${COMPETITION_TOTAL}"

if [ "$CORRECTION_MODE" != "0" ]; then
  if [ "$RECALL_PCT" -lt "$MIN_CORRECTION_RECALL_PCT" ]; then
    FAIL=$((FAIL + 1))
    FAILURES+=("gate: correction recall ${RECALL_PCT}% < ${MIN_CORRECTION_RECALL_PCT}%")
  fi
  if [ "$PRECISION_PCT" -lt "$MIN_CORRECTION_PRECISION_PCT" ]; then
    FAIL=$((FAIL + 1))
    FAILURES+=("gate: correction precision ${PRECISION_PCT}% < ${MIN_CORRECTION_PRECISION_PCT}%")
  fi
  if [ "$TEMPORAL_HIT" -lt "$TEMPORAL_TOTAL" ]; then
    FAIL=$((FAIL + 1))
    FAILURES+=("gate: temporal attribution ${TEMPORAL_HIT}/${TEMPORAL_TOTAL}, all are required")
  fi
  if [ "$COMPETITION_HIT" -lt "$COMPETITION_TOTAL" ]; then
    FAIL=$((FAIL + 1))
    FAILURES+=("gate: competition ${COMPETITION_HIT}/${COMPETITION_TOTAL}, all are required")
  fi
fi

if [ "$FAIL" -gt 0 ]; then
  echo "fail:"
  for f in "${FAILURES[@]}"; do
    echo "- $f"
  done
  exit 1
fi
