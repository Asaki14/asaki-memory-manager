#!/usr/bin/env bash
# Hook: UserPromptSubmit
#
# Stably injects one instruction on every turn: the agent itself analyzes
# user intent and decides whether asaki_memory_search is needed, and if so,
# picks its own query/scope/top_k. No keyword regex, no scripted API calls
# here — mirrors the Pi extension's memoryPrecheckInstruction(), which is
# appended to the system prompt unconditionally on every turn.
set -uo pipefail

cat >/dev/null # drain stdin (hook input JSON; unused, no per-prompt branching)

jq -cn '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: "Asaki memory precheck: analyze the user'\''s intent for this turn and decide for yourself whether durable memory is relevant. Skip asaki_memory_search for simple, standalone, self-contained tasks. Call it when the answer or next action depends on remembered preferences, prior decisions, conventions, task learnings, or explicitly requested past context — choosing your own query wording, scope, and top_k. If the user asks you to remember/store something, or you just completed meaningful work worth keeping, decide for yourself whether to call asaki_memory_add."
  }
}'
