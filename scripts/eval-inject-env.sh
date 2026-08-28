#!/usr/bin/env bash
# Offline eval for the injection knobs' numeric env parsing.
#
# One parameterized table, three copies of the same contract:
#   - asaki_parse_positive_int / asaki_parse_unit_score in integrations/claude-code/user-prompt.sh
#   - asaki_parse_positive_int in integrations/claude-code/session-start.sh
#   - parsePositiveIntEnv / parseUnitScoreEnv in integrations/pi/asaki-memory.ts (run through
#     scripts/eval-inject-env.mjs, which loads the shipped `// #region asaki-env-parse` block)
#
# Both hooks are sourced as libraries (their *_LIB guards stop before any hook side effect), so
# nothing here reads stdin, calls curl, or writes anything.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
FAILURES=0
CHECKS=0

# Both hooks define a function of the same name, so each copy is renamed after sourcing and the
# original is dropped — that way the table really runs twice, once per shipped copy.
rename_fn() {
  eval "${2}() $(declare -f "$1" | tail -n +2)"
  unset -f "$1"
}

# shellcheck source=/dev/null
ASAKI_MEMORY_USER_PROMPT_LIB=1 . "$ROOT/integrations/claude-code/user-prompt.sh"
rename_fn asaki_parse_positive_int user_prompt_int
rename_fn asaki_parse_unit_score user_prompt_score

# shellcheck source=/dev/null
ASAKI_MEMORY_SESSION_START_LIB=1 . "$ROOT/integrations/claude-code/session-start.sh"
rename_fn asaki_parse_positive_int session_start_int

check() {
  local label="$1" expected="$2" actual="$3"
  CHECKS=$((CHECKS + 1))
  if [ "$actual" != "$expected" ]; then
    echo "- FAIL ${label}: expected '${expected}', got '${actual}'"
    FAILURES=$((FAILURES + 1))
  fi
}

# The four (default, cap) pairs the two hooks actually use.
TOPK="6 20"
DIGEST_MAX="10 50"
DIGEST_MAX_CHARS="6000 20000"
DIGEST_CONTENT_CHARS="240 2000"
HUGE="999999999999999999999999999999999999999999"

# raw | top_k(6,20) | digestMax(10,50) | maxChars(6000,20000) | contentChars(240,2000)
INT_TABLE=(
  "8|8|8|8|8"
  "99|20|50|99|99"
  "0|6|10|6000|240"
  "-1|6|10|6000|240"
  "abc|6|10|6000|240"
  "8junk|6|10|6000|240"
  "1.5|6|10|6000|240"
  ".|6|10|6000|240"
  "1.2.3|6|10|6000|240"
  "|6|10|6000|240"
  "   |6|10|6000|240"
  "007|7|7|7|7"
  "000|6|10|6000|240"
  " 12 |12|12|12|12"
  "20|20|20|20|20"
  "21|20|21|21|21"
  "50|20|50|50|50"
  "51|20|50|51|51"
  "20000|20|50|20000|2000"
  "20001|20|50|20000|2000"
  "${HUGE}|20|50|20000|2000"
)

for row in "${INT_TABLE[@]}"; do
  IFS='|' read -r raw exp_topk exp_max exp_chars exp_content <<<"$row"
  for side in user_prompt session_start; do
    # shellcheck disable=SC2086
    check "${side} int topK raw='${raw}'" "$exp_topk" "$(${side}_int "$raw" $TOPK)"
    # shellcheck disable=SC2086
    check "${side} int digestMax raw='${raw}'" "$exp_max" "$(${side}_int "$raw" $DIGEST_MAX)"
    # shellcheck disable=SC2086
    check "${side} int maxChars raw='${raw}'" "$exp_chars" "$(${side}_int "$raw" $DIGEST_MAX_CHARS)"
    # shellcheck disable=SC2086
    check "${side} int contentChars raw='${raw}'" "$exp_content" "$(${side}_int "$raw" $DIGEST_CONTENT_CHARS)"
  done
done

# min_score: only a finite decimal in [0,1], normalized to valid JSON. Anything else falls back.
SCORE_TABLE=(
  "0|0"
  "1|1"
  "0.67|0.67"
  ".67|0.67"
  "1.0|1.0"
  "0.0|0.0"
  "00.5|0.5"
  " 0.8 |0.8"
  "-0.1|0.67"
  "1.1|0.67"
  "2|0.67"
  "abc|0.67"
  "|0.67"
  "   |0.67"
  "Infinity|0.67"
  ".|0.67"
  "1.2.3|0.67"
  "0.67x|0.67"
)

for row in "${SCORE_TABLE[@]}"; do
  IFS='|' read -r raw expected <<<"$row"
  check "user_prompt score raw='${raw}'" "$expected" "$(user_prompt_score "$raw" 0.67)"
done

# Every accepted min_score must be valid JSON for `jq --argjson` (this is what silently killed
# auto-inject before: `.67` and `1.2.3` reached jq and it exited non-zero).
for row in "${SCORE_TABLE[@]}"; do
  IFS='|' read -r raw _ <<<"$row"
  value=$(user_prompt_score "$raw" 0.67)
  if ! jq -cn --argjson v "$value" '$v' >/dev/null 2>&1; then
    echo "- FAIL user_prompt score raw='${raw}': '${value}' is not valid JSON for --argjson"
    FAILURES=$((FAILURES + 1))
  fi
  CHECKS=$((CHECKS + 1))
done

# Same for the integer parser, including the huge input that must never reach bash `-gt`/jq raw.
for row in "${INT_TABLE[@]}"; do
  IFS='|' read -r raw _ <<<"$row"
  # shellcheck disable=SC2086
  value=$(user_prompt_int "$raw" $TOPK)
  if ! jq -cn --argjson v "$value" 'if ($v | type) == "number" and $v >= 1 and $v <= 20 then . else error("out of range") end' >/dev/null 2>&1; then
    echo "- FAIL user_prompt int raw='${raw}': '${value}' is not a valid 1..20 JSON number"
    FAILURES=$((FAILURES + 1))
  fi
  CHECKS=$((CHECKS + 1))
done

# The Pi copy of the same contract, driven by the same table.
if ! node --experimental-strip-types "$ROOT/scripts/eval-inject-env.mjs"; then
  FAILURES=$((FAILURES + 1))
fi

echo "inject-env eval: ${CHECKS} bash checks, ${FAILURES} failure(s)"
[ "$FAILURES" -eq 0 ] || exit 1
