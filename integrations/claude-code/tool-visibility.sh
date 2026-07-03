#!/usr/bin/env bash
# PostToolUse hook: surface memory-related (and other watched) tool calls in the TUI via systemMessage
set -uo pipefail

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty')

trunc() { echo "$1" | cut -c1-80; }

case "$tool_name" in
  mcp__asaki-memory__asaki_memory_search)
    query=$(echo "$input" | jq -r '.tool_input.query // empty')
    msg="🧠 Asaki memory search: \"$(trunc "$query")\""
    ;;
  mcp__asaki-memory__asaki_memory_add)
    text=$(echo "$input" | jq -r '.tool_input.text // empty')
    msg="🧠 Asaki memory add: \"$(trunc "$text")\""
    ;;
  mcp__asaki-memory__asaki_memory_update)
    id=$(echo "$input" | jq -r '.tool_input.id // empty')
    msg="🧠 Asaki memory update: id=$id"
    ;;
  mcp__asaki-memory__asaki_memory_delete)
    id=$(echo "$input" | jq -r '.tool_input.id // empty')
    msg="🧠 Asaki memory delete: id=$id"
    ;;
  mcp__asaki-memory__asaki_memory_list)
    msg="🧠 Asaki memory list"
    ;;
  mcp__asaki-memory__asaki_memory_review_create|mcp__asaki-memory__asaki_memory_review_list|mcp__asaki-memory__asaki_memory_review_resolve)
    msg="🧠 Asaki memory: $tool_name"
    ;;
  *)
    exit 0
    ;;
esac

jq -cn --arg msg "$msg" '{systemMessage: $msg}'
