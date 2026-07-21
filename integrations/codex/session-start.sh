#!/usr/bin/env bash
# Hook: SessionStart (Codex)
#
# Injects Asaki Memory status banner and instructions into Codex's session
# context. Fires on startup, resume, and compact.
set -uo pipefail

INPUT=$(cat)
SOURCE=$(echo "$INPUT" | jq -r '.source // "startup"' 2>/dev/null || echo "startup")
CWD=$(echo "$INPUT" | jq -r '.cwd // ""' 2>/dev/null || echo "")

ASAKI_BASE="${ASAKI_MEMORY_BASE_URL:-${ASAKI_MEMORY_API_URL:-https://asaki-memory-manager.YOUR_SUBDOMAIN.workers.dev}}"
ASAKI_USER="${ASAKI_MEMORY_USER_ID:-asaki}"

if [ -n "${ASAKI_MEMORY_PROJECT_ID:-}" ]; then
  ASAKI_PROJECT="$ASAKI_MEMORY_PROJECT_ID"
elif [ -n "$CWD" ]; then
  ASAKI_PROJECT=$(cd "$CWD" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null | xargs basename 2>/dev/null || basename "$CWD")
else
  ASAKI_PROJECT="unknown"
fi

if [ -z "${ASAKI_MEMORY_API_KEY:-}" ]; then
  cat <<BANNER
## Asaki Memory — Setup Required

\`user=${ASAKI_USER} | project=${ASAKI_PROJECT} | auth=none\`

\`ASAKI_MEMORY_API_KEY\` is not set. Add it to \`[mcp_servers.asaki-memory.env]\` in \`~/.codex/config.toml\`,
or create \`~/.codex/asaki-memory.json\` with \`{ "apiKey": "your-key" }\`.
BANNER
  exit 0
fi

MEMORY_COUNT="?"
if command -v curl >/dev/null 2>&1; then
  _RESP=$(curl -sf --max-time 4 -X POST "${ASAKI_BASE}/v1/memories/list" \
    -H "Authorization: Bearer ${ASAKI_MEMORY_API_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"user_id\":\"${ASAKI_USER}\",\"project_id\":\"${ASAKI_PROJECT}\",\"limit\":1}" 2>/dev/null || echo "")
  if [ -n "$_RESP" ]; then
    MEMORY_COUNT=$(echo "$_RESP" | python3 -c \
      "import sys,json; d=json.load(sys.stdin); print(d.get('total', len(d.get('memories',[]))))" \
      2>/dev/null || echo "?")
  fi
fi

cat <<BANNER
## Asaki Memory Active

Open your first reply with: \`Asaki Memory Active | user=${ASAKI_USER} | project=${ASAKI_PROJECT} | memories=${MEMORY_COUNT}\`

Always include \`user_id: "${ASAKI_USER}"\` in every \`asaki_memory_search\` and \`asaki_memory_add\` call.

You are the primary reviewed writer for durable memory. Cloud/server extraction is deprecated; background classifier candidates require human review and never auto-activate. Record deliberately, not more. Before calling \`asaki_memory_add\`, check ALL of:
1. Durable: a stated preference, a made decision, a completed bug fix/task outcome, an established rule/convention, or an explicit forget/retract request — not a question, chit-chat, a one-off command, or something with no future value.
2. Actually happened: a completed fact, not a proposed plan, an open "should we do X? I'd recommend X" deliberation, or a present-tense explanation of how something works (a past-tense "we changed X, verified it works" DOES qualify).
3. Not noise: skip illustrative/hypothetical examples and quoted code/CLI output; when a problem and its fix both appear in the same exchange, record only the resolved outcome, not the problem report too.
4. Not a duplicate or stale-making: \`asaki_memory_search\` first — update/skip a near-duplicate, and separately, if what you just did makes an OLDER, differently-worded memory factually wrong (e.g. you just disabled a mechanism an old memory still describes as active), update that old memory too — don't just leave it to rot next to the new one.
5. Right scope: \`global\` only if useful in ANY unrelated project (cross-project preferences, communication style, secret-handling rules). Everything else, including project-specific tooling/bugs AND product/business decisions (a metric definition, a customer-facing feature) — even ones that feel foundational — is \`project\`. Importance and scope are independent; a high-stakes decision is not automatically global. When genuinely ambiguous, default to \`project\` — rescoping later is cheap, a wrongly-global memory pollutes every future project's context immediately.
6. Self-contained: no pronoun or bare reference (this/that/该/这个/主公) whose target isn't named in the same sentence — a reader with zero conversation context must be able to understand it standing alone.

If nothing in the exchange clears this bar, call nothing — silence is a correct outcome, not a shortfall. Keep each memory concise: preference/rule should be roughly 40-160 chars; decision/workflow/bug_fix/task_learning should be 1-2 sentences and at most roughly 200-300 chars. Summarize the durable takeaway only — never paste multi-paragraph implementation logs, changelogs, or step-by-step narratives.
BANNER

if [ "$SOURCE" = "startup" ]; then
  echo "Asaki memory precheck: decide whether durable memory is needed for this turn. Call \`asaki_memory_search\` only when the answer or next action depends on remembered preferences, prior project decisions, conventions, task learnings, or explicitly requested past context. Simple questions, direct file edits, commands, formatting, explanations, and self-contained coding tasks should skip \`asaki_memory_search\`."
elif [ "$SOURCE" = "resume" ] || [ "$SOURCE" = "compact" ]; then
  echo "Session ${SOURCE}. Search Asaki memory for recent session state and decisions to recover context."
fi

exit 0
