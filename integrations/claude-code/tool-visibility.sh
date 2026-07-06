#!/usr/bin/env bash
# PostToolUse hook: surface memory-related (and other watched) tool calls in the TUI via systemMessage
set -uo pipefail

input=$(cat)
tool_name=$(echo "$input" | jq -r '.tool_name // empty')

trunc() { echo "$1" | cut -c1-80; }

# Match by tool-name suffix, not a fixed "mcp__<server>__" prefix — the prefix Claude Code
# generates for plugin-bundled MCP servers (e.g. "mcp__plugin_asaki-memory_asaki-memory__...")
# differs from a directly-registered server ("mcp__asaki-memory__..."), and has changed before.
case "$tool_name" in
  *asaki_memory_search)
    query=$(echo "$input" | jq -r '.tool_input.query // empty')
    msg="🧠 Asaki memory search: \"$(trunc "$query")\""
    ;;
  *asaki_memory_add)
    text=$(echo "$input" | jq -r '.tool_input.text // empty')
    msg="🧠 Asaki memory add: \"$(trunc "$text")\""
    ;;
  *asaki_memory_extract)
    text=$(echo "$input" | jq -r '.tool_input.text // empty')
    msg="🧠 Asaki memory extract: \"$(trunc "$text")\""
    ;;
  *asaki_memory_update)
    id=$(echo "$input" | jq -r '.tool_input.id // empty')
    msg="🧠 Asaki memory update: id=$id"
    ;;
  *asaki_memory_delete)
    id=$(echo "$input" | jq -r '.tool_input.id // empty')
    msg="🧠 Asaki memory delete: id=$id"
    ;;
  *asaki_memory_list)
    msg="🧠 Asaki memory list"
    ;;
  *asaki_memory_review_create|*asaki_memory_review_list|*asaki_memory_review_resolve)
    msg="🧠 Asaki memory: $tool_name"
    ;;
  *)
    exit 0
    ;;
esac

jq -cn --arg msg "$msg" '{systemMessage: $msg}'
